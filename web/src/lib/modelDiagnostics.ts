import type { ModelRole, ProviderAccount, Settings } from '@/store/types';
import { prepareImageQuestion } from './imageRegionInput';
import type { ChatChunk, ModelInfo, ProviderConversationMessage, StreamChatOpts, TextToolDefinition } from '@/providers/types';
import { getAdapter, getImageAdapter, resolveBaseUrl } from '@/providers/registry';
import { isLocalSearchPreset, validSearchEndpoint, validServerSearch } from '@/providers/modelSearch';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { modelDiagnosticCases, assertDiagnostic, type ModelDiagnosticCase } from './modelDiagnosticsCases';
import { checkFinishReason, diagnosticError, GenerationResponseError, requireVisibleText } from './generationValidation';
import { mainOutputTokens, normalizeGenerationLimit, secondaryOutputTokens } from './generationLimits';
import { extractInlineCitations } from './citations';
import { runInteractiveWorkflow, type InteractivePlan } from './interactiveWorkflow';
import { interactiveTools } from './interactiveActions';
import { checkInteractiveDocument } from './interactiveProbe';
import { INTERACTIVE_TOOL_ARGUMENT_LIMITS, DEFAULT_INTERACTIVE_HOST_STATE } from './interactiveDocument';
import { resolveRequest } from './imageGeneration';
import { stringHash } from './stringHash';
import { providerDisabledReason } from '@/providers/providerPolicy';
import { languageInfo } from './languages';
import { effectivePrompt, substitute } from './promptDefaults';
import { resolveCaps } from './modelMeta';
import { interactiveAccentColors } from './interactiveColors';
import { FACT_CHECK_SEARCH_POLICY } from './factCheckRequest';
import { parseFactCheckFinding } from './factCheckCore';

export interface DiagnosticTarget { role: ModelRole; provider: ProviderAccount; model: string; info?: ModelInfo }
export interface DiagnosticJob { key: string; target: DiagnosticTarget; test: ModelDiagnosticCase }
export interface DiagnosticResult {
  key: string; role: ModelRole; model: string; provider: string; label: string;
  status: 'running' | 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'cancelled';
  detail: string; code?: string; milliseconds?: number;
}
export const DIAGNOSTIC_ROLE_LABELS: Record<ModelRole, string> = { main: 'Main model', secondary: 'Secondary tasks', interactive: 'Interactive nodes', image: 'Image generation' };
export function diagnosticSignature(settings: Settings): string {
  return String(stringHash(JSON.stringify([settings.providers, settings.activeModelRef, settings.secondaryModelRef,
    settings.secondaryUseSameModel, settings.interactiveModelRef, settings.imageModelRef, settings.reasoningEffort,
    settings.interactiveReasoningEffort, settings.outputTokenCap, settings.secondaryOutputTokenCap,
    settings.interactiveOutputTokenCap, settings.imageGenerationSettings, settings.customPrompts, settings.modelCompatibilityOverrides, settings.generationLanguage])));
}
export function diagnosticTargets(settings: Settings): DiagnosticTarget[] {
  const targets: DiagnosticTarget[] = [];
  const add = (role: ModelRole, ref: Settings['activeModelRef']) => {
    const provider = settings.providers.find(p => p.id === ref?.providerId);
    if (!provider || !ref) return;
    if (!targets.some(t => t.role === role && t.provider.id === provider.id && t.model === ref.model)) targets.push({
      role, provider, model: ref.model, info: useModelCatalogStore.getState().getModel(provider.id, ref.model),
    });
  };
  add('main', settings.activeModelRef);
  add('secondary', !settings.secondaryUseSameModel && settings.secondaryModelRef ? settings.secondaryModelRef : settings.activeModelRef);
  add('interactive', settings.interactiveModelRef ?? settings.activeModelRef);
  add('image', settings.imageModelRef ?? null);
  return targets;
}
export function diagnosticPlan(settings: Settings, role?: ModelRole): DiagnosticJob[] {
  const cases = modelDiagnosticCases(settings);
  return diagnosticTargets(settings).filter(t => !role || role === t.role).flatMap(target => cases.filter(test => test.role === target.role)
    .map(test => ({ key: `${target.role}:${target.provider.id}:${target.model}:${test.id}`, target, test })));
}

export function diagnosticImageFixture(): string {
  const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240;
  const c = canvas.getContext('2d'); if (!c) throw new Error('The browser could not create the image test fixture.');
  c.fillStyle = 'white'; c.fillRect(0, 0, 400, 240);
  c.fillStyle = 'red'; c.beginPath(); c.moveTo(80, 25); c.lineTo(25, 140); c.lineTo(135, 140); c.closePath(); c.fill();
  c.fillStyle = 'blue'; c.beginPath(); c.arc(290, 90, 55, 0, Math.PI * 2); c.fill();
  c.fillStyle = 'black'; c.font = '28px sans-serif'; c.fillText('Test code: ORBIT 27', 25, 210);
  return canvas.toDataURL('image/png');
}
const INITIAL_PROGRAM = '<!doctype html><html><head><title>Counter</title><style>body{background:var(--sc-bg);color:var(--sc-text);font-family:var(--sc-font-family)}button{background:var(--sc-primary);cursor:var(--sc-cursor-pointer)}</style></head><body><p id="count">0</p><button id="add">Add 1</button><script>let n=0;document.getElementById("add").onclick=()=>document.getElementById("count").textContent=String(++n);</script></body></html>';
const BROKEN_PROGRAM = INITIAL_PROGRAM.replace('<script>', '<button id="reset">Reset</button><script>')
  .replace('document.getElementById("count").textContent=String(++n);', '{n=Math.min(3,n+1)};document.getElementById("reset").onclick=()=>{n=0;document.getElementById("count").textContent="0"};');
const REPAIR_PLAN: InteractivePlan = {
  purpose: 'A counter from zero to three with reset.', layout: 'Preserve #count, #add and #reset.', assumptions: [],
  scenarios: [
    { kind: 'initial', name: 'Starts at zero', actions: [], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '0' }] },
    { kind: 'normal', name: 'Adds one', actions: [{ action: 'click', selector: '#add' }], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '1' }] },
    { kind: 'boundary', name: 'Stops at three', actions: Array.from({ length: 4 }, () => ({ action: 'click' as const, selector: '#add' })), assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '3' }] },
    { kind: 'reset', name: 'Resets changed state', actions: [{ action: 'click', selector: '#add' }, { action: 'click', selector: '#reset' }], assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: '0' }] },
  ],
};

async function collect(stream: AsyncIterable<ChatChunk>, role: Exclude<ModelRole, 'image'>) {
  let text = '', done = false, usedSearch = false; let searchError: string | undefined;
  let calls: NonNullable<ChatChunk['toolCalls']> = [], native: unknown[] | undefined;
  const citations: NonNullable<ChatChunk['citations']> = [];
  for await (const chunk of stream) {
    text += chunk.delta;
    if (text.length > 250_000) throw new GenerationResponseError('invalid_structure', 'The response exceeded the test’s safety size limit.', 'Simplify the prompt or lower the output limit.');
    checkFinishReason(chunk.finishReason, role);
    if (chunk.toolCalls) calls = chunk.toolCalls;
    if (chunk.providerResponse) native = chunk.providerResponse;
    if (chunk.citations) citations.push(...chunk.citations);
    usedSearch ||= chunk.webSearch?.used === true;
    searchError = chunk.webSearch?.error ?? searchError;
    if (chunk.done) { done = true; break; }
  }
  if (!done) throw new GenerationResponseError('interrupted', 'The model stream stopped without completing.', 'Check the connection and retry.');
  return { text, calls, native, usedSearch, searchError, citations };
}

/** One attempt per case. No provider retry, no graph mutation, no capability
 * overwrite. Tool-result continuations are part of the test, not retries. */
export async function runDiagnosticJob(job: DiagnosticJob, settings: Settings, signal: AbortSignal,
  fixture = diagnosticImageFixture(), invokeOverride?: (opts: StreamChatOpts) => AsyncIterable<ChatChunk>): Promise<Pick<DiagnosticResult, 'status' | 'detail'>> {
  const { target, test } = job, { provider, model } = target;
  const disabled = providerDisabledReason(provider.preset);
  if (disabled) return { status: 'skipped', detail: disabled };
  if (!provider.apiKey.trim()) return { status: 'skipped', detail: 'This connection has no API key or local server token. Add it in AI providers first.' };
  if ((test.kind === 'search' || test.kind === 'fact-check') && isLocalSearchPreset(provider.preset)
    && !(provider.serverSearch ? validServerSearch(provider.serverSearch) : validSearchEndpoint(provider.webSearchEndpoint))) {
    return { status: 'skipped', detail: 'Web search is not configured. Open AI providers → Local models and web search: setup guide.' };
  }
  if (target.role === 'image') {
    const adapter = getImageAdapter(provider.preset);
    if (!adapter) return { status: 'skipped', detail: 'Local image generation is not supported. Choose a supported image provider.' };
    const options = { ...resolveRequest({ providerId: provider.id, model }, settings), model, signal,
      prompt: (test.kind === 'image-edit' ? 'Change the blue circle to green. Preserve the red triangle and the text exactly.' : 'A simple educational diagram: one red triangle and one blue circle on white. No text.')
        + '\n\n' + substitute(effectivePrompt('imageGenerationLanguage', settings.customPrompts), { language: languageInfo(settings.generationLanguage).name }) };
    const image = test.kind === 'image-edit'
      ? await (async () => { if (!adapter.edit) throw new Error('This provider has no image-editing endpoint.');
        const source = await fetch(fixture).then(r => r.blob());
        return adapter.edit(provider.apiKey, { ...options, image: source }, resolveBaseUrl(provider.preset, provider.baseUrl)); })()
      : await adapter.generate(provider.apiKey, options, resolveBaseUrl(provider.preset, provider.baseUrl));
    assertDiagnostic(image.bytes.byteLength > 0 && image.mime.startsWith('image/'), 'The provider returned no image data.');
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.bytes)], { type: image.mime }));
    assertDiagnostic(bitmap.width > 0 && bitmap.height > 0, 'The returned image could not be decoded.'); bitmap.close();
    return { status: 'passed', detail: 'Received and decoded an image. This verifies the API path, not visual accuracy or edit fidelity.' };
  }
  const role = target.role;
  const outputTokens = role === 'secondary' ? secondaryOutputTokens(settings, test.tokens ?? 2000)
    : role === 'interactive' ? normalizeGenerationLimit('interactiveOutputTokenCap', settings.interactiveOutputTokenCap)
    : mainOutputTokens(settings.outputTokenCap, test.tokens);
  const imageInputs = test.kind !== 'vision' ? undefined : test.imageRegions
    ? (await prepareImageQuestion('model-diagnostic', { sourceMedia: { kind: 'image', source: 'link', url: fixture, mime: 'image/png' }, regions: test.imageRegions }, signal)).images
    : [{ id: 'fixture', url: fixture, detail: 'high' as const }];
  let requests = 0;
  const invoke = (overrides: Partial<StreamChatOpts> = {}) => {
    if (++requests > test.requests) throw new Error('The test reached its request limit. No automatic retry was made.');
    const options: StreamChatOpts = { model, modelInfo: target.info, messages: test.messages, signal,
      maxOutputTokens: outputTokens, webSearch: test.kind === 'search' || test.kind === 'fact-check', webSearchEndpoint: provider.webSearchEndpoint,
      serverSearch: provider.serverSearch, allowUnverifiedCapabilities: true,
      webSearchPolicy: test.kind === 'fact-check' ? FACT_CHECK_SEARCH_POLICY : { required: true, toolChoice: 'auto', maxToolCalls: 1 },
      reasoningEffort: role === 'secondary' ? 'low' : role === 'interactive' ? settings.interactiveReasoningEffort : settings.reasoningEffort,
      ...(imageInputs ? { imageInputs } : {}), ...overrides };
    return invokeOverride ? invokeOverride(options) : getAdapter(provider.preset).streamChat(provider.apiKey, options, resolveBaseUrl(provider.preset, provider.baseUrl));
  };
  if (test.kind === 'tools') {
    const tools: TextToolDefinition[] = [{ name: 'search_conversation', description: 'Retrieve the user’s previously recorded study code.', parameters: {
      type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
    } }];
    const first = await collect(invoke({ tools }), role);
    assertDiagnostic(first.calls.length === 1 && first.calls[0]!.name === 'search_conversation', 'The model did not return exactly one structured search_conversation tool call.');
    const call = first.calls[0]!;
    let argumentsValue: unknown;
    try { argumentsValue = JSON.parse(call.arguments); } catch { throw new GenerationResponseError('tool_call', 'Tool arguments are not valid JSON.', 'Retry once or choose a model with reliable tool calling.'); }
    assertDiagnostic(argumentsValue && typeof (argumentsValue as { query?: unknown }).query === 'string', 'The tool call omitted its required query.');
    const conversation: ProviderConversationMessage[] = [...test.messages, { role: 'assistant', content: first.text, toolCalls: first.calls, providerContent: first.native },
      { role: 'tool', content: 'The recorded study code is KESTREL-42.', toolCallId: call.id }];
    const final = await collect(invoke({ conversation, messages: [], tools }), role);
    assertDiagnostic(!final.calls.length && final.text.includes('KESTREL-42'), 'The model did not use the tool result to finish its answer.');
    return { status: 'passed', detail: 'Valid tool arguments, tool result, and final answer. No canvas action was executed.' };
  }
  if (test.kind === 'interactive') {
    const palette = { ...DEFAULT_INTERACTIVE_HOST_STATE.theme, primary: '#60a5fa', primarySoft: 'rgba(96,165,250,0.18)' };
    const theme = { ...palette, ...interactiveAccentColors(palette) };
    const bypass = settings.modelCompatibilityOverrides?.interactive || (!settings.interactiveModelRef && settings.modelCompatibilityOverrides?.main);
    const codingTools = bypass || resolveCaps(provider.preset, model, target.info).tools === true ? interactiveTools() : [];
    const messages: ProviderConversationMessage[] = test.messages.map(message => message.role === 'system'
      ? { ...message, content: message.content + '\n\n' + effectivePrompt(codingTools.length ? 'interactiveNodeTools' : 'interactiveNodeOutput', settings.customPrompts) } : message);
    let warnings: string[] = [];
    const html = await runInteractiveWorkflow({ messages, initialHtml: test.repair ? BROKEN_PROGRAM : test.modify ? INITIAL_PROGRAM : undefined,
      onWarnings: notes => { warnings = notes; },
      ...(test.repair ? { acceptedPlan: REPAIR_PLAN, maxRepairs: 1, repairPassOffset: 5,
        repairFeedback: '#count text: expected equals "1" after clicking #add, observed "0".' } : {}),
      planPrompt: effectivePrompt('interactiveNodePlan', settings.customPrompts), reviewPrompt: effectivePrompt('interactiveNodeReview', settings.customPrompts),
      reviewRetryPrompt: effectivePrompt('interactiveNodeReviewRetry', settings.customPrompts),
      tools: codingTools, signal, failFast: true, maxRounds: 4, onDraft: () => {}, onStep: () => {},
      repairPrompt: error => substitute(effectivePrompt('interactiveNodeRepair', settings.customPrompts), { error }),
      invoke: (conversation, tools, onActivity) => invoke({ messages: [], conversation, tools: tools.length ? tools : undefined, toolArgumentLimits: tools.length ? INTERACTIVE_TOOL_ARGUMENT_LIMITS : undefined, onActivity }),
      check: (html, actions) => checkInteractiveDocument(html, theme, signal, actions),
      verify: (html, actions, options) => checkInteractiveDocument(html, theme, signal, actions, options) });
    // Independent expected answers supplement the model's own plan. A flawed
    // plan and an equally flawed implementation cannot validate each other.
    const action = test.modify || test.repair
      ? await checkInteractiveDocument(html, theme, signal, [{ action: 'click', selector: '#add' }], {
        assertions: [{ selector: '#count', property: 'text', operator: 'equals', expected: test.repair ? '1' : '2' }] })
      : await checkInteractiveDocument(html, theme, signal, [{ action: 'input', selector: '#voltage', value: '9' }, { action: 'input', selector: '#resistance', value: '3' }], {
        assertions: [{ selector: '#current', property: 'text', operator: 'equals', expected: '3' }] });
    assertDiagnostic(action.ok, 'The program failed an independent expected-result check: ' + action.errors.join(' '));
    return { status: 'passed', detail: (test.repair ? 'One requested repair reused the saved draft and fixed plan. ' : 'Planning and code generation passed. ')
      + 'Initial/normal/boundary/reset outcomes, screenshots in both themes and fresh visual review passed. Independent expected results also matched. No automatic retry was attempted.'
      + (warnings.length ? '\nNon-blocking review notes: ' + warnings.join(' ') : '') };
  }
  const result = await collect(invoke(), role);
  requireVisibleText(result.text, role);
  if (result.calls.length) throw new GenerationResponseError('tool_call', 'The model returned a tool call instead of the requested answer.', 'Check the server’s tool configuration and retry.');
  test.validate?.(result.text);
  if (test.kind === 'fact-check') {
    if (result.searchError) throw new Error(result.searchError);
    assertDiagnostic(result.usedSearch || result.citations.length > 0, 'The model answered without confirmed web search. Check the search configuration and retry.');
    parseFactCheckFinding(result.text, 'sample', result.citations);
    return { status: 'passed', detail: 'Search completed and the verdict uses valid evidence from the returned sources. One attempt; no automatic retry.' };
  }
  if (test.kind === 'search') {
    if (result.searchError) throw new Error(result.searchError);
    if (!result.usedSearch) return { status: 'inconclusive', detail: 'The server did not confirm executing search. Answer text or a URL alone does not prove a search ran. Check server logs and the search configuration.' };
    assertDiagnostic(extractInlineCitations(result.text).length > 0 || result.citations.some(c => /^https?:\/\//.test(c.url)), 'Search ran, but the answer has no usable source links.');
    return { status: 'passed', detail: 'The server confirmed search and the answer includes source links. Source accuracy still requires review.' };
  }
  return { status: 'passed', detail: 'The sample completed and passed its output checks. One sample is not a reliability guarantee.' };
}

export async function runDiagnosticPlan(jobs: DiagnosticJob[], settings: Settings, options: {
  signal: AbortSignal; timeoutMs: number; onResult: (result: DiagnosticResult) => void;
  run?: typeof runDiagnosticJob;
  onController?: (key: string, controller: AbortController | undefined) => void;
}): Promise<void> {
  const fixture = options.run ? '' : diagnosticImageFixture();
  const blocked = new Map<string, string>();
  const active = new Map<DiagnosticJob, AbortController>();
  const redact = (text: string) => settings.providers.reduce((s, p) => p.apiKey.length > 5 ? s.replaceAll(p.apiKey, '[API key redacted]') : s, text).slice(0, 1800);
  // Each check owns its timeout and cancellation. Only dependent steps inside
  // a check (tool results, interactive edits) wait for one another.
  const stopAll = () => { for (const controller of active.values()) controller.abort(options.signal.reason); };
  options.signal.addEventListener('abort', stopAll, { once: true });
  const run = async (job: DiagnosticJob) => {
    const base = { key: job.key, role: job.target.role, model: job.target.model,
      provider: job.target.provider.name || job.target.provider.preset, label: job.test.label };
    if (options.signal.aborted) { options.onResult({ ...base, status: 'cancelled', detail: 'Not run: the test session was stopped.' }); return; }
    if (blocked.has(job.target.provider.id)) { options.onResult({ ...base, status: 'skipped', detail: blocked.get(job.target.provider.id)! }); return; }
    const started = Date.now(); const controller = new AbortController();
    active.set(job, controller);
    const timer = setTimeout(() => controller.abort(new DOMException('The test timed out.', 'TimeoutError')), options.timeoutMs);
    let stopWaiting: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      stopWaiting = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', stopWaiting, { once: true });
    });
    try {
      options.onController?.(job.key, controller);
      options.onResult({ ...base, status: 'running', detail: 'Running one attempt…' });
      // Attach both handlers before invoking a provider, including when a stop
      // arrives synchronously from a progress callback.
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return (options.run ?? runDiagnosticJob)(job, settings, controller.signal, fixture);
      });
      const result = await Promise.race([work, interrupted]);
      controller.signal.throwIfAborted();
      options.onResult({ ...base, ...result, detail: redact(result.detail), milliseconds: Date.now() - started });
    } catch (error) {
      const result = options.signal.aborted ? { status: 'cancelled' as const, detail: 'Stopped. The server may still bill work already performed.' }
        : controller.signal.aborted && blocked.has(job.target.provider.id)
          ? { status: 'cancelled' as const, detail: blocked.get(job.target.provider.id)! }
        : controller.signal.aborted && controller.signal.reason?.name === 'AbortError'
          ? { status: 'cancelled' as const, detail: 'This check was stopped. Other checks continue. The server may still bill work already performed.' }
        : diagnosticError(controller.signal.aborted ? controller.signal.reason : error);
      if ('code' in result && ['auth', 'insufficient_credits'].includes(result.code)) {
        blocked.set(job.target.provider.id,
          'Stopped because another check on this connection failed authentication or ran out of credits. Fix the connection or billing before testing again. The provider may still bill work already performed.');
        for (const [other, pending] of active) {
          if (other !== job && other.target.provider.id === job.target.provider.id) pending.abort(new DOMException('Provider checks stopped', 'AbortError'));
        }
      }
      options.onResult({ ...base, ...result, detail: redact(result.detail), milliseconds: Date.now() - started });
    } finally {
      clearTimeout(timer); active.delete(job); options.onController?.(job.key, undefined);
      if (stopWaiting) controller.signal.removeEventListener('abort', stopWaiting);
    }
  };
  try { await Promise.all(jobs.map(run)); }
  finally { options.signal.removeEventListener('abort', stopAll); stopAll(); }
}
