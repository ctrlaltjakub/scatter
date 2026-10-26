import type { ChatImageInput, ProviderConversationMessage } from '@/providers/types';
import { checkFinishReason, GenerationResponseError, parseResponseJson } from './generationValidation';
import { runInteractiveHarness, InteractiveVerificationError, type InteractiveStep } from './interactiveHarness';
import { validInteractiveActions, validInteractiveAssertions, type InteractiveCheck, type InteractiveProbeOptions, type InteractiveScenario, type InteractiveTestAction } from './interactiveTests';
import { boundedReferencedAnswer } from './chat/context';
import { DEFAULT_PROMPTS } from './promptDefaults';

export interface InteractivePlan {
  purpose: string;
  layout: string;
  assumptions: string[];
  scenarios: InteractiveScenario[];
}

export function parseInteractivePlan(text: string): InteractivePlan {
  const plan = parseResponseJson(text);
  const short = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= limit;
  const invalid = (reason: string): never => { throw new GenerationResponseError('invalid_structure', `Invalid interactive plan: ${reason}`,
    'Retry once, reset the interactive planning prompt, or choose a model with more reliable structured output.'); };
  if (!short(plan.purpose, 1200)) invalid('purpose must be a nonempty string of at most 1,200 characters.');
  if (!short(plan.layout, 2000)) invalid('layout must be a nonempty string of at most 2,000 characters.');
  if (!Array.isArray(plan.assumptions) || plan.assumptions.length > 8 || !plan.assumptions.every(a => short(a, 500))) invalid('assumptions must be an array of at most eight short strings.');
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length < 4 || plan.scenarios.length > 6) invalid('provide four to six outcome scenarios.');
  for (const scenario of plan.scenarios as InteractiveScenario[]) {
    if (!scenario || !short(scenario.name, 100)) invalid('each scenario needs a short name.');
    if (!['initial', 'normal', 'boundary', 'reset'].includes(scenario.kind)) invalid(`${scenario.name}: unknown scenario kind.`);
    if (!validInteractiveActions(scenario.actions)) invalid(`${scenario.name}: use at most six valid click/input/press actions; input values and keys must be strings.`);
    if (!validInteractiveAssertions(scenario.assertions)) invalid(`${scenario.name}: provide one to eight valid assertions with selector, property, operator, and expected value.`);
    if (scenario.kind === 'initial' && scenario.actions.length) invalid(`${scenario.name}: initial-state tests must have no actions.`);
    if (scenario.kind !== 'initial' && !scenario.actions.length) invalid(`${scenario.name}: this scenario must exercise a control.`);
    if (scenario.kind === 'reset' && scenario.actions.length < 2) invalid(`${scenario.name}: change state before resetting; include at least two actions.`);
    if (scenario.kind === 'normal' && !scenario.assertions.some(a => ['text', 'value', 'checked'].includes(a.property))) invalid(`${scenario.name}: test a meaningful text/value/checked result, not only visibility or element counts.`);
  }
  if (!['initial', 'normal', 'boundary', 'reset'].every(kind => (plan.scenarios as InteractiveScenario[]).some(s => s.kind === kind))) invalid('include initial, normal, boundary, and reset scenarios.');
  return plan as unknown as InteractivePlan;
}

export function parseInteractiveReview(text: string): { ok: boolean; summary: string; issues: string[]; warnings: string[] } {
  const review = parseResponseJson(text);
  const warnings = review.warnings ?? [];
  if (typeof review.ok !== 'boolean' || typeof review.summary !== 'string' || !review.summary.trim() || review.summary.length > 1500
    || !Array.isArray(review.issues) || review.issues.length > 8
    || !review.issues.every(issue => typeof issue === 'string' && issue.trim() && issue.length <= 1000)
    || !Array.isArray(warnings) || warnings.length > 8
    || !warnings.every(warning => typeof warning === 'string' && warning.trim() && warning.length <= 1000)
    || review.ok !== (review.issues.length === 0)) {
    throw new GenerationResponseError('invalid_structure', 'The screenshot reviewer returned an invalid verdict.',
      'Retry once, reset the interactive review prompt, or select a model with vision and reliable structured output.');
  }
  return { ok: review.ok, summary: review.summary, issues: review.issues as string[], warnings: warnings as string[] };
}

/** Preserve the full source when practical, otherwise include its introduction
 * and request-relevant passages instead of blindly cutting off the tail. */
export function interactiveSourceContext(header: string, body: string, request: string): string {
  const result = boundedReferencedAnswer(body, request, 40_000);
  return `${header}\n${result.text}${result.excerpted ? '\n[Source excerpted: introduction and request-relevant passages; do not invent omitted facts.]' : ''}`;
}

type HarnessOptions = Parameters<typeof runInteractiveHarness>[0];
export type InteractiveWorkflowOptions = Omit<HarnessOptions, 'finalCheck'> & {
  planPrompt: string;
  reviewPrompt: string;
  reviewRetryPrompt?: string;
  acceptedPlan?: InteractivePlan;
  onPlan?: (plan: InteractivePlan) => void;
  onWarnings?: (warnings: string[]) => void;
  verify: (html: string, actions: InteractiveTestAction[], options: InteractiveProbeOptions) => Promise<InteractiveCheck>;
};

/** Plan once → code → deterministic outcome tests → fresh screenshot review.
 * Repairs retain the original acceptance criteria; the coding model cannot
 * weaken its own tests to make a broken program pass. */
export async function runInteractiveWorkflow(options: InteractiveWorkflowOptions): Promise<string> {
  let id = 0;
  const checkpoint = () => { if (options.signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
  const stage = async <T>(label: string, run: (progress: (detail: string) => void) => Promise<T>, failure?: (value: T) => string | undefined): Promise<T> => {
    checkpoint();
    let step: InteractiveStep = { id: ++id, label, state: 'running' };
    options.onStep(step);
    try {
      const value = await run(detail => { if (detail !== step.detail) { step = { ...step, detail }; options.onStep(step); } });
      checkpoint();
      const detail = failure?.(value);
      options.onStep({ ...step, state: detail ? 'failed' : 'complete', ...(detail ? { detail: detail.slice(0, 1500) } : {}) }); return value;
    } catch (error) { options.onStep({ ...step, state: 'failed', detail: (error as Error).message.slice(0, 1000) }); throw error; }
  };
  const complete = async (messages: ProviderConversationMessage[], progress: (detail: string) => void) => {
    let text = ''; let done = false;
    for await (const chunk of options.invoke(messages, [], activity => progress(activity.phase === 'reasoning' ? 'Reasoning' : activity.phase === 'waiting' ? 'Waiting for provider' : 'Receiving response'))) {
      checkpoint(); checkFinishReason(chunk.finishReason, 'interactive');
      if (chunk.toolCalls?.length) throw new GenerationResponseError('tool_call', 'This planning or review step requires JSON, not a tool call.', 'Retry or reset the interactive prompts.');
      text += chunk.delta;
      if (text.length > 30_000) throw new GenerationResponseError('invalid_structure', 'The interactive plan or review is too long.', 'Use the default concise planning and review prompts.');
      if (chunk.done) { done = true; break; }
    }
    if (!done) throw new GenerationResponseError('interrupted', 'The planning or review stream stopped before completion.', 'Check the connection and retry.');
    return text;
  };
  const planningMessages: ProviderConversationMessage[] = [...options.messages,
    ...(options.initialHtml ? [{ role: 'user' as const, content: 'Current program to preserve and modify:\n' + options.initialHtml }] : []),
    { role: 'user', content: options.planPrompt }];
  let plan: InteractivePlan;
  let planResponse = '';
  if (options.acceptedPlan) {
    plan = await stage('Reusing saved plan and outcome tests', async () => parseInteractivePlan(JSON.stringify(options.acceptedPlan)));
  } else try {
    plan = await stage('Planning layout, interactions and outcome tests', async progress => {
      planResponse = await complete(planningMessages, progress);
      return parseInteractivePlan(planResponse);
    });
  } catch (error) {
    // One format correction, not an unbounded planning loop. Explicit
    // capability diagnostics still test the first response without retries.
    if (options.failFast || !(error instanceof GenerationResponseError)
      || !['invalid_json', 'invalid_structure'].includes(error.code)) throw error;
    plan = await stage('Correcting the plan format · one retry', async progress => parseInteractivePlan(await complete([
      ...planningMessages, { role: 'assistant', content: planResponse },
      { role: 'user', content: `The plan failed validation: ${error.message}\nReturn the corrected complete JSON plan, not code. Keep the intended design and meaningful expected outcomes. Include every required scenario kind literally: initial, normal, boundary, reset. Reset must change state before resetting (at least two actions).` },
    ], progress)));
  }
  options.onPlan?.(plan);
  const planText = JSON.stringify(plan);
  const baseMessages: ProviderConversationMessage[] = [...options.messages,
    { role: 'user', content: 'Implement this accepted design and its fixed outcome tests. Use the exact selectors and expected results below. Expose meaningful accessible readouts for Canvas/SVG state. Do not modify the tests.\n' + planText }];
  const ids = new Map<number, number>();
  let attempts = 0;
  const finalCheck = async (html: string): Promise<InteractiveCheck> => {
    attempts++;
    if (attempts > 1) await stage(`Rechecking repaired program · pass ${attempts - 1}`, async () => undefined);
    const results: Array<{ name: string; kind: string; result: Omit<InteractiveCheck, 'screenshot'> }> = [];
    const images: ChatImageInput[] = [];
    for (const scenario of plan.scenarios) {
      const capture = (scenario.kind === 'initial' || scenario.kind === 'normal') && !images.some(image => image.id === scenario.kind);
      const result = await stage(`Testing ${scenario.kind} state${capture ? ' and capturing screenshot' : ''} · ${scenario.name}`, async () => {
        const result = await options.verify(html, scenario.actions, { assertions: scenario.assertions, screenshot: capture });
        checkpoint();
        // A genuine failed assertion is code feedback. A failed renderer is
        // not, and must never silently become a text-only visual review.
        if (capture && (result.captureError || !result.screenshot)) throw new InteractiveVerificationError(
          `Screenshot capture failed: ${result.captureError ?? 'no image returned'}. The draft is saved. Retry verification with this tab visible; no visual approval was assumed.`);
        return result;
      }, result => result.ok ? undefined : result.errors.join('\n'));
      if (capture && result.screenshot) {
        await stage(`Captured screenshot · ${scenario.kind} state`, async () => {
          images.push({ id: scenario.kind, url: result.screenshot!, detail: 'high' });
        });
      }
      const { screenshot: _screenshot, ...evidence } = result;
      results.push({ name: scenario.name, kind: scenario.kind, result: evidence });
    }
    const errors = results.flatMap(({ name, result }) => result.ok ? [] : result.errors.map(error => `${name}: ${error}`));
    if (errors.length) {
      await stage('Outcome checks failed · preparing repair feedback', async progress => progress(errors.join('\n').slice(0, 1500)));
      return { ok: false, errors };
    }
    const alternate = await stage('Checking alternate theme and capturing screenshot', async () => {
      const result = await options.verify(html, [], { assertions: plan.scenarios.find(s => s.kind === 'initial')!.assertions,
        screenshot: true, alternateTheme: true });
      checkpoint();
      if (result.captureError || !result.screenshot) throw new InteractiveVerificationError(
        `Alternate-theme screenshot capture failed: ${result.captureError ?? 'no image returned'}. The draft is saved. Retry verification with this tab visible; no visual approval was assumed.`);
      return result;
    }, result => result.ok ? undefined : result.errors.join('\n'));
    if (!alternate.ok) return { ok: false, errors: alternate.errors.map(error => `Alternate theme: ${error}`) };
    images.push({ id: 'alternate-theme', url: alternate.screenshot!, detail: 'high' });
    const { screenshot: _alternateScreenshot, ...alternateEvidence } = alternate;
    results.push({ name: 'Initial state in the alternate app theme', kind: 'initial', result: alternateEvidence });
    // Fresh context: no prior self-approval, tool transcripts or reasoning.
    const reviewMessages: ProviderConversationMessage[] = [
      { role: 'system', content: options.reviewPrompt },
      { role: 'user', content: JSON.stringify({ request: options.messages.map(m => ({ role: m.role, content: m.content })),
        plan, observedTests: results, screenshotOrder: images.map(image => image.id), html }), images },
    ];
    const assess = (messages: ProviderConversationMessage[], label: string) => stage(label,
      async progress => parseInteractiveReview(await complete(messages, progress)), review => review.ok ? undefined : review.issues.join('\n'));
    let review: ReturnType<typeof parseInteractiveReview>;
    try {
      try { review = await assess(reviewMessages, 'Reviewing screenshots, behavior and request coverage'); }
      catch (error) {
        checkpoint();
        if (options.failFast || !(error instanceof GenerationResponseError)
          || !['invalid_json', 'invalid_structure'].includes(error.code)) throw error;
        // Do not extract a convenient "ok" fragment from invalid prose: the
        // reviewer may have claimed to fix defects without changing any code.
        // Ask for one new verdict on the same evidence, with no prior verdict.
        review = await assess([
          { role: 'system', content: options.reviewPrompt + '\n\n' + (options.reviewRetryPrompt ?? DEFAULT_PROMPTS.interactiveNodeReviewRetry) },
          reviewMessages[1]!,
        ], 'Correcting review format · one retry');
      }
    } catch (error) {
      checkpoint(); throw new InteractiveVerificationError(`Visual review could not complete: ${(error as Error).message} The program was not approved. Retry or select a model with reliable vision and structured responses.`, { cause: error });
    }
    options.onWarnings?.(review.warnings);
    if (review.warnings.length) await stage('Non-blocking review notes', async progress => progress(review.warnings.join('\n')));
    return { ok: review.ok, errors: review.issues, text: review.summary };
  };
  const html = await runInteractiveHarness({ ...options, messages: baseMessages, finalCheck,
    onStep: step => {
      if (!ids.has(step.id)) ids.set(step.id, ++id);
      options.onStep({ ...step, id: ids.get(step.id)! });
    } });
  await stage('Program passed outcome tests and screenshot review', async () => undefined);
  return html;
}
