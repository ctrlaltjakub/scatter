/** Opt-in live regression diagnostic. The model override is only for the
 * Gemini model explicitly reported by the user; the normal suite is offline. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMessages } from './promptBuilder';
import { DEFAULT_SETTINGS } from '@/store/types';

describe.skipIf(process.env.SCATTER_REAL_NODE_SMOKE !== '1')('live node output budget', () => {
  it('checks the actual completion status and reports reasoning/output use', async () => {
    const keyPath = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((path) => resolve(path)).find(existsSync);
    if (!keyPath) throw new Error('The approved OpenRouter test key is unavailable.');
    const model = process.env.SCATTER_NODE_SMOKE_MODEL ?? 'google/gemini-3.5-flash';
    const cap = Number(process.env.SCATTER_NODE_SMOKE_CAP ?? DEFAULT_SETTINGS.outputTokenCap);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${readFileSync(keyPath, 'utf8').trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: cap, reasoning: { effort: 'high', exclude: true },
        provider: { sort: 'latency' },
        messages: buildMessages({ variant: { kind: 'root', topic: 'How does working memory differ from long-term memory?' },
          context: { parent: null, grandparent: null } }) }),
      signal: AbortSignal.timeout(120_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Provider diagnostic failed: HTTP ${response.status}`);
    const choice = data.choices?.[0];
    console.log(JSON.stringify({ model, cap, finishReason: choice?.finish_reason, usage: data.usage,
      visibleCharacters: choice?.message?.content?.length,
      body: process.env.SCATTER_SMOKE_SHOW_BODY === '1' ? choice?.message?.content : undefined }, null, 2));
    expect(choice?.message?.content?.trim()).toBeTruthy();
    if (process.env.SCATTER_EXPECT_COMPLETE === '1') expect(choice?.finish_reason).toBe('stop');
  }, 125_000);
});
