// Opt-in, localhost only. Never use a cloud key for this test.
import { describe, expect, it } from 'vitest';
import { lmStudioAdapter } from './localModels';
import type { ChatChunk, StreamChatOpts } from './types';
const enabled = process.env.SCATTER_LOCAL_SEARCH_TEST === '1';
describe.skipIf(!enabled)('live LM Studio installed search tool', () => {
  it('runs server-managed search and preserves an explicit Off request', async () => {
    const key = process.env.SCATTER_LOCAL_SEARCH_TOKEN;
    if (!key) throw new Error('Set a temporary local-server token first.');
    const base = 'http://127.0.0.1:1234/v1', model = 'scatter-local-test';
    const info = (await lmStudioAdapter.listModels(key, base)).find(m => m.id === model);
    expect(info?.caps?.tools).toBe(true);
    const opts: StreamChatOpts = { model, modelInfo: info, messages: [{ role: 'user', content: 'Search once for NASA lunar eclipse. Give one short fact and a Markdown link to a returned source.' }],
      maxOutputTokens: 1200, reasoningEffort: 'off', webSearch: true, allowUnverifiedCapabilities: true,
      serverSearch: { kind: 'lmstudio-mcp', server: 'scatter-search-test', tools: ['searxng_web_search'] }, signal: AbortSignal.timeout(120000) };
    const searched: ChatChunk[] = [];
    for await (const c of lmStudioAdapter.streamChat(key, opts, base)) searched.push(c);
    expect(searched.some(c => c.webSearch?.used === true)).toBe(true);
    expect(searched.at(-1)?.done).toBe(true);
    expect(searched.map(c => c.delta).join('')).toMatch(/https?:\/\//);
    const off: ChatChunk[] = [];
    for await (const c of lmStudioAdapter.streamChat(key, { ...opts, webSearch: false, messages: [{ role: 'user', content: 'Do not search. Reply with exactly READY.' }] }, base)) off.push(c);
    expect(off.some(c => c.webSearch?.used)).toBe(false);
    expect(off.map(c => c.delta).join('')).toContain('READY');
  }, 150000);
});
