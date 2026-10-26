import { checkFinishReason, GenerationResponseError, requireVisibleText } from '../generationValidation';
import type {
  ChatChunk, ProviderConversationMessage, TextToolCall, TextToolDefinition,
} from '@/providers/types';
import type { ChatToolActivity } from '@/store/chatTypes';

export interface ChatTool {
  definition: TextToolDefinition;
  parse: (input: unknown) => unknown;
  summary: (input: unknown) => string;
  execute: (input: unknown, signal: AbortSignal) => Promise<{ text: string; summary: string }>;
}

export const CHAT_TOOL_LIMITS = {
  rounds: 4, calls: 6, outputCharacters: 18_000, callTimeoutMs: 15_000,
} as const;

function aborted(): DOMException { return new DOMException('Generation stopped.', 'AbortError'); }

/** Cancel-aware timeout also guards executors that do not cooperate with AbortSignal.
 * Their eventual result is discarded, never committed to a newer answer. */
async function executeBounded(tool: ChatTool, input: unknown, signal: AbortSignal) {
  if (signal.aborted) throw aborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => { if (signal.aborted) throw aborted(); return tool.execute(input, controller.signal); }),
      new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(aborted()); };
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Conversation search timed out.'));
        }, CHAT_TOOL_LIMITS.callTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Reusable, strictly allowlisted client tool loop. Raw results live only in
 * this request's messages. UI receives compact activity records, not prompts,
 * signatures, arguments or hidden provider reasoning. */
export async function runChatToolLoop(options: {
  messages: ProviderConversationMessage[];
  tools: readonly ChatTool[];
  signal: AbortSignal;
  invoke: (messages: ProviderConversationMessage[], tools: TextToolDefinition[], round: number) => AsyncIterable<ChatChunk>;
  onChunk: (chunk: ChatChunk) => void;
  onActivity: (activity: ChatToolActivity) => void;
}): Promise<void> {
  const messages = [...options.messages];
  const registry = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  const seen = new Set<string>();
  let callsUsed = 0;
  let remainingCharacters = CHAT_TOOL_LIMITS.outputCharacters as number;
  let priorTextLength = 0;
  for (let round = 0; round <= CHAT_TOOL_LIMITS.rounds; round++) {
    if (options.signal.aborted) throw aborted();
    const enabled = round < CHAT_TOOL_LIMITS.rounds && callsUsed < CHAT_TOOL_LIMITS.calls
      ? options.tools.map((tool) => tool.definition) : [];
    let text = ''; let finished = false;
    let calls: TextToolCall[] = [];
    let native: unknown[] | undefined;
    for await (const chunk of options.invoke(messages, enabled, round)) {
      if (options.signal.aborted) throw aborted();
      text += chunk.delta;
      if (chunk.toolCalls) calls = chunk.toolCalls;
      if (chunk.providerResponse) native = chunk.providerResponse;
      options.onChunk(chunk.citations?.length ? { ...chunk, citations: chunk.citations.map((citation) => ({
        ...citation,
        startIndex: citation.startIndex == null ? undefined : citation.startIndex + priorTextLength,
        endIndex: citation.endIndex == null ? undefined : citation.endIndex + priorTextLength,
      })) } : chunk);
      checkFinishReason(chunk.finishReason, 'main');
      if (chunk.done) { finished = true; break; }
    }
    if (!finished) throw new GenerationResponseError('interrupted', 'The model stream stopped before the answer was complete.', 'Check the connection and retry.');
    if (!calls.length) { requireVisibleText(text); return; }
    if (!enabled.length) throw new Error('The model exceeded the conversation-search limit.');
    messages.push({ role: 'assistant', content: text, toolCalls: calls, providerContent: native });
    priorTextLength += text.length;
    for (const call of calls) {
      if (options.signal.aborted) throw aborted();
      if (!call.id || seen.has(call.id)) throw new Error('The model repeated a tool-call identity.');
      seen.add(call.id);
      const tool = registry.get(call.name);
      let activity: ChatToolActivity = { id: call.id, name: call.name,
        summary: 'Checking conversation-search request', state: 'running' };
      let output = '';
      let failed = false;
      try {
        if (!tool) throw new Error('The requested tool is not available.');
        if (++callsUsed > CHAT_TOOL_LIMITS.calls || remainingCharacters <= 0) {
          throw new Error('Conversation-search budget reached. Use the context already available.');
        }
        if (call.arguments.length > 16_384) throw new Error('Tool input is too large.');
        const input = tool.parse(JSON.parse(call.arguments));
        activity = { ...activity, summary: tool.summary(input) };
        options.onActivity(activity);
        const result = await executeBounded(tool, input, options.signal);
        if (options.signal.aborted) throw aborted();
        output = result.text.slice(0, remainingCharacters);
        remainingCharacters -= output.length;
        options.onActivity({ ...activity, state: 'complete', resultSummary: result.summary });
      } catch (error) {
        if (options.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          options.onActivity({ ...activity, state: 'stopped', resultSummary: 'Stopped' });
          throw aborted();
        }
        failed = true;
        output = error instanceof Error ? error.message : 'Conversation search failed.';
        options.onActivity({ ...activity, state: 'failed', resultSummary: output });
      }
      messages.push({ role: 'tool', content: output, toolCallId: call.id, toolError: failed });
    }
    // A continuation is a new Markdown block. Otherwise a pre-tool sentence
    // can join directly to the next round's heading/list/table and break it.
    if (text.trim() && !text.endsWith('\n\n')) {
      const separator = text.endsWith('\n') ? '\n' : '\n\n';
      options.onChunk({ delta: separator, done: false });
      priorTextLength += separator.length;
    }
  }
}
