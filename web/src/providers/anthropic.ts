import type { TextAdapter, StreamChatOpts, ChatChunk, ModelInfo } from './types';
import { sseEvents } from './sse';
import { normalizeProviderError, ProviderError } from './errors';
import { inferModelCaps } from '@/lib/modelMeta';
import { effectiveReasoningEffort, REASONING_LEVELS } from '@/lib/modelReasoning';
import { anthropicMessagesWithImages } from './multimodal';
import { anthropicConversation } from './conversation';
import { modelOutputTokenLimit } from '@/lib/generationLimits';
import { GenerationResponseError } from '@/lib/generationValidation';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    'Content-Type': 'application/json',
  };
}

export function parseAnthropicModel(d: Record<string, unknown>): ModelInfo {
  const info: ModelInfo = { id: String(d.id) };
  if (typeof d.display_name === 'string') info.name = d.display_name;
  if (typeof d.max_input_tokens === 'number' && d.max_input_tokens > 0) info.contextLength = d.max_input_tokens;
  if (typeof d.max_tokens === 'number' && Number.isFinite(d.max_tokens) && d.max_tokens > 0) info.maxOutputTokens = Math.floor(d.max_tokens);
  if (d.capabilities && typeof d.capabilities === 'object') {
    const caps = d.capabilities as Record<string, { supported?: boolean; [key: string]: unknown } | undefined>;
    info.caps = { ...inferModelCaps('anthropic', info.id),
      ...(typeof caps.image_input?.supported === 'boolean' ? { vision: caps.image_input.supported } : {}),
      ...(typeof caps.thinking?.supported === 'boolean' ? { reasoning: caps.thinking.supported } : {}),
    };
    const modes = caps.thinking?.types as Record<string, { supported?: boolean }> | undefined;
    const efforts = REASONING_LEVELS.filter((level) => (caps.effort?.[level] as { supported?: boolean } | undefined)?.supported === true);
    if (caps.effort?.supported || modes?.adaptive?.supported || modes?.enabled?.supported) {
      info.reasoning = {
        supportedEfforts: efforts.length ? efforts : modes?.enabled?.supported ? ['low', 'medium', 'high'] : [],
        mode: modes?.adaptive?.supported ? 'adaptive' : 'budget',
      };
    }
  }
  return info;
}

async function listModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
  const base = baseUrl ?? DEFAULT_BASE;
  const r = await fetch(`${base}/models`, { headers: buildHeaders(apiKey) });
  if (!r.ok) {
    throw normalizeProviderError(r.status, await r.text().catch(() => ''), r.headers?.get?.('Retry-After'));
  }
  const json = (await r.json()) as { data: Record<string, unknown>[] };
  return json.data.map(parseAnthropicModel);
}

async function* streamChat(apiKey: string, opts: StreamChatOpts, baseUrl?: string): AsyncIterable<ChatChunk> {
  const base = baseUrl ?? DEFAULT_BASE;

  // Split the system message out of the messages array. Anthropic expects it
  // as a top-level `system` field, not as a message.
  let system = '';
  const userAssistantMessages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of opts.conversation ?? opts.messages) {
    if (m.role === 'system') {
      // Concatenate multiple system messages (rare) with newlines.
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === 'user' || m.role === 'assistant') {
      userAssistantMessages.push({ role: m.role, content: m.content });
    }
  }

  // Extended/adaptive thinking — only on thinking-capable Claude models,
  // and only for an explicit supported effort. Thinking tokens count
  // inside max_tokens. Keep thinking inside the user's allowance, never raise
  // the output ceiling implicitly. Tiny requests omit optional manual thinking.
  const eff = effectiveReasoningEffort('anthropic', opts.model, opts.reasoningEffort, opts.modelInfo);
  const adaptive = opts.modelInfo?.reasoning?.mode === 'adaptive'
    || (!opts.modelInfo?.reasoning && /claude-(?:(?:sonnet|opus)-(?:4-[6-9]|5)|(?:fable|mythos)-)/.test(opts.model));
  const allowance =
    eff && eff !== 'off'
      ? ({ minimal: 1024, low: 1024, medium: 4096, high: 12000, xhigh: 16000, max: 24000 } as const)[eff]
      : 0;
  const maxTokens = modelOutputTokenLimit(opts.maxOutputTokens, opts.modelInfo);
  const budget = adaptive || maxTokens <= 1024 ? 0
    : Math.min(allowance, Math.max(1024, maxTokens - 1024));
  if (!adaptive && allowance && !budget && opts.modelInfo?.reasoning?.mandatory) {
    throw new ProviderError('This model requires more output space for reasoning. Increase the allowance in Settings → Models and generation → Generation token limits, or choose another model.', { kind: 'bad_request' });
  }

  const conversation: { role: 'user' | 'assistant'; content: unknown }[] =
    opts.conversation ? anthropicConversation(opts.conversation)
      : anthropicMessagesWithImages(userAssistantMessages, opts.imageInputs);
  let emittedTextLength = 0;

  // A long-running Anthropic server tool may end a response with `pause_turn`.
  // Continue with the assistant blocks unchanged, bounded so a provider-side
  // loop can never keep a browser generation alive forever.
  for (let continuation = 0; continuation < 3; continuation++) {
    const requestBody: Record<string, unknown> = {
      model: opts.model,
      max_tokens: maxTokens,
      messages: conversation,
      stream: true,
    };
    if (system) requestBody.system = system;
    if (budget) requestBody.thinking = { type: 'enabled', budget_tokens: budget };
    if (adaptive && eff && eff !== 'off') {
      requestBody.thinking = { type: 'adaptive' };
      requestBody.output_config = { effort: eff === 'minimal' ? 'low' : eff };
    }
    if (opts.webSearch) {
      requestBody.tools = [{
        type: 'web_search_20250305',
        name: 'web_search',
        ...(opts.webSearchPolicy?.maxToolCalls
          ? { max_uses: opts.webSearchPolicy.maxToolCalls }
          : {}),
      }];
      requestBody.tool_choice = { type: 'auto' };
    }
    if (opts.tools?.length) requestBody.tools = [
      ...(Array.isArray(requestBody.tools) ? requestBody.tools : []),
      ...opts.tools.map((tool) => ({ name: tool.name, description: tool.description,
        input_schema: tool.parameters })),
    ];

    const r = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(requestBody),
      signal: opts.signal,
    });
    if (!r.ok || !r.body) {
      throw normalizeProviderError(r.status, await r.text().catch(() => ''), r.headers?.get?.('Retry-After'));
    }

    opts.onActivity?.({ phase: 'waiting' });
    const blocks = new Map<number, Record<string, unknown>>();
    const textStarts = new Map<number, number>();
    const partialJson = new Map<number, string>();
    let stopReason: string | undefined;
    let sawStop = false;

    for await (const event of sseEvents(r.body)) {
      const dataLine = event.split('\n').find((l) => l.trim().startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.trim().slice(5).trim();
      if (!payload) continue;
      let data: Record<string, unknown>;
      try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
      const type = data.type;
      const index = typeof data.index === 'number' ? data.index : 0;
      if (type === 'error') {
        const error = data.error as Record<string, unknown> | undefined;
        throw new Error(typeof error?.message === 'string' ? error.message : 'Anthropic interrupted the response.');
      }

      if (type === 'content_block_start') {
        const source = data.content_block as Record<string, unknown> | undefined;
        if (!source) continue;
        const block = structuredClone(source);
        blocks.set(index, block);
        if (block.type === 'thinking') opts.onActivity?.({ phase: 'reasoning' });
        else if (block.type === 'tool_use') opts.onActivity?.({ phase: 'tool', tool: String(block.name ?? '') });
        if (block.type === 'text') {
          opts.onActivity?.({ phase: 'responding' });
          textStarts.set(index, emittedTextLength);
          const initial = typeof block.text === 'string' ? block.text : '';
          if (initial) {
            emittedTextLength += initial.length;
            yield { delta: initial, done: false };
          }
        } else if (block.type === 'web_search_tool_result') {
          const content = block.content;
          if (Array.isArray(content)) {
            yield { delta: '', done: false, webSearch: { used: true } };
          } else {
            const err = content as Record<string, unknown> | undefined;
            if (err?.type === 'web_search_tool_result_error') {
              yield {
                delta: '', done: false,
                webSearch: { used: false, error: String(err.error_code ?? 'web_search_failed') },
              };
            }
          }
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        const block = blocks.get(index);
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          emittedTextLength += delta.text.length;
          if (block) block.text = String(block.text ?? '') + delta.text;
          yield { delta: delta.text, done: false };
        } else if (delta.type === 'citations_delta') {
          const citation = delta.citation as Record<string, unknown> | undefined;
          if (citation?.type === 'web_search_result_location' && typeof citation.url === 'string') {
            if (block) {
              const citations = Array.isArray(block.citations) ? block.citations as unknown[] : [];
              block.citations = [...citations, structuredClone(citation)];
            }
            yield {
              delta: '', done: false,
              citations: [{
                url: citation.url,
                title: typeof citation.title === 'string' ? citation.title : undefined,
                content: typeof citation.cited_text === 'string' ? citation.cited_text : undefined,
                startIndex: textStarts.get(index) ?? emittedTextLength,
                endIndex: emittedTextLength,
                offsetKind: 'claim',
              }],
              webSearch: { used: true },
            };
          }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          partialJson.set(index, (partialJson.get(index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && block) {
          block.thinking = String(block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && block) {
          block.signature = String(block.signature ?? '') + delta.signature;
        }
        continue;
      }

      if (type === 'content_block_stop') {
        const json = partialJson.get(index);
        const block = blocks.get(index);
        if (json && block) {
          try { block.input = JSON.parse(json); } catch { /* preserve the start block's input */ }
        }
        continue;
      }

      if (type === 'message_delta') {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
        const usage = data.usage as Record<string, unknown> | undefined;
        const server = usage?.server_tool_use as Record<string, unknown> | undefined;
        const count = server?.web_search_requests;
        if (typeof count === 'number') {
          yield { delta: '', done: false, webSearch: { used: count > 0, requestCount: count } };
        }
        continue;
      }

      if (type === 'message_stop') {
        sawStop = true;
        break;
      }
    }

    if (stopReason === 'pause_turn') {
      if (continuation === 2) {
        throw new Error('Anthropic web search remained paused after three responses.');
      }
      for (const [index, json] of partialJson) {
        const block = blocks.get(index);
        if (block && json) {
          try { block.input = JSON.parse(json); } catch { /* preserve original input */ }
        }
      }
      conversation.push({
        role: 'assistant',
        content: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
      });
      continue;
    }

    if (sawStop || stopReason) {
      const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
      yield { delta: '', done: true, finishReason: stopReason === 'max_tokens' ? 'length' : stopReason,
        toolCalls: content.filter((block) => block.type === 'tool_use').map((block) => ({
          id: String(block.id ?? ''), name: String(block.name ?? ''),
          arguments: JSON.stringify(block.input ?? {}),
        })),
        providerResponse: opts.tools?.length ? content : undefined,
      };
      return;
    }
    throw new GenerationResponseError('interrupted', 'The Anthropic response stream ended before completing.', 'Check the connection and retry.');
  }
}

export const anthropicAdapter: TextAdapter = {
  listModels,
  streamChat,
  capabilities: { webSearch: true },
};
