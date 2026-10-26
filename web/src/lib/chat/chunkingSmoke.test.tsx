/** Opt-in paid prompt/render check; never runs during the normal test suite. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { openrouterAdapter } from '@/providers/openrouter';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { chatSystemPrompt } from './context';
import { appendChatAnswer, createChatNode, updateChatAnswer } from './model';

describe.skipIf(process.env.SCATTER_REAL_CHUNKING_SMOKE !== '1')('real chat chunking', () => {
  it('renders several short bold anchors per sentence, including list items and table cells', async () => {
    const keyPath = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((path) => resolve(path)).find(existsSync);
    if (!keyPath) throw new Error('The approved OpenRouter test key is unavailable.');
    const key = readFileSync(keyPath, 'utf8').trim();
    let body = '';
    for await (const chunk of openrouterAdapter.streamChat(key, {
      model: 'google/gemini-3.5-flash', messages: [
        { role: 'system', content: chatSystemPrompt(true, '', false) },
        { role: 'user', content: 'Explain how working memory differs from long-term memory. Keep this short: two prose sentences, two one-sentence bullets, then a two-column table with two rows. Each table row should have a short label and one explanatory sentence. No introduction or conclusion beyond that.' },
      ], maxOutputTokens: 3200, reasoningEffort: 'low', webSearch: false, signal: AbortSignal.timeout(100_000),
    })) body += chunk.delta;
    let node = createChatNode({ id: 'smoke', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    node = appendChatAnswer(node, { turnId: 'turn', createdAt: 2, question: 'Memory systems' });
    node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: 2 }, { body }, { state: 'complete' });
    const { container } = render(<ChatMarkdown nodeId="smoke" version={node.versions.at(-1)!} />);
    const sentences = [...container.querySelectorAll('.sc-ab-sentence')]
      .filter((element) => (element.textContent ?? '').trim().split(/\s+/).length >= 8);
    const counts = sentences.map((element) => element.querySelectorAll('strong').length);
    console.info('Rendered chunking smoke:', JSON.stringify({ body, boldAnchorsPerSentence: counts }));
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('ul,ol')).not.toBeNull();
    expect(sentences.length).toBeGreaterThanOrEqual(5);
    // The prompt targets 2–3 anchors. A two-sided comparison can reasonably
    // produce four; this live check catches missing/single-anchor rendering,
    // rather than treating a stochastic one-anchor variation as a UI bug.
    expect(counts.every((count) => count >= 2 && count <= 4)).toBe(true);
    expect(container.textContent).not.toContain('**');
  }, 110_000);
});
