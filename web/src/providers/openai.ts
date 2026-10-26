import type { TextAdapter, StreamChatOpts, ChatChunk, ModelInfo, ModelPricing, ModelCaps, Citation } from './types';
import { sseEvents } from './sse';
import { normalizeProviderError, ProviderError } from './errors';
import { openAiMessagesWithImages } from './multimodal';
import { compatConversation, providerMessages, responsesConversation, ToolCallAccumulator, ReasoningDetailAccumulator } from './conversation';
import { openaiModelSupportsSearch } from './modelSearch';
import { effectiveReasoningEffort, parseReasoningEffort, REASONING_LEVELS } from '@/lib/modelReasoning';
import { streamWithLocalSearch } from './localSearch';
import { streamWithLmStudioSearch } from './serverSearch';
import { modelOutputTokenLimit } from '@/lib/generationLimits';
import { compatibleMetadata } from './modelMetadata';
import { validServerSearch } from './modelSearch';
import { configuredPrompt } from '@/lib/configuredPrompt';
import { GenerationResponseError } from '@/lib/generationValidation';
export { openaiModelSupportsSearch } from './modelSearch';

const DEFAULT_BASE = 'https://api.openai.com/v1';

/** Coerce a numeric-or-numeric-string field (OpenRouter prices arrive as
 *  strings like "0.00000025") to a finite number, else undefined. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Parse one `/models` entry into ModelInfo, keeping whatever metadata the
 *  provider chose to include. OpenAI/local return `{ id }` only → we get just
 *  the id; OpenRouter returns pricing/context/architecture/supported_parameters
 *  → we keep all of it. Everything past `id` is optional and defensively read. */
export function parseCompatModel(d: Record<string, unknown>): ModelInfo {
  const info: ModelInfo = { id: String(d.id) };
  if (typeof d.name === 'string') info.name = d.name;

  const topProvider = d.top_provider as Record<string, unknown> | undefined;
  const ctx = num(d.context_length) ?? num(topProvider?.context_length);
  if (ctx) info.contextLength = ctx;
  const output = num(d.max_output_tokens) ?? num(topProvider?.max_completion_tokens);
  if (output && output > 0) info.maxOutputTokens = Math.floor(output);

  const pr = d.pricing as Record<string, unknown> | undefined;
  if (pr) {
    const pricing: ModelPricing = {};
    const inp = num(pr.prompt);
    const out = num(pr.completion);
    const web = num(pr.web_search);
    if (inp !== undefined) pricing.inputPerM = inp * 1e6;   // per-token → per-1M
    if (out !== undefined) pricing.outputPerM = out * 1e6;
    if (web !== undefined) pricing.webSearchPerCall = web;
    if (Object.keys(pricing).length) info.pricing = pricing;
  }

  const sp = Array.isArray(d.supported_parameters) ? (d.supported_parameters as string[]) : undefined;
  const arch = d.architecture as Record<string, unknown> | undefined;
  const inputMods = Array.isArray(arch?.input_modalities) ? (arch!.input_modalities as string[]) : undefined;
  const outputMods = Array.isArray(arch?.output_modalities) ? (arch!.output_modalities as string[]) : undefined;
  if (sp || inputMods || outputMods) {
    const caps: ModelCaps = {};
    if (sp) {
      caps.reasoning = sp.includes('reasoning') || sp.includes('reasoning_effort');
      caps.tools = sp.includes('tools');
      caps.json = sp.includes('response_format');
    }
    if (inputMods) caps.vision = inputMods.includes('image');
    if (outputMods) caps.textOutput = outputMods.includes('text');
    info.caps = caps;
  }
  if (d.reasoning && typeof d.reasoning === 'object') {
    const reasoning = d.reasoning as Record<string, unknown>;
    const supported = reasoning.supported_efforts;
    info.reasoning = {
      supportedEfforts: supported === null ? [...REASONING_LEVELS]
        : Array.isArray(supported) ? supported.map(parseReasoningEffort).filter((level) => level !== undefined) : [],
      defaultEffort: parseReasoningEffort(reasoning.default_effort),
      mandatory: reasoning.mandatory === true,
    };
    info.caps = { ...info.caps, reasoning: true };
  }
  const metadata = compatibleMetadata(d);
  return { ...info, ...metadata, ...(info.caps || metadata.caps ? { caps: { ...info.caps, ...metadata.caps } } : {}),
    // OpenRouter explicitly uses null to advertise its full effort range.
    ...((d.reasoning as Record<string, unknown> | undefined)?.supported_efforts === null ? { reasoning: info.reasoning } : {}) };
}

/** List models from any OpenAI-compatible `/models` endpoint. */
export async function listModelsCompat(
  apiKey: string,
  base: string,
  extraHeaders?: Record<string, string>,
): Promise<ModelInfo[]> {
  const r = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
  });
  if (!r.ok) {
    throw normalizeProviderError(r.status, await r.text().catch(() => ''), r.headers?.get?.('Retry-After'));
  }
  const json = (await r.json()) as { data?: unknown };
  if (!Array.isArray(json?.data)) throw new ProviderError('The model catalog has an unexpected format. Check that the base URL points to an OpenAI-compatible /v1 API.', { kind: 'bad_request' });
  return json.data.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
    && typeof entry.id === 'string' && entry.id.trim().length > 0).map(parseCompatModel);
}

/** Extract url_citation entries from an OpenAI-compatible `delta.annotations`. */
function parseAnnotations(annotations: unknown[] | undefined): Citation[] {
  if (!Array.isArray(annotations)) return [];
  const out: Citation[] = [];
  for (const a of annotations) {
    const uc = (a as { type?: string; url_citation?: { url?: string; title?: string; content?: string; start_index?: number; end_index?: number } });
    if (uc?.type === 'url_citation' && uc.url_citation?.url) {
      out.push({
        url: uc.url_citation.url,
        title: uc.url_citation.title,
        content: uc.url_citation.content,
        startIndex: uc.url_citation.start_index,
        endIndex: uc.url_citation.end_index,
        offsetKind: 'citation-label',
      });
    }
  }
  return out;
}

/** Stream a chat completion from any OpenAI-compatible `/chat/completions`
 *  endpoint. `extra.body` merges into the JSON body (e.g. web-search tools),
 *  `extra.headers` merges into the request headers (e.g. OpenRouter's
 *  identification headers). The SSE parser is shared by OpenAI, OpenRouter,
 *  Gemini's OpenAI-compat shim, and the local/compatible cluster. */
export async function* streamChatCompat(
  apiKey: string,
  opts: StreamChatOpts,
  base: string,
  extra?: { body?: Record<string, unknown>; headers?: Record<string, string>; tokenLimitParameter?: 'max_tokens' | 'max_completion_tokens' },
): AsyncIterable<ChatChunk> {
  const tools = [
    ...(opts.tools ?? []).map((tool) => ({ type: 'function', function: tool })),
    ...(Array.isArray(extra?.body?.tools) ? extra.body.tools : []),
  ];
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extra?.headers,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.conversation ? compatConversation(opts.conversation)
        : openAiMessagesWithImages(opts.messages, opts.imageInputs),
      [extra?.tokenLimitParameter ?? 'max_tokens']: modelOutputTokenLimit(opts.maxOutputTokens, opts.modelInfo),
      stream: true,
      ...extra?.body,
      ...(tools.length ? { tools } : {}),
    }),
    signal: opts.signal,
  });
  if (!r.ok) {
    throw normalizeProviderError(r.status, await r.text().catch(() => ''), r.headers?.get?.('Retry-After'));
  }
  if (!r.body) {
    throw new ProviderError('The provider returned an empty response.', { kind: 'server', retryable: true });
  }
  let finishReason: string | null | undefined;
  opts.onActivity?.({ phase: 'waiting' });
  const toolCalls = new ToolCallAccumulator(opts.toolArgumentLimits);
  const reasoningDetails = new ReasoningDetailAccumulator();
  for await (const event of sseEvents(r.body)) {
    // An event block may carry comment lines (": keep-alive") or an
    // `event:` line; find the `data:` payload.
    const dataLine = event.split('\n').find((l) => l.trim().startsWith('data:'));
    if (!dataLine) continue;
    const payload = dataLine.trim().slice(5).trim();
    if (payload === '[DONE]') {
      yield { delta: '', done: true, finishReason, toolCalls: toolCalls.finish(),
        providerResponse: reasoningDetails.finish() };
      return;
    }
    let data: {
      choices?: {
        delta?: { content?: string; annotations?: unknown[];
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
          reasoning_details?: unknown[]; reasoning?: string; reasoning_content?: string };
        finish_reason?: string | null;
      }[];
      error?: { message?: string; code?: number | string };
      usage?: {
        server_tool_use?: { web_search_requests?: number };
        server_tool_use_details?: { web_search_requests?: number };
      };
    };
    try {
      data = JSON.parse(payload);
    } catch {
      continue; // ignore a malformed/comment chunk
    }
    // A mid-stream `{ error }` chunk arrives with HTTP 200 (e.g. an OpenRouter
    // 504 web-search timeout). Surface it instead of silently ending empty —
    // otherwise the node body comes out blank with no explanation.
    if (data.error) {
      const code = typeof data.error.code === 'number' ? data.error.code : undefined;
      throw new ProviderError(
        data.error.message || `Provider error${code != null ? ` (${code})` : ''}`,
        { kind: code != null && code >= 500 ? 'server' : 'unknown', status: code },
      );
    }
    const fr = data.choices?.[0]?.finish_reason;
    if (fr) finishReason = fr; // last non-null wins (appears on the final chunk)
    const activityDelta = data.choices?.[0]?.delta;
    if (activityDelta?.reasoning || activityDelta?.reasoning_content || activityDelta?.reasoning_details?.length) {
      opts.onActivity?.({ phase: 'reasoning' });
    }
    for (const call of activityDelta?.tool_calls ?? []) {
      toolCalls.add(call);
      if (call.function?.name) opts.onActivity?.({ phase: 'tool', tool: call.function.name });
    }
    if (opts.tools?.length) reasoningDetails.add(data.choices?.[0]?.delta?.reasoning_details ?? []);
    // OpenRouter Chat Completions search citations stream in
    // `delta.annotations` as url_citation entries with char offsets.
    const cites = parseAnnotations(data.choices?.[0]?.delta?.annotations);
    if (cites.length) yield { delta: '', done: false, citations: cites, webSearch: { used: true } };
    const searchCount = data.usage?.server_tool_use_details?.web_search_requests
      ?? data.usage?.server_tool_use?.web_search_requests;
    if (typeof searchCount === 'number') {
      yield {
        delta: '', done: false,
        webSearch: { used: searchCount > 0, requestCount: searchCount },
      };
    }
    const delta = data.choices?.[0]?.delta?.content ?? '';
    if (delta) {
      opts.onActivity?.({ phase: 'responding' });
      yield { delta, done: false };
    }
  }
  if (!finishReason) throw new GenerationResponseError('interrupted', 'The response stream ended without a completion marker.', 'Check the provider connection and retry.');
  yield { delta: '', done: true, finishReason, toolCalls: toolCalls.finish(),
    providerResponse: reasoningDetails.finish() };
}

/** Build the OpenAI Chat Completions extra body for the non-search path:
 *  reasoning_effort is sent only to reasoning models — sending it to a non-reasoning
 *  model like gpt-4o errors, so gate on the model name). */
function openaiExtraBody(opts: StreamChatOpts): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = {};
  const eff = effectiveReasoningEffort('openai', opts.model, opts.reasoningEffort, opts.modelInfo);
  if (eff) {
    body.reasoning_effort = eff === 'off' ? 'none' : eff;
  }
  return Object.keys(body).length ? body : undefined;
}

/** Hosted search and current-model tool calls use the Responses API. */
async function* streamResponses(
  apiKey: string,
  opts: StreamChatOpts,
  base: string,
): AsyncIterable<ChatChunk> {
  let instructions = '';
  const messages = providerMessages(opts);
  const input = responsesConversation(messages);
  for (const message of messages) {
    if (message.role === 'system') {
      instructions = instructions ? `${instructions}\n\n${message.content}` : message.content;
    }
  }
  const body: Record<string, unknown> = {
    model: opts.model,
    input,
    max_output_tokens: modelOutputTokenLimit(opts.maxOutputTokens, opts.modelInfo),
    stream: true,
    tools: [
      ...(opts.webSearch ? opts.serverSearch?.kind === 'responses-mcp' ? [{
        type: 'mcp', server_label: 'web_search', server_url: opts.serverSearch.url,
        allowed_tools: opts.serverSearch.tools, require_approval: 'never',
      }] : [{ type: 'web_search' }] : []),
      // Shared tool schemas contain optional fields. Strict mode requires all
      // fields, including nested ones, and would reject these valid schemas.
      // The tool runtime validates arguments before executing any action.
      ...(opts.tools ?? []).map((tool) => ({ type: 'function', ...tool, strict: false })),
    ],
    tool_choice: opts.webSearchPolicy?.toolChoice === 'auto' ? 'auto'
      : opts.webSearch && (!opts.tools?.length || opts.webSearchPolicy?.required) ? 'required' : 'auto',
    max_tool_calls: opts.webSearchPolicy?.maxToolCalls ?? 1,
    store: false,
    ...(!opts.serverSearch && opts.tools?.length ? { include: ['reasoning.encrypted_content'] } : {}),
  };
  if (opts.serverSearch) {
    // Local servers differ in forced-tool support. Exposing only the allowed
    // search tools is portable; actual execution is checked from MCP events.
    body.tool_choice = 'auto';
    if (opts.webSearch) instructions += `\n\n${configuredPrompt('serverSearch')}`;
  }
  if (instructions) body.instructions = instructions;
  const effort = effectiveReasoningEffort(opts.serverSearch ? 'custom' : 'openai', opts.model, opts.reasoningEffort, opts.modelInfo);
  if (effort) {
    body.reasoning = { effort: effort === 'off' ? 'none' : effort };
  }
  const r = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) throw normalizeProviderError(r.status, await r.text().catch(() => ''), r.headers?.get?.('Retry-After'));
  if (!r.body) {
    throw new ProviderError('The provider returned an empty response.', { kind: 'server', retryable: true });
  }
  opts.onActivity?.({ phase: 'waiting' });
  const streamedCalls = new ToolCallAccumulator(opts.toolArgumentLimits);
  const callIndexes = new Map<number, number>();
  let searchCount = 0;
  for await (const event of sseEvents(r.body)) {
    const dataLine = event.split('\n').find((l) => l.trim().startsWith('data:'));
    if (!dataLine) continue;
    const payload = dataLine.trim().slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
    const type = data.type;
    if (type === 'response.mcp_call.failed') {
      throw new ProviderError('The server’s search tool failed. Check its MCP connection and search-service logs, then retry.', { kind: 'server' });
    }
    if (type === 'response.output_item.done') {
      const item = data.item as Record<string, unknown> | undefined;
      if (item?.type === 'mcp_approval_request') throw new ProviderError('The server requires approval for its search tool. Configure a dedicated read-only search tool for API use.', { kind: 'bad_request' });
      if (item?.type === 'mcp_call') {
        if (item.error || item.status === 'failed') throw new ProviderError('The server’s search tool returned an error. Check the search service and retry.', { kind: 'server' });
        searchCount++;
        yield { delta: '', done: false, webSearch: { used: true, requestCount: searchCount } };
      }
    }
    if (type === 'response.output_item.added') {
      const item = data.item as Record<string, unknown> | undefined;
      if (item?.type === 'reasoning') opts.onActivity?.({ phase: 'reasoning' });
      if (item?.type === 'function_call') {
        const index = callIndexes.size;
        callIndexes.set(Number(data.output_index), index);
        streamedCalls.add({ index, id: String(item.call_id ?? ''),
          function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '') } });
        opts.onActivity?.({ phase: 'tool', tool: String(item.name ?? '') });
      }
      continue;
    }
    if (type === 'response.function_call_arguments.delta' && typeof data.delta === 'string') {
      const index = callIndexes.get(Number(data.output_index));
      if (index !== undefined) streamedCalls.add({ index, function: { arguments: data.delta } });
      continue;
    }
    if (type === 'error' || type === 'response.failed') {
      const error = (data.error ?? (data.response as Record<string, unknown> | undefined)?.error) as Record<string, unknown> | undefined;
      throw new ProviderError(String(error?.message ?? data.message ?? 'OpenAI response failed.'), { kind: 'server' });
    }
    if (type === 'response.output_text.delta' && typeof data.delta === 'string') {
      opts.onActivity?.({ phase: 'responding' });
      yield { delta: data.delta, done: false };
      continue;
    }
    if (type === 'response.web_search_call.completed') {
      yield { delta: '', done: false, webSearch: { used: true } };
      continue;
    }
    if (type === 'response.output_text.annotation.added') {
      const a = data.annotation as Record<string, unknown> | undefined;
      if (a?.type === 'url_citation' && typeof a.url === 'string') {
        yield {
          delta: '', done: false,
          citations: [{
            url: a.url,
            title: typeof a.title === 'string' ? a.title : undefined,
            content: typeof a.content === 'string' ? a.content : undefined,
            startIndex: typeof a.start_index === 'number' ? a.start_index : undefined,
            endIndex: typeof a.end_index === 'number' ? a.end_index : undefined,
            offsetKind: 'citation-label',
          }],
          webSearch: { used: true },
        };
      }
      continue;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = data.response as Record<string, unknown> | undefined;
      if (type === 'response.incomplete' && (response?.incomplete_details as Record<string, unknown> | undefined)?.reason !== 'max_output_tokens') {
        throw new GenerationResponseError('interrupted', 'The provider returned an incomplete response.', 'Check the server logs and retry.');
      }
      const output = Array.isArray(response?.output) ? response.output as Record<string, unknown>[] : [];
      const calls = output.filter((item) => item.type === 'function_call').map((item) => ({
        id: String(item.call_id ?? ''), name: String(item.name ?? ''), arguments: String(item.arguments ?? ''),
      }));
      const finalCalls = new ToolCallAccumulator(opts.toolArgumentLimits);
      calls.forEach((call, index) => finalCalls.add({ index, id: call.id,
        function: { name: call.name, arguments: call.arguments } }));
      const usage = response?.usage as Record<string, unknown> | undefined;
      const server = (usage?.server_tool_use ?? usage?.server_tool_use_details) as Record<string, unknown> | undefined;
      const count = server?.web_search_requests ?? (opts.serverSearch ? Math.max(searchCount,
        output.filter(item => item.type === 'mcp_call' && !item.error && item.status !== 'failed').length) : undefined);
      if (output.some(item => item.type === 'mcp_call' && (item.error || item.status === 'failed'))) {
        throw new ProviderError('The server’s search tool failed. Check its connection and retry.', { kind: 'server' });
      }
      yield {
        delta: '', done: true,
        webSearch: typeof count === 'number' ? { used: count > 0, requestCount: count } : undefined,
        finishReason: type === 'response.incomplete' || response?.status === 'incomplete'
          ? (response?.incomplete_details as Record<string, unknown> | undefined)?.reason === 'max_output_tokens' ? 'length' : 'incomplete'
          : 'stop',
        toolCalls: finalCalls.finish(),
        providerResponse: opts.tools?.length ? output : undefined,
      };
      return;
    }
  }
  throw new ProviderError('The response stream ended before completion. Check the server connection and retry; no automatic retry was made.', { kind: 'network', retryable: true });
}

export const openaiAdapter: TextAdapter = {
  listModels: (apiKey, baseUrl) => listModelsCompat(apiKey, baseUrl ?? DEFAULT_BASE),
  streamChat: (apiKey, opts, baseUrl) => {
    // Server-managed profiles belong to local/custom connections, never to
    // hosted OpenAI search (including stale settings after a provider change).
    opts = { ...opts, serverSearch: undefined };
    const base = baseUrl ?? DEFAULT_BASE;
    const hasToolConversation = opts.tools?.length || opts.conversation?.some(message =>
      message.role === 'tool' || message.toolCalls?.length);
    if ((opts.webSearch || hasToolConversation) && (opts.allowUnverifiedCapabilities || openaiModelSupportsSearch(opts.model))) {
      return streamResponses(apiKey, opts, base);
    }
    return streamChatCompat(apiKey, opts, base, {
      body: openaiExtraBody(opts), tokenLimitParameter: 'max_completion_tokens',
    });
  },
  capabilities: { webSearch: true },
};

/**
 * Generic OpenAI-compatible providers (DeepSeek, Groq, Ollama, LM Studio,
 * llama.cpp, vLLM, custom URL). Chat Completions with optional client-run search.
 */
export const openaiCompatibleAdapter: TextAdapter = {
  listModels: (apiKey, baseUrl) => listModelsCompat(apiKey, baseUrl ?? DEFAULT_BASE),
  streamChat: (apiKey, opts, baseUrl) => {
    if (opts.serverSearch) {
      if (opts.webSearch && !validServerSearch(opts.serverSearch)) {
        throw new ProviderError('Complete the server-managed search configuration in Settings → AI providers, or turn Web search off.', { kind: 'bad_request' });
      }
      if (opts.serverSearch.kind === 'responses-mcp') return streamResponses(apiKey, opts, (baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ''));
    }
    const invoke = (request: StreamChatOpts) => {
      const effort = effectiveReasoningEffort('custom', request.model, request.reasoningEffort, request.modelInfo);
      return streamChatCompat(apiKey, request, (baseUrl ?? DEFAULT_BASE).replace(/\/+$/, ''), {
        body: { ...(effort ? { reasoning_effort: effort === 'off' ? 'none' : effort } : {}),
          ...(request.serverSearch?.kind === 'localai' && request.webSearch
            ? { metadata: { mcp_servers: request.serverSearch.servers.join(',') } } : {}) },
      });
    };
    if (opts.serverSearch?.kind === 'lmstudio-mcp') return streamWithLmStudioSearch(apiKey, baseUrl ?? DEFAULT_BASE, opts, invoke);
    if (opts.serverSearch?.kind === 'localai') {
      if (!opts.webSearch) return invoke(opts);
      // Many local chat templates permit exactly one system message, first.
      const messages = providerMessages(opts);
      const system = [...messages.filter(m => m.role === 'system').map(m => m.content), configuredPrompt('serverSearch')].join('\n\n');
      return invoke({ ...opts, messages: [], conversation: [{ role: 'system', content: system }, ...messages.filter(m => m.role !== 'system')] });
    }
    return opts.webSearch ? streamWithLocalSearch(opts, invoke) : invoke(opts);
  },
  capabilities: { webSearch: true },
};
