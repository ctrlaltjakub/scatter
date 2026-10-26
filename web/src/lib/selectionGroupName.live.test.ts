/** Opt-in paid smoke test. No network calls in the normal suite.
 * SCATTER_GROUP_NAME_EVAL=1 npx vitest run src/lib/selectionGroupName.live.test.ts */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseSelectionGroupName, SELECTION_GROUP_NAME_SYSTEM } from './selectionGroupName';

it.skipIf(process.env.SCATTER_GROUP_NAME_EVAL !== '1')('generates concise names from real model output', async () => {
  const key = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  for (const headers of [
    ['Exposure therapy', 'Cognitive restructuring', 'Behavioral activation'],
    ['Binary search', 'Merge sort', 'Hash table'],
  ]) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-3.5-flash', max_tokens: 256,
        reasoning: { effort: 'low', exclude: true }, messages: [
          { role: 'system', content: SELECTION_GROUP_NAME_SYSTEM },
          { role: 'user', content: JSON.stringify({ headers }) },
        ] }),
      signal: AbortSignal.timeout(45_000),
    });
    expect(response.ok, `HTTP ${response.status}`).toBe(true);
    const result = await response.json() as { choices: { message: { content: string }; finish_reason: string }[]; usage?: { cost?: number } };
    expect(result.choices[0]?.finish_reason).not.toBe('length');
    const name = parseSelectionGroupName(result.choices[0]!.message.content);
    console.log(JSON.stringify({ headers, name, cost: result.usage?.cost }));
    expect(name.split(' ').length).toBeGreaterThanOrEqual(2);
  }
}, 100_000);
