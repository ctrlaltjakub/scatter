import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiCompatibleAdapter } from './openai';
import type { ChatChunk, StreamChatOpts } from './types';

const opts: StreamChatOpts = { model: 'local', messages: [{ role: 'user', content: 'Search for a fact.' }], maxOutputTokens: 3000,
  webSearch: true, allowUnverifiedCapabilities: true, reasoningEffort: 'off',
  modelInfo: { id: 'local', caps: { reasoning: true }, reasoning: { supportedEfforts: ['off', 'high'], mode: 'toggle' } },
  serverSearch: { kind: 'lmstudio-mcp', server: 'search', tools: ['web_search'] } };
const sse = (text = 'A fact [source](https://source.test/a).') => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
const native = (extra: unknown = undefined) => new Response(JSON.stringify({ output: extra ?? [
  { type: 'reasoning', content: 'Never show this.' },
  { type: 'tool_call', tool: 'web_search', output: '[{"type":"text","text":"Source: https://source.test/a Facts."}]', provider_info: { plugin_id: 'mcp/search' } },
  { type: 'message', content: 'Do not use a generated summary as evidence.' },
] }));
async function collect(stream: AsyncIterable<ChatChunk>) { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; }
afterEach(() => vi.unstubAllGlobals());
describe('server-managed search', () => {
  it('defaults an empty LM Studio tool allowlist to searxng_web_search', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(native([
      { type: 'tool_call', tool: 'searxng_web_search', output: 'https://source.test/a Facts.', provider_info: { plugin_id: 'mcp/search' } },
    ])).mockResolvedValueOnce(sse());
    vi.stubGlobal('fetch', fetcher);
    const chunks = await collect(openaiCompatibleAdapter.streamChat('local-token', { ...opts,
      serverSearch: { kind: 'lmstudio-mcp', server: 'search', tools: [] } }, 'http://localhost:1234/v1'));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).integrations[0].allowed_tools).toEqual(['searxng_web_search']);
    expect(chunks.some(chunk => chunk.webSearch?.used)).toBe(true);
  });
  it('uses installed LM Studio MCP, preserves app tools/images, and confirms actual search', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(native()).mockResolvedValueOnce(sse()); vi.stubGlobal('fetch', fetcher);
    const out = await collect(openaiCompatibleAdapter.streamChat('local-token', { ...opts, tools: [{ name: 'recall', description: 'Recall', parameters: {} }], imageInputs: [{ id: 'sample', url: 'data:image/png;base64,AAAA' }] }, 'http://localhost:1234/proxy/v1'));
    expect(fetcher.mock.calls[0]![0]).toBe('http://localhost:1234/proxy/api/v1/chat');
    const first = JSON.parse(fetcher.mock.calls[0]![1].body), last = JSON.parse(fetcher.mock.calls[1]![1].body);
    expect(first).toMatchObject({ store: false, reasoning: 'off', integrations: [{ type: 'plugin', id: 'mcp/search', allowed_tools: ['web_search'] }] });
    expect(last.tools[0].function.name).toBe('recall');
    expect(JSON.stringify(last)).toContain('data:image/png;base64,AAAA');
    expect(JSON.stringify(last)).not.toContain('Never show this');
    expect(JSON.stringify(last)).not.toContain('Do not use a generated summary');
    expect(out.some(c => c.webSearch?.used)).toBe(true);
    expect(out.flatMap(c => c.citations ?? [])).toMatchObject([{ url: 'https://source.test/a' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sends no search integration or search request when Off', async () => {
    const fetcher = vi.fn().mockResolvedValue(sse('No search.')); vi.stubGlobal('fetch', fetcher);
    await collect(openaiCompatibleAdapter.streamChat('local-token', { ...opts, webSearch: false }, 'http://localhost:1234/v1'));
    expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0]![0]).toContain('/v1/chat/completions');
    expect(JSON.stringify(fetcher.mock.calls[0]![1])).not.toContain('integrations');
  });
  it('reports permission failures with the actual setup remedy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"Permission denied to use plugin"}', { status: 403 })));
    await expect(collect(openaiCompatibleAdapter.streamChat('key', opts, 'http://localhost:1234/v1'))).rejects.toThrow('mcp.json');
  });
  it.each([[], [{ type: 'invalid_tool_call' }], [{ type: 'tool_call', tool: 'web_search', output: '{"isError":true}', provider_info: { plugin_id: 'mcp/search' } }]].map(output => ({ output })))('does not pretend a failed search succeeded', async ({ output }) => {
    const fetcher = vi.fn().mockResolvedValue(native(output)); vi.stubGlobal('fetch', fetcher);
    await expect(collect(openaiCompatibleAdapter.streamChat('key', opts, 'http://localhost:1234/v1'))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('only enables named LocalAI servers while search is on', async () => {
    const fetcher = vi.fn().mockImplementation(() => sse()); vi.stubGlobal('fetch', fetcher);
    for (const webSearch of [false, true]) await collect(openaiCompatibleAdapter.streamChat('key', { ...opts, serverSearch: { kind: 'localai', servers: ['search'] }, webSearch }, 'http://localhost:8080/v1'));
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).metadata).toBeUndefined();
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).metadata).toEqual({ mcp_servers: 'search' });
  });
  it('rejects an interrupted compatibility stream instead of returning success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Cut off"}}]}\n\n')));
    await expect(collect(openaiCompatibleAdapter.streamChat('key', { ...opts, webSearch: false }, 'http://localhost:1234/v1'))).rejects.toThrow('ended');
  });
  it('exposes only allowlisted remote MCP tools through Responses, and omits them with search off', async () => {
    const events = [
      { type: 'response.output_item.done', item: { type: 'mcp_call', status: 'completed', output: 'https://source.test/a' } },
      { type: 'response.output_text.delta', delta: 'A fact [source](https://source.test/a).' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ];
    const fetcher = vi.fn().mockImplementation(() => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')));
    vi.stubGlobal('fetch', fetcher);
    const remote = { ...opts, serverSearch: { kind: 'responses-mcp' as const, url: 'https://search.test/mcp', tools: ['search'] } };
    const result = await collect(openaiCompatibleAdapter.streamChat('key', remote, 'http://localhost:1234/v1'));
    const on = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(fetcher.mock.calls[0]![0]).toBe('http://localhost:1234/v1/responses');
    expect(on).toMatchObject({ store: false, tools: [{ type: 'mcp', allowed_tools: ['search'], require_approval: 'never', server_url: 'https://search.test/mcp' }] });
    expect(result.some(c => c.webSearch?.used)).toBe(true);
    await collect(openaiCompatibleAdapter.streamChat('key', { ...remote, webSearch: false }, 'http://localhost:1234/v1'));
    expect(JSON.parse(fetcher.mock.calls[1]![1].body).tools).toEqual([]);
  });
  it('reports remote MCP failures, approval requirements and incomplete Responses streams', async () => {
    const remote = { ...opts, serverSearch: { kind: 'responses-mcp' as const, url: 'https://search.test/mcp', tools: ['search'] } };
    for (const event of [
      { type: 'response.mcp_call.failed' },
      { type: 'response.output_item.done', item: { type: 'mcp_approval_request' } },
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'other' } } },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`)));
      await expect(collect(openaiCompatibleAdapter.streamChat('key', remote, 'http://localhost:1234/v1'))).rejects.toThrow();
    }
  });
});
