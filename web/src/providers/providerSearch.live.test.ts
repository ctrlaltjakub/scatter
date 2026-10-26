/** Opt-in local search audit. Requires an explicitly configured local model and
 * SearXNG instance. No cloud API keys or paid requests are used by this test.
 * SCATTER_LOCAL_SEARCH_AUDIT=ollama|lm-studio npx vitest run src/providers/providerSearch.live.test.ts
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getAdapter } from './registry';
import type { ChatChunk, StreamChatOpts } from './types';

const preset = process.env.SCATTER_LOCAL_SEARCH_AUDIT;
const root = process.env.SCATTER_PROVIDER_TEST_DIR ?? join(homedir(), '.local/share/scatter-provider-tests/2026-10-12');

it.skipIf(!['ollama', 'lm-studio'].includes(preset ?? ''))('round-trips real search results through the local adapter and obeys search off', async () => {
  const provider = preset as 'ollama' | 'lm-studio';
  const base = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1';
  const model = process.env.SCATTER_LOCAL_MODEL ?? 'qwen3.5:2b';
  const search = process.env.SCATTER_LOCAL_SEARCH_ENDPOINT ?? 'http://127.0.0.1:8891';
  const adapter = getAdapter(provider);
  const reports = join(root, 'results', `${provider}-local-search-${Date.now()}`);
  await mkdir(reports, { recursive: true, mode: 0o700 });
  const nativeFetch = globalThis.fetch;
  const requests: Record<string, unknown>[] = [], observations: Promise<void>[] = [];
  const outcome: Record<string, unknown> = { provider, model };
  let searchRequests = 0, modelRequests = 0;
  const save = () => writeFile(join(reports, 'report.json'), JSON.stringify({ ...outcome, requests }, null, 2), { mode: 0o600 });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (![new URL(base).origin, new URL(search).origin].includes(url.origin)) throw new Error('Audit blocked an unexpected network destination.');
    const isSearch = url.origin === new URL(search).origin;
    if (isSearch) searchRequests++;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (body.messages && ++modelRequests > 4) throw new Error('Local audit request ceiling reached.');
    const request: Record<string, unknown> = { url: url.href, model: body.model, maxTokens: body.max_tokens,
      reasoning: body.reasoning_effort, tools: body.tools?.map((t: { function?: { name?: string } }) => t.function?.name), started: Date.now() };
    request.suppliedSourceUrls = (body.messages ?? []).flatMap((message: { role: string; content: string }) => {
      if (message.role !== 'tool') return [];
      try { return (JSON.parse(message.content).results ?? []).map((source: { url: string }) => source.url); }
      catch { return []; }
    });
    requests.push(request);
    const response = await nativeFetch(input, init);
    request.status = response.status;
    observations.push(response.clone().text().then(raw => {
      request.ms = Date.now() - Number(request.started);
      if (isSearch) {
        const data = JSON.parse(raw);
        request.results = data.results?.slice(0, 5).map((r: { title: string; url: string }) => ({ title: r.title, url: r.url }));
        request.unresponsiveEngines = data.unresponsive_engines;
      } else if (body.messages) {
        const events = raw.split('\n').filter(line => line.startsWith('data:')).flatMap(line => { try { return [JSON.parse(line.slice(5))]; } catch { return []; } });
        request.finish = events.flatMap(e => e.choices?.flatMap((c: { finish_reason?: string }) => c.finish_reason ? [c.finish_reason] : []) ?? []);
        request.usage = events.flatMap(e => e.usage ? [e.usage] : []);
        request.reasoningText = events.map(e => e.choices?.[0]?.delta?.reasoning || e.choices?.[0]?.delta?.reasoning_content || '').join('').slice(-2000);
        request.toolCalls = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? []);
      }
    }));
    await save();
    return response;
  };
  try {
    const catalog = await adapter.listModels('local-test', base);
    const modelInfo = catalog.find(m => m.id === model);
    expect(modelInfo?.caps?.tools).toBe(true);
    outcome.modelInfo = modelInfo;
    const collect = async (opts: Partial<StreamChatOpts>) => {
      const chunks: ChatChunk[] = [];
      for await (const chunk of adapter.streamChat('local-test', { model, modelInfo, messages: [],
        maxOutputTokens: 2048, reasoningEffort: 'off', webSearch: false, webSearchEndpoint: search,
        signal: AbortSignal.timeout(180000), ...opts }, base)) chunks.push(chunk);
      return { text: chunks.map(c => c.delta).join(''), citations: chunks.flatMap(c => c.citations ?? []),
        usedSearch: chunks.some(c => c.webSearch?.used), finish: chunks.at(-1)?.finishReason };
    };
    outcome.searchOff = await collect({ messages: [{ role: 'user', content: 'Reply with exactly READY.' }], maxOutputTokens: 128 });
    expect(searchRequests).toBe(0);
    expect((outcome.searchOff as { text: string }).text).toContain('READY');
    await save();
    const prompt = process.env.SCATTER_SEARCH_PROMPT ?? 'Search the web for "lunar eclipse". Explain what casts the shadow in a lunar eclipse in two sentences and cite a search result with a link.';
    outcome.prompt = prompt;
    const on = await collect({ webSearch: true, messages: [{ role: 'user', content: prompt }] });
    outcome.searchOn = on;
    expect(searchRequests).toBe(1);
    expect(on.usedSearch).toBe(true);
    expect(requests.some(request => Array.isArray(request.suppliedSourceUrls) && request.suppliedSourceUrls.length > 0)).toBe(true);
    expect(on.text.trim()).not.toBe('');
    // This audit checks the connection architecture, not whether a small test
    // model follows every citation instruction. Keep that as diagnostic data.
    outcome.answerDiagnostics = { citedSources: on.citations.length, finish: on.finish };
    outcome.status = 'pass';
  } catch (error) {
    outcome.status = 'fail'; outcome.error = String(error); throw error;
  } finally {
    globalThis.fetch = nativeFetch;
    await Promise.allSettled(observations); await save();
    console.log(`${provider}: search audit ${outcome.status}; evidence: ${reports}/report.json`);
  }
}, 420000);
