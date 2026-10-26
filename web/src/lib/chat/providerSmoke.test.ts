/** Opt-in paid smoke check: SCATTER_REAL_CHAT_SMOKE=1 npx vitest run
 * src/lib/chat/providerSmoke.test.ts. Never runs in the normal suite. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openrouterAdapter } from '@/providers/openrouter';
import { useSettingsStore } from '@/store/useSettingsStore';
import { runChatToolLoop, type ChatTool } from './toolRuntime';
import { chatFactUnits } from './markdown';

describe.skipIf(process.env.SCATTER_REAL_CHAT_SMOKE !== '1')('real chat provider smoke', () => {
  it('streams a real tool call, replays its native state, and renders valid Markdown afterward', async () => {
    const keyPath = ['../.agents/skills/openrouter-test/openrouter.key', '../.Codex/skills/openrouter-test/openrouter.key']
      .map((path) => resolve(path)).find(existsSync);
    if (!keyPath) throw new Error('The approved OpenRouter test key is unavailable.');
    const apiKey = readFileSync(keyPath, 'utf8').trim();
    useSettingsStore.setState({ openRouterRouting: 'fast-start' });
    let calls = 0, text = '';
    const activities: string[] = [];
    const recall: ChatTool = {
      definition: { name: 'search_conversation', description: 'Read the earlier user message from this conversation.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
      parse: (value) => value,
      summary: () => 'Searching earlier messages',
      execute: async () => { calls++; return { text: 'Earlier user message: My study-session code is KESTREL-42. This is only a fictional label, not a password.', summary: 'Found one earlier passage' }; },
    };
    await runChatToolLoop({
      messages: [{ role: 'system', content: 'You are testing a learning chat. For missing conversation details use search_conversation. Do not guess. After the tool result, answer with a two-column Markdown table (Field | Value) containing the session code and its purpose. No code fences.' },
        { role: 'user', content: 'What study-session code did I choose earlier, and what was it for?' }],
      tools: [recall], signal: AbortSignal.timeout(90_000),
      invoke: (conversation, tools) => openrouterAdapter.streamChat(apiKey, {
        model: 'google/gemini-3.5-flash', conversation, tools, messages: [],
        maxOutputTokens: 1800, reasoningEffort: 'low', webSearch: false,
        signal: AbortSignal.timeout(60_000),
      }),
      onChunk: (chunk) => { text += chunk.delta; },
      onActivity: (activity) => activities.push(activity.state),
    });
    expect(calls).toBe(1);
    expect(activities).toEqual(['running', 'complete']);
    expect(text).toContain('KESTREL-42');
    expect(chatFactUnits(text).some((unit) => unit.id.startsWith('chat-row:')), text).toBe(true);
    expect(text).not.toContain('reasoning.encrypted');
  }, 100_000);
});
