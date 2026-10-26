/** Opt-in paid test; uses the real editable prompt. Normal test runs make no requests. */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { buildFollowUpClassifierPrompt } from './promptBuilder';

it.skipIf(process.env.SCATTER_FOLLOWUP_EVAL !== '1')('routes representative requests with the real secondary model', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  for (const [question, expected] of [
    ['Tell me about cognitive therapy', 'explore'],
    ['Why does this kind of therapy help change negative thoughts?', 'explain'],
    ['Help me write an email asking a therapist for an appointment', 'chat'],
    ['Write a Python program that illustrates this process', 'chat'],
    ['How should I choose between two therapists for my own anxiety?', 'chat'],
  ]) {
    const system = buildFollowUpClassifierPrompt({ question: question!, context: {
      parent: { header: 'Cognitive therapy', body: 'Cognitive therapy helps people identify and change unhelpful patterns of thinking.' }, grandparent: null,
    } });
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-3.5-flash', max_tokens: 512,
        reasoning: { effort: 'low', exclude: true }, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] }),
      signal: AbortSignal.timeout(45_000),
    });
    expect(response.ok, `HTTP ${response.status}`).toBe(true);
    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim();
    console.log(JSON.stringify({ question, answer, cost: data.usage?.cost }));
    expect(answer).toBe(expected);
  }
}, 240_000);
