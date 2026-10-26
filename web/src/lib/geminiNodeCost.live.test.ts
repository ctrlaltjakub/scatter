/** Opt-in, paid measurement of one standard node with Scatter's search policy. */
import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { buildMessages } from './promptBuilder';
import { markTerms } from './termMarking';
import { completeTermPreviews, previewTerms } from './termPreviewCore';
import type { NodeVersion } from '@/store/types';

it.skipIf(process.env.SCATTER_GEMINI_COST !== '1')('measures Gemini 3.8 Flash node text and web search', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  const messages = buildMessages({ variant: { kind: 'root', topic: 'Operating systems' }, context: { parent: null, grandparent: null } });
  messages[messages.length - 1]!.content += '\n\nGround this response in web search before writing, and cite sources beside the claims they support. Use Wikipedia as a grounding source when relevant, alongside primary or authoritative sources where appropriate. Do not invent bare bracketed source names or numbered references; use only citation links backed by the returned search results.';
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'google/gemini-3.8-flash', messages, max_tokens: 8000,
      reasoning: { effort: 'low' }, provider: { sort: 'latency' },
      tools: [{ type: 'openrouter:web_search', parameters: { engine: 'exa', max_results: 5, max_total_results: 5, max_characters: 2000 } }],
      max_tool_calls: 1 }),
    signal: AbortSignal.timeout(120_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data.error));
  await writeFile('/tmp/scatter-gemini-node-cost.json', JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ id: data.id, usage: data.usage, finish: data.choices?.[0]?.finish_reason,
    characters: data.choices?.[0]?.message?.content?.length, annotations: data.choices?.[0]?.message?.annotations?.length }));
  expect(data.choices?.[0]?.finish_reason).toBe('stop');
  expect(data.choices?.[0]?.message?.content?.length).toBeGreaterThan(1000);
}, 130_000);

it.skipIf(process.env.SCATTER_GEMINI_SECONDARY_COST !== '1')('measures Luna marking and previews for the recorded Gemini node', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  const primary = JSON.parse(await readFile('/tmp/scatter-gemini-node-cost.json', 'utf8'));
  const previous = process.env.SCATTER_GEMINI_PREVIEW_RETRY === '1'
    ? JSON.parse(await readFile('/tmp/scatter-gemini-secondary-cost.json', 'utf8')) : undefined;
  const calls: Array<{ stage: string; usage: Record<string, unknown> }> = [];
  let stage = 'marking';
  const complete = async (request: { system: string; user: string; maxOutputTokens?: number }) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-5.6-luna', reasoning: { effort: 'low', exclude: true },
        max_tokens: request.maxOutputTokens ?? 8000,
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data.error));
    calls.push({ stage, usage: data.usage });
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('The secondary model reached its output limit.');
    return data.choices?.[0]?.message?.content ?? '';
  };
  const marked = previous ? { body: primary.choices[0].message.content }
    : await markTerms(primary.choices[0].message.content, AbortSignal.timeout(180_000), complete);
  const version: NodeVersion = { header: 'Operating systems', body: marked.body, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic' };
  const terms = previous?.failed ?? previewTerms(version);
  const entries: Record<string, string> = {};
  stage = 'previews';
  const failed = await completeTermPreviews(version, terms, complete, data => Object.assign(entries, data));
  const report = { primary: primary.usage, terms: previous?.terms ?? terms.length,
    accepted: (previous?.accepted ?? 0) + Object.keys(entries).length, failed,
    calls: [...(previous?.calls ?? []), ...calls],
    ...(previous ? { firstAttempt: { accepted: previous.accepted, failed: previous.failed }, refocusRetryCalls: calls.length } : {}) };
  await writeFile('/tmp/scatter-gemini-secondary-cost.json', JSON.stringify(report, null, 2));
  expect(failed).toEqual([]);
}, 600_000);
