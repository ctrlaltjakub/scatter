import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchSearxng, streamWithLocalSearch } from './localSearch';
import { validSearchEndpoint } from './modelSearch';
import { openaiCompatibleAdapter } from './openai';
import type { ChatChunk, StreamChatOpts } from './types';
import { useSettingsStore } from '@/store/useSettingsStore';

afterEach(() => { vi.unstubAllGlobals(); useSettingsStore.setState({ customPrompts: undefined }); });
const opts: StreamChatOpts = { model: 'local-vlm', modelInfo: { id: 'local-vlm', caps: { vision: true, tools: true } },
  messages: [{ role: 'user', content: 'Explain this.' }], maxOutputTokens: 2000,
  webSearch: true, webSearchEndpoint: 'https://search.test/subpath' };
const call = { id: 'search-1', name: 'scatter_web_search', arguments: '{"query":"public topic"}' };
async function collect(stream: AsyncIterable<ChatChunk>) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; }
function results(value: unknown = { results: [{ url: 'https://source.test/a', title: 'Source', content: 'Relevant excerpt.' }] }) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('local search connection', () => {
  it('uses edited search planning, tool description, and answer instructions in outgoing calls', async () => {
    useSettingsStore.setState({ customPrompts: { localSearchPlan: 'CUSTOM PLAN', localSearchTool: 'CUSTOM SEARCH TOOL', localSearchAnswer: 'CUSTOM EVIDENCE RULES' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(results()));
    const requests: StreamChatOpts[] = [];
    const invoke = async function* (request: StreamChatOpts): AsyncIterable<ChatChunk> {
      requests.push(request);
      yield requests.length === 1 ? { delta: '', done: true, toolCalls: [call] } : { delta: 'Answer.', done: true };
    };
    await collect(streamWithLocalSearch(opts, invoke));
    expect(requests[0]?.conversation?.[0]?.content).toContain('CUSTOM PLAN');
    expect(requests[0]?.tools?.[0]?.description).toBe('CUSTOM SEARCH TOOL');
    expect(requests[1]?.conversation?.[0]?.content).toContain('CUSTOM EVIDENCE RULES');
    expect(requests[0]?.tools?.[0]?.parameters).toMatchObject({ required: ['query'] });
  });
  it('requires a plain HTTP(S) URL without embedded credentials', () => {
    for (const url of ['', 'not a url', 'file:///a', 'https://user:secret@search.test', 'https://search.test?key=secret']) expect(validSearchEndpoint(url)).toBe(false);
    expect(validSearchEndpoint('http://localhost:8080/searx')).toBe(true);
  });
  it('requests JSON without credentials, sanitizes results and enforces evidence bounds', async () => {
    const fetcher = vi.fn().mockResolvedValue(results({ results: [
      { url: 'javascript:alert(1)', content: 'bad' },
      { url: 'https://source.test/a', title: '<b>First</b>', content: 'a'.repeat(3000) },
      { url: 'https://source.test/a', content: 'duplicate' },
      { url: 'https://source.test/b', content: 'b'.repeat(2000) },
      { url: 'https://source.test/c', content: 'extra' },
    ] }));
    vi.stubGlobal('fetch', fetcher);
    const found = await searchSearxng('https://search.test/subpath/', 'public topic', { maxResults: 2, maxCharacters: 3000 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://search.test/subpath/search?q=public+topic&format=json');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(found.map((entry) => entry.url)).toEqual(['https://source.test/a', 'https://source.test/b']);
    expect(found[0]?.title).toBe('First');
    expect(found.reduce((sum, entry) => sum + (entry.content?.length ?? 0), 0)).toBe(3000);
  });
  it('reports CORS, HTTP, and non-JSON failures without pretending search succeeded', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('<html>not JSON</html>'));
    vi.stubGlobal('fetch', fetcher);
    await expect(searchSearxng('https://search.test', 'topic')).rejects.toThrow('CORS');
    await expect(searchSearxng('https://search.test', 'topic')).rejects.toThrow('HTTP 403');
    await expect(searchSearxng('https://search.test', 'topic')).rejects.toThrow('did not return JSON');
  });
});

describe('bounded local model search', () => {
  it.each(['off', 'low', 'high', undefined] as const)('preserves reasoning Off and bounds other planning efforts (%s)', async (reasoningEffort) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(results()));
    const requests: StreamChatOpts[] = [];
    const invoke = async function* (request: StreamChatOpts): AsyncIterable<ChatChunk> {
      requests.push(request);
      yield requests.length === 1 ? { delta: '', done: true, toolCalls: [call] } : { delta: 'Answer.', done: true };
    };
    await collect(streamWithLocalSearch({ ...opts, reasoningEffort }, invoke));
    expect(requests[0]?.reasoningEffort).toBe(reasoningEffort === 'off' ? 'off' : 'low');
    expect(requests[0]?.maxOutputTokens).toBe(1024);
    expect(requests[1]?.reasoningEffort).toBe(reasoningEffort);
    expect(requests[1]?.maxOutputTokens).toBe(opts.maxOutputTokens);
  });
  it('passes through untouched with search off', async () => {
    const invoke = vi.fn(async function* () { yield { delta: 'No search', done: true }; });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const options = { ...opts, webSearch: false };
    expect(await collect(streamWithLocalSearch(options, invoke))).toEqual([{ delta: 'No search', done: true }]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(options);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps images and app tools, searches once, and emits only cited evidence', async () => {
    const fetcher = vi.fn().mockResolvedValue(results({ results: [
      { url: 'https://source.test/a', title: 'Source', content: 'Relevant excerpt.' },
      { url: 'https://source.test/unused', title: 'Unused', content: 'Other excerpt.' },
    ] }));
    vi.stubGlobal('fetch', fetcher);
    const requests: StreamChatOpts[] = [];
    const appTool = { name: 'recall', description: 'Recall a conversation', parameters: {} };
    const invoke = async function* (request: StreamChatOpts): AsyncIterable<ChatChunk> {
      requests.push(request);
      if (requests.length === 1) {
        yield { delta: 'Hidden planning text.', done: false };
        yield { delta: '', done: true, toolCalls: [call], providerResponse: [{ type: 'reasoning.text', text: 'continuation' }] };
      } else {
        yield { delta: 'Answer [source](https://source.test/a)', done: false };
        yield { delta: '', done: true, toolCalls: [{ id: 'recall-1', name: 'recall', arguments: '{}' }] };
      }
    };
    const options = { ...opts, imageInputs: [{ id: 'img', url: 'https://image.test/a.png' }], tools: [appTool] };
    const out = await collect(streamWithLocalSearch(options, invoke));
    expect(fetcher).toHaveBeenCalledOnce(); expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['scatter_web_search']);
    expect(requests[1]?.tools).toEqual([appTool]);
    for (const request of requests) {
      expect(request.conversation?.[0]?.role).toBe('system');
      expect(request.conversation?.filter((message) => message.role === 'system')).toHaveLength(1);
      expect(request.conversation?.find((message) => message.role === 'user')?.images).toEqual(options.imageInputs);
    }
    expect(out.map((chunk) => chunk.delta).join('')).toBe('Answer [source](https://source.test/a)');
    expect(out.flatMap((chunk) => chunk.citations ?? [])).toEqual([expect.objectContaining({ url: 'https://source.test/a', content: 'Relevant excerpt.' })]);
    expect(out.some((chunk) => chunk.webSearch?.used && chunk.webSearch.requestCount === 1)).toBe(true);
    expect(out.at(-1)?.toolCalls?.[0]?.name).toBe('recall');
  });
  it('refuses a missing tool call, multiple calls, or malformed arguments without searching', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const toolCalls of [[], [call, call], [{ ...call, arguments: 'not json' }], [{ ...call, arguments: '{"query":""}' }]]) {
      const invoke = async function* () { yield { delta: '', done: true, toolCalls }; };
      await expect(collect(streamWithLocalSearch(opts, invoke))).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not continue into search or answering after cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const invoke = vi.fn(async function* () { controller.abort(); yield { delta: '', done: true, toolCalls: [call] }; });
    await expect(collect(streamWithLocalSearch({ ...opts, signal: controller.signal }, invoke))).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('works through the real compatible adapter without sending its API key to search', async () => {
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(sse({ tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: call.arguments } }] }))
      .mockResolvedValueOnce(results())
      .mockResolvedValueOnce(sse({ content: '{"evidence":[{"url":"https://source.test/a"}]}' }));
    vi.stubGlobal('fetch', fetcher);
    const chunks = await collect(openaiCompatibleAdapter.streamChat('private-model-key', opts, 'https://model.test/v1'));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer private-model-key');
    expect(JSON.stringify(fetcher.mock.calls[1])).not.toContain('private-model-key');
    expect(chunks.flatMap((chunk) => chunk.citations ?? [])).toHaveLength(1);
  });
});
