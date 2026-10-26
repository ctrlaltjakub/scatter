import { configuredPrompt } from '@/lib/configuredPrompt';
import type { ChatChunk, Citation, ProviderConversationMessage, StreamChatOpts, TextToolCall, TextToolDefinition } from './types';
import { providerMessages } from './conversation';
import { validSearchEndpoint } from './modelSearch';

const SEARCH_TOOL: TextToolDefinition = {
  name: 'scatter_web_search',
  description: '',
  parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['query'], additionalProperties: false },
};

function bounded(value: number | undefined, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;
}

/** All network access is to the user's configured service. Result URLs are
 * evidence, not fetch instructions; model-generated URLs are never requested. */
export async function searchSearxng(endpoint: string, query: string, options: {
  signal?: AbortSignal; maxResults?: number; maxCharacters?: number;
} = {}): Promise<Citation[]> {
  if (!validSearchEndpoint(endpoint)) throw new Error('Set a valid SearXNG URL in Settings → AI providers.');
  const url = new URL(endpoint.trim().replace(/\/+$/, '').replace(/\/search$/, '') + '/search');
  url.searchParams.set('q', query.trim().slice(0, 512));
  url.searchParams.set('format', 'json');
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, { signal, credentials: 'omit', headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error('Cannot reach SearXNG. Check the URL, HTTPS requirements, and browser access (CORS) from the app.', { cause: error });
  }
  if (!response.ok) throw new Error(`SearXNG search failed (HTTP ${response.status}). Enable JSON search and browser access on your server.`);
  let data: { results?: unknown };
  try { data = await response.json() as typeof data; }
  catch { throw new Error('SearXNG did not return JSON. Enable the JSON format in its search settings.'); }
  if (!Array.isArray(data?.results)) throw new Error('SearXNG returned an invalid search response.');
  const result: Citation[] = [];
  const seen = new Set<string>();
  const limit = bounded(options.maxResults, 5, 10);
  let remaining = bounded(options.maxCharacters, 8000, 16_000);
  for (const value of data.results.slice(0, 100)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.url !== 'string' || entry.url.length > 2048) continue;
    let source: URL;
    try { source = new URL(entry.url); } catch { continue; }
    if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password || seen.has(source.href)) continue;
    seen.add(source.href);
    const title = typeof entry.title === 'string' ? entry.title.replace(/<[^>]*>/g, '').slice(0, 240) : source.hostname;
    const content = typeof entry.content === 'string' ? entry.content.replace(/<[^>]*>/g, '').slice(0, Math.min(2400, remaining)) : '';
    remaining -= content.length;
    result.push({ url: source.href, title, content, offsetKind: 'citation-label' });
    if (result.length >= limit || remaining <= 0) break;
  }
  return result;
}

type Invoke = (options: StreamChatOpts) => AsyncIterable<ChatChunk>;

function withInstructions(messages: ProviderConversationMessage[], instruction: string): ProviderConversationMessage[] {
  // Local chat templates commonly allow a system message only at the start.
  return [
    { role: 'system', content: [...messages.filter((m) => m.role === 'system').map((m) => m.content), instruction].join('\n\n') },
    ...messages.filter((message) => message.role !== 'system'),
  ];
}

/** One bounded model-selected query, then a normal streaming answer. Search is
 * an internal tool: it never leaks into the outer conversation-action loop.
 * Original images, app tools and native continuation blocks are preserved. */
export async function* streamWithLocalSearch(opts: StreamChatOpts, invoke: Invoke): AsyncIterable<ChatChunk> {
  if (!opts.webSearch) { yield* invoke(opts); return; }
  if (!validSearchEndpoint(opts.webSearchEndpoint)) {
    throw new Error('Web search is enabled, but no search service is configured. Set up search in Settings → AI providers, or turn Web search off.');
  }
  if (!opts.allowUnverifiedCapabilities && opts.modelInfo?.caps?.tools !== true) {
    throw new Error('Tool calling is not confirmed. Choose a compatible model, or enable Show all models for this role to try it at your own risk.');
  }
  opts.signal?.throwIfAborted();
  const messages = providerMessages(opts);
  const planning = withInstructions(messages, configuredPrompt('localSearchPlan'));
  let call: TextToolCall | undefined;
  let providerContent: unknown[] | undefined;
  // Planning needs only a search query. Do not re-enable thinking for models
  // with an on/off toggle when the user explicitly turned reasoning off.
  const planningEffort = opts.reasoningEffort === 'off' ? 'off' : 'low';
  for await (const chunk of invoke({ ...opts, webSearch: false, conversation: planning,
    tools: [{ ...SEARCH_TOOL, description: configuredPrompt('localSearchTool') }], reasoningEffort: planningEffort, maxOutputTokens: Math.min(opts.maxOutputTokens, 1024) })) {
    opts.signal?.throwIfAborted();
    if (chunk.done) {
      if (chunk.toolCalls?.length !== 1 || chunk.toolCalls[0]?.name !== SEARCH_TOOL.name) {
        throw new Error('The local model did not call the search tool. Try a model with reliable tool calling, or turn web search off.');
      }
      call = chunk.toolCalls[0]; providerContent = chunk.providerResponse; break;
    }
  }
  if (!call) throw new Error('The model stopped before requesting web search.');
  let query: unknown;
  try { query = (JSON.parse(call.arguments) as { query?: unknown }).query; } catch { /* validated below */ }
  if (typeof query !== 'string' || !query.trim() || query.length > 512) throw new Error('The model returned an invalid search query.');
  const results = await searchSearxng(opts.webSearchEndpoint!, query, {
    signal: opts.signal,
    maxResults: Math.min(opts.webSearchPolicy?.maxResults ?? 5, opts.webSearchPolicy?.maxTotalResults ?? 10),
    maxCharacters: opts.webSearchPolicy?.maxCharacters,
  });
  yield { delta: '', done: false, webSearch: { used: true, requestCount: 1 } };
  const conversation = withInstructions([
    ...messages,
    { role: 'assistant', content: '', toolCalls: [call], providerContent },
    { role: 'tool', toolCallId: call.id, content: JSON.stringify({ results }) },
  ], configuredPrompt('localSearchAnswer'));
  let answer = '';
  for await (const chunk of invoke({ ...opts, webSearch: false, conversation })) {
    opts.signal?.throwIfAborted();
    answer += chunk.delta;
    if (chunk.done) {
      // Only sources actually referenced in this answer become visible citations.
      // The full retrieved excerpts are still available to evidence validation.
      const citations = results.filter((source) => answer.includes(source.url));
      if (citations.length) yield { delta: '', done: false, citations };
    }
    yield chunk;
    if (chunk.done) return;
  }
}
