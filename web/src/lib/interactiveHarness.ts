import type { ChatChunk, ProviderConversationMessage, StreamChatOpts, TextToolCall, TextToolDefinition } from '@/providers/types';
import type { InteractiveBuild } from '@/store/types';
import { checkFinishReason, GenerationResponseError } from './generationValidation';
import { validateInteractiveDocument, INTERACTIVE_DOCUMENT_MAX_CHARS, INTERACTIVE_TOOL_ARGUMENT_LIMITS } from './interactiveDocument';
import { validInteractiveActions, type InteractiveCheck, type InteractiveTestAction } from './interactiveTests';

// Enough turns for five targeted edit → verify cycles, including read/check
// calls. Extra attempts are a ceiling, not work to perform after acceptance.
export const INTERACTIVE_BUILD_LIMITS = { rounds: 18, calls: 36, repairs: 5 } as const;
export type InteractiveStep = InteractiveBuild['steps'][number];

/** Infrastructure/reviewer failures cannot be repaired by changing program code. */
export class InteractiveVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'InteractiveVerificationError'; }
}

export class InteractiveBuildLimitError extends InteractiveVerificationError {
  constructor(message: string, readonly repairPasses: number) {
    super(message); this.name = 'InteractiveBuildLimitError';
  }
}

export function replaceInteractiveText(html: string, search: string, replacement: string): string {
  if (!search || !html.includes(search)) throw new Error('The exact search text was not found. Read the document before editing.');
  if (html.indexOf(search) !== html.lastIndexOf(search)) throw new Error('The search text is not unique. Include more surrounding text.');
  const next = html.replace(search, () => replacement);
  if (next.length > INTERACTIVE_DOCUMENT_MAX_CHARS) throw new Error('The document is too large.');
  return next;
}

/** A provider-neutral, bounded single-document coding harness. Tools cannot
 * access the file system, credentials, network, other nodes, or arbitrary JS. */
export async function runInteractiveHarness(options: {
  messages: ProviderConversationMessage[]; initialHtml?: string; tools: TextToolDefinition[];
  signal: AbortSignal;
  invoke: (messages: ProviderConversationMessage[], tools: TextToolDefinition[], onActivity: NonNullable<StreamChatOpts['onActivity']>) => AsyncIterable<ChatChunk>;
  check: (html: string, actions?: InteractiveTestAction[]) => Promise<InteractiveCheck>;
  /** Mandatory acceptance gate used by the application workflow. No finish,
   * text-only fallback, or exhausted tool loop may bypass it. */
  finalCheck?: (html: string) => Promise<InteractiveCheck>;
  repairPrompt: (error: string) => string;
  onStep: (step: InteractiveStep) => void;
  onDraft: (html: string) => void;
  /** Explicit diagnostics do not retry failed tool calls or repair outputs. */
  failFast?: boolean;
  maxRounds?: number;
  maxRepairs?: number;
  /** Explicit user-requested continuation; counts as the first allowed repair. */
  repairFeedback?: string;
  repairPassOffset?: number;
  onRepairPass?: (total: number) => void;
  verifyInitial?: boolean;
  onIssues?: (issues: string[]) => void;
}): Promise<string> {
  const messages = [...options.messages,
    ...(options.initialHtml ? [{ role: 'user' as const, content: 'Current document:\n' + options.initialHtml }] : [])];
  let html = options.initialHtml ?? '';
  let wroteDocument = false;
  let checkedHtml = '';
  let lastCheck: InteractiveCheck | undefined;
  let callsUsed = 0;
  let repairs = 0;
  const maxRepairs = Math.max(0, Math.min(options.maxRepairs ?? INTERACTIVE_BUILD_LIMITS.repairs, INTERACTIVE_BUILD_LIMITS.repairs));
  const repairOffset = options.repairPassOffset ?? 0;
  let stepId = 0;
  let finalAttempts = 0;
  const acceptanceCache = new Map<string, InteractiveCheck>();
  const repairHistory: string[] = [];
  let lastRepairHtml: string | undefined;
  let unchangedRepairs = 0;
  const checkpoint = () => { if (options.signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
  const check = async (actions?: InteractiveTestAction[]) => {
    checkpoint();
    validateInteractiveDocument(html, { requireDesignTokens: true });
    lastCheck = await options.check(html, actions); checkpoint();
    checkedHtml = lastCheck.ok ? html : '';
    return lastCheck;
  };
  const finishCheck = async () => {
    // A repeated finish without a code change cannot improve the result.
    // Reuse the evidence instead of paying for identical screenshots/reviews.
    const cached = acceptanceCache.get(html);
    if (cached) return cached;
    const result = checkedHtml === html && html ? lastCheck! : await check();
    if (!result.ok || !options.finalCheck) { options.onIssues?.(result.errors); acceptanceCache.set(html, result); return result; }
    if (++finalAttempts > maxRepairs + 1) {
      throw new InteractiveBuildLimitError('The program still needs review. The latest draft and checks are saved.', repairOffset + repairs);
    }
    const verified = await options.finalCheck(html); checkpoint();
    options.onIssues?.(verified.errors);
    acceptanceCache.set(html, verified);
    return verified;
  };
  const prepareRepair = (message: string, requested = false) => {
    if (options.failFast && !requested) throw new Error(message);
    unchangedRepairs = html && html === lastRepairHtml ? unchangedRepairs + 1 : 0;
    if (unchangedRepairs >= 2) throw new InteractiveBuildLimitError(
      `The model returned unchanged code twice after repair feedback. Further identical reviews were skipped. ${message}\nTry a stronger interactive model or a more specific request.`, repairOffset + repairs);
    lastRepairHtml = html;
    if (repairs >= maxRepairs) throw new InteractiveBuildLimitError(
      `The program still fails after ${repairOffset + repairs} repair passes: ${message}`, repairOffset + repairs);
    repairs++;
    options.onRepairPass?.(repairOffset + repairs);
    const previous = repairHistory.slice(-2).map((issue, i) => `${i + 1}. ${issue.slice(0, 1000)}`).join('\n');
    repairHistory.push(message);
    // Start a fresh, valid provider conversation only after all tool results
    // in this turn have been consumed. Keep the request/accepted tests, latest
    // code and concrete failures, not every obsolete full-document revision.
    messages.splice(0, messages.length, ...options.messages, { role: 'user', content:
      `Targeted repair ${repairs} of ${maxRepairs}${repairOffset ? ` (overall pass ${repairOffset + repairs})` : ''}. Correctness and requested functionality take priority over brevity. Keep the accepted tests unchanged.\n`
      + (previous ? `Previous failures (do not repeat an ineffective fix):\n${previous}\n\n` : '')
      + options.repairPrompt(message)
      + (options.tools.length ? '\nUse edit_document for small changes, then finish. The current code is already supplied; read_document is unnecessary unless needed to resolve an edit mismatch. Do not rewrite working parts.' : '\nReturn one complete corrected HTML document, without commentary.')
      + '\n\nCurrent document:\n' + html });
    options.onStep({ id: ++stepId, label: `Preparing targeted repair · pass ${repairOffset + repairs}${repairOffset ? ' · user requested' : ` of ${maxRepairs}`}`, state: 'complete', detail: message.slice(0, 1500) });
  };
  if (options.verifyInitial && html) {
    options.onStep({ id: ++stepId, label: 'Retrying saved draft verification · no coding pass', state: 'complete' });
    const result = await finishCheck();
    if (result.ok) return html;
    prepareRepair(result.errors.join('\n'), true);
  } else if (options.repairFeedback) prepareRepair(options.repairFeedback, true);
  for (let round = 0; round < Math.min(options.maxRounds ?? INTERACTIVE_BUILD_LIMITS.rounds, INTERACTIVE_BUILD_LIMITS.rounds); round++) {
    checkpoint();
    let phase: InteractiveStep = { id: ++stepId, label: 'Connecting to model provider', state: 'running' };
    options.onStep(phase);
    const showPhase = (label: string) => {
      checkpoint();
      if (phase.label === label) return; // Never redraw the log for every token.
      options.onStep({ ...phase, state: 'complete' });
      phase = { id: ++stepId, label, state: 'running' };
      options.onStep(phase);
    };
    const onActivity: NonNullable<StreamChatOpts['onActivity']> = activity => {
      if (activity.phase === 'responding' && phase.label === 'Receiving program code') return;
      const label = activity.phase === 'waiting' ? 'Waiting for model response'
        : activity.phase === 'reasoning' ? 'Reasoning'
        : activity.phase === 'tool' ? ['write_document', 'edit_document'].includes(activity.tool ?? '')
          ? 'Receiving program code' : 'Receiving tool request'
        : 'Receiving model response';
      showPhase(label);
    };
    let text = ''; let calls: TextToolCall[] = []; let native: unknown[] | undefined; let finished = false;
    for await (const chunk of options.invoke(messages, options.tools, onActivity)) {
      checkpoint(); text += chunk.delta;
      if (chunk.delta) showPhase(/^\s*(?:```html\s*)?<!doctype/i.test(text) ? 'Receiving program code' : 'Receiving model response');
      if (chunk.toolCalls) calls = chunk.toolCalls;
      if (chunk.providerResponse) native = chunk.providerResponse;
      if (text.length > INTERACTIVE_DOCUMENT_MAX_CHARS + 10000) throw new Error('The generated document is too large.');
      // The text-only fallback is saved as a draft, never executed while streaming.
      if (/^\s*(?:```html\s*)?<!doctype/i.test(text)) options.onDraft(text);
      checkFinishReason(chunk.finishReason, 'interactive');
      if (chunk.done) { finished = true; break; }
    }
    if (!finished) throw new GenerationResponseError('interrupted', 'The model stream stopped before the interactive program was complete.', 'Check the connection and retry.');
    options.onStep({ ...phase, state: 'complete' });
    if (!calls.length) {
      if (/^\s*(?:```html\s*)?<!doctype/i.test(text)) {
        html = text.replace(/^\s*```(?:html)?\s*|\s*```\s*$/gi, '').trim(); wroteDocument = true; options.onDraft(html);
      }
      const step: InteractiveStep = { id: ++stepId, label: 'Checking layout and runtime', state: 'running' };
      options.onStep(step);
      try {
        if (!wroteDocument) throw new Error('No program changes were made. Write or edit the document before finishing.');
        const result = await finishCheck();
        if (!result.ok) throw new Error(result.errors.join('\n'));
        options.onStep({ ...step, state: 'complete' }); return html;
      } catch (error) {
        if (error instanceof InteractiveVerificationError) throw error;
        checkpoint(); const message = (error as Error).message;
        options.onStep({ ...step, state: 'failed', detail: message.slice(0,500) });
        if (options.failFast) throw error;
        prepareRepair(message);
        continue;
      }
    }
    messages.push({ role: 'assistant', content: text, toolCalls: calls, providerContent: native });
    let repairFeedback: string | undefined;
    let changedThisTurn = false;
    for (const call of calls) {
      checkpoint(); if (++callsUsed > INTERACTIVE_BUILD_LIMITS.calls) throw new InteractiveBuildLimitError('Interactive build step limit reached. The latest draft is saved.', repairOffset + repairs);
      const labels: Record<string,string> = { read_document: 'Reading current code', write_document: 'Saving program code', edit_document: 'Applying code changes', check_document: 'Checking layout and runtime', finish: 'Validating the finished program' };
      const step: InteractiveStep = { id: ++stepId, label: labels[call.name] ?? 'Checking tool request', state: 'running' };
      options.onStep(step);
      let output: unknown; let failed = false;
      try {
        if (!options.tools.some(tool => tool.name === call.name)) throw new Error('Tool not available.');
        const argumentLimit = INTERACTIVE_TOOL_ARGUMENT_LIMITS[call.name] ?? INTERACTIVE_DOCUMENT_MAX_CHARS * 2;
        if (call.arguments.length > argumentLimit) throw new Error('Tool input too large.');
        const args = JSON.parse(call.arguments || '{}');
        if (call.name === 'read_document') output = { html };
        else if (call.name === 'write_document') {
          if (typeof args.html !== 'string' || args.html.length > INTERACTIVE_DOCUMENT_MAX_CHARS) throw new Error('Provide one complete HTML document.');
          html = args.html; wroteDocument = true; changedThisTurn = true; checkedHtml = ''; options.onDraft(html); output = { saved: true, characters: html.length };
        } else if (call.name === 'edit_document') {
          if (typeof args.search !== 'string' || typeof args.replace !== 'string') throw new Error('Provide search and replace strings.');
          html = replaceInteractiveText(html, args.search, args.replace); wroteDocument = true; changedThisTurn = true; checkedHtml = ''; options.onDraft(html); output = { saved: true };
        } else if (call.name === 'check_document' || call.name === 'finish') {
          if (call.name === 'finish' && !wroteDocument) throw new Error('No program changes were made. Write or edit the document before finishing.');
          const actions = args.actions ?? [];
          if (!validInteractiveActions(actions)) throw new Error('Use at most six valid click/input/press actions. Key presses allow Enter, space, arrows, Home, End, PageUp, or PageDown.');
          const result = call.name === 'finish' && options.finalCheck ? await finishCheck() : await check(actions);
          output = result;
          if (!result.ok) throw new Error(result.errors.join('\n'));
          if (call.name === 'finish') { options.onStep({ ...step, state: 'complete' }); return html; }
        }
        options.onStep({ ...step, state: 'complete' });
      } catch (error) {
        if (options.failFast || error instanceof InteractiveVerificationError) throw error;
        checkpoint(); failed = true; output = { error: (error as Error).message.slice(0,2000) };
        options.onStep({ ...step, state: 'failed', detail: (error as Error).message.slice(0,500) });
        if (call.name === 'finish' || call.name === 'check_document') repairFeedback = (error as Error).message;
      }
      messages.push({ role: 'tool', content: JSON.stringify(output), toolCallId: call.id, toolError: failed });
    }
    // The fixed plan and independent review are app-owned. Once all edits in
    // a turn are applied, no extra model round is needed just to say "finish".
    // Legacy tool-only harness users without that acceptance gate keep their
    // explicit finish protocol.
    if (changedThisTurn && options.finalCheck && !repairFeedback) {
      const step: InteractiveStep = { id: ++stepId, label: 'Automatically verifying updated program', state: 'running' };
      options.onStep(step);
      try {
        const result = await finishCheck();
        if (!result.ok) throw new Error(result.errors.join('\n'));
        options.onStep({ ...step, state: 'complete' });
        return html;
      } catch (error) {
        checkpoint();
        options.onStep({ ...step, state: 'failed', detail: (error as Error).message.slice(0, 1500) });
        if (options.failFast || error instanceof InteractiveVerificationError) throw error;
        repairFeedback = (error as Error).message;
      }
    }
    if (repairFeedback) prepareRepair(repairFeedback);
  }
  // Do not spend another API request just for the agent's closing sentence.
  if (html && wroteDocument) {
    const result = await finishCheck();
    if (result.ok) return html;
    throw new InteractiveBuildLimitError(result.errors.join('\n'), repairOffset + repairs);
  }
  throw new InteractiveBuildLimitError('No working program was produced within the build limit.', repairOffset + repairs);
}
