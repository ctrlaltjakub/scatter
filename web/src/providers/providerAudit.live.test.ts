/** Explicitly opt-in live provider audit. Secrets and results live outside the repository.
 * SCATTER_PROVIDER_AUDIT=preflight npx vitest run src/providers/providerAudit.live.test.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { getAdapter } from './registry';
import type { ModelInfo, StreamChatOpts } from './types';
import type { ProviderPreset } from '@/store/types';
import { runChatToolLoop } from '@/lib/chat/toolRuntime';
import { FACT_CHECK_SEARCH_POLICY } from '@/lib/factCheckRequest';

const root = process.env.SCATTER_PROVIDER_TEST_DIR ?? join(homedir(), '.local/share/scatter-provider-tests/2026-10-12');
const enabled = process.env.SCATTER_PROVIDER_AUDIT === 'preflight';
const results: Record<string, unknown>[] = [];
const configs: { preset: ProviderPreset; main: string; secondary: string; base?: string }[] = [
  { preset: 'openai', main: 'gpt-6.1-sol', secondary: 'gpt-6-luna' },
  { preset: 'anthropic', main: 'claude-opus-5-5', secondary: 'claude-sonnet-5-5' },
];

describe.skipIf(!enabled)('approved live provider preflight', () => {
  for (const config of configs.filter(c => !process.env.SCATTER_AUDIT_PROVIDER || c.preset === process.env.SCATTER_AUDIT_PROVIDER)) it(`${config.preset}: catalog, text, tools, and hosted search`, async () => {
    const secrets = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
    const key = secrets[config.preset];
    const redact = (s: string) => Object.values(secrets).reduce<string>((t, value) => t.replaceAll(String(value), '[REDACTED]'), s);
    const adapter = getAdapter(config.preset);
    const catalog = await adapter.listModels(key, config.base);
    const info = (id: string): ModelInfo | undefined => catalog.find(m => m.id === id);
    const run = async (action: string, fn: () => Promise<unknown>) => {
      const started = Date.now();
      let result: Record<string, unknown>;
      try { result = { provider: config.preset, action, status: 'pass', details: await fn() }; }
      catch (error) { result = { provider: config.preset, action, status: 'fail', error: redact(String(error)) }; }
      result.ms = Date.now() - started;
      results.push(result);
      await mkdir(join(root, 'results'), { recursive: true, mode: 0o700 });
      await writeFile(join(root, `results/preflight-${config.preset}-${Date.now()}.json`), redact(JSON.stringify(results, null, 2)), { mode: 0o600 });
      console.log(JSON.stringify(result));
      return result.status === 'pass';
    };
    const invoke = (model: string, options: Partial<StreamChatOpts> = {}) => adapter.streamChat(key, {
      model, modelInfo: info(model), messages: [{ role: 'user', content: 'Reply with exactly: READY' }],
      maxOutputTokens: 2048, reasoningEffort: 'low', webSearch: false,
      signal: AbortSignal.timeout(90000), ...options,
    }, config.base);
    const collect = async (model: string, opts: Partial<StreamChatOpts> = {}) => {
      let text = ''; let finish: string | undefined; let citations = 0; let usedSearch = false;
      for await (const chunk of invoke(model, opts)) {
        text += chunk.delta; finish = chunk.finishReason ?? finish;
        citations += chunk.citations?.length ?? 0; usedSearch ||= !!chunk.webSearch?.used;
      }
      if (!text.trim()) throw new Error('No visible text returned.');
      return { text, finish, citations, usedSearch };
    };
    await run('catalog', async () => {
      expect(info(config.main)).toBeDefined(); expect(info(config.secondary)).toBeDefined();
      return { count: catalog.length, main: info(config.main), secondary: info(config.secondary) };
    });
    const mainWorks = await run('main-text', () => collect(config.main));
    await run('secondary-text', () => collect(config.secondary));
    if (mainWorks) await run('chat-tool-roundtrip', async () => {
      let calls = 0, text = '';
      await runChatToolLoop({
        messages: [{ role: 'system', content: 'Retrieve the missing study code with search_conversation; do not guess. Then return the code.' },
          { role: 'user', content: 'What study code did I choose earlier?' }],
        tools: [{ definition: { name: 'search_conversation', description: 'Retrieve an earlier study code.', parameters: {
          type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
        } }, parse: value => value, summary: () => 'Retrieving study code', execute: async () => {
          calls++; return { text: 'The fictional study code is KESTREL-42.', summary: 'Retrieved code' };
        } }],
        signal: AbortSignal.timeout(90000),
        invoke: (conversation, tools) => invoke(config.main, { messages: [], conversation, tools }),
        onChunk: chunk => { text += chunk.delta; },
        onActivity: () => {},
      });
      expect(calls).toBe(1); expect(text).toContain('KESTREL-42');
      return { calls, text };
    });
    await run('hosted-web-search', async () => {
      const output = await collect(config.main, { webSearch: true, webSearchPolicy: FACT_CHECK_SEARCH_POLICY,
        maxOutputTokens: 4096, messages: [{ role: 'user', content: 'Use web search once to find the official NASA page explaining a lunar eclipse. Give one factual sentence and cite the page.' }] });
      expect(output.usedSearch).toBe(true); expect(output.citations).toBeGreaterThan(0);
      return output;
    });
    expect(results.filter(result => result.provider === config.preset && result.status === 'fail')).toEqual([]);
  }, 420000);
});
