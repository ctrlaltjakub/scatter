/** Opt-in, bounded paid diagnosis of provider versus rendered citation positions. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openrouterAdapter } from '@/providers/openrouter';
import { buildSources, extractInlineCitations, placeCitationMarkersReliable } from '@/lib/citations';
import type { Citation } from '@/providers/types';
import { chatSystemPrompt } from './context';

describe.skipIf(process.env.SCATTER_REAL_CHAT_CITATIONS !== '1')('chat citation provider diagnosis', () => {
  it('records original annotation positions alongside displayed marker positions', async () => {
    const keyPath = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((path) => resolve(path)).find(existsSync);
    if (!keyPath) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(keyPath, 'utf8').trim();
    const model = process.env.SCATTER_CITATION_MODEL ?? 'google/gemini-3.5-flash';
    const models = await openrouterAdapter.listModels(key);
    expect(models.some((item) => item.id === model)).toBe(true);
    let body = ''; const citations: Citation[] = [];
    for await (const chunk of openrouterAdapter.streamChat(key, {
      model, messages: [
        { role: 'system', content: chatSystemPrompt(false, '', true) },
        { role: 'user', content: 'How did Carl Jung understand God? Give two short paragraphs (under 180 words total), one on the God-image and Self, another on the numinous. Ground this in web search.' },
      ], maxOutputTokens: 2800, reasoningEffort: 'low', webSearch: true, signal: AbortSignal.timeout(100_000),
    })) { body += chunk.delta; citations.push(...chunk.citations ?? []); }
    const sources = buildSources([...citations, ...extractInlineCitations(body)]);
    const displayed = placeCitationMarkersReliable(body, citations, sources, 'message-end');
    process.stdout.write('Citation diagnosis: ' + JSON.stringify({ model, body, displayed,
      annotations: citations.map((citation) => ({ title: citation.title, start: citation.startIndex, end: citation.endIndex,
        indexedText: body.slice(citation.startIndex ?? 0, citation.endIndex ?? 0), kind: citation.offsetKind })) }) + '\n');
    expect(body.length).toBeGreaterThan(100);
    expect(sources.length).toBeGreaterThan(0);
  }, 110_000);
});
