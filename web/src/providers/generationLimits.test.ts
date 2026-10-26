import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter, parseCompatModel, streamChatCompat } from './openai';
import { anthropicAdapter, parseAnthropicModel } from './anthropic';

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const event = url.includes('/responses') ? { type: 'response.completed', response: { output: [], status: 'completed' } }
    : url.includes('anthropic') ? { type: 'message_stop' } : null;
  return new Response(`data: ${event ? JSON.stringify(event) : '[DONE]'}\n\n`);
})));
afterEach(() => vi.unstubAllGlobals());
const body = () => JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));

describe('provider output limits', () => {
  it('reads provider metadata without guessing unknown future models', () => {
    expect(parseCompatModel({ id: 'future', top_provider: { max_completion_tokens: 8192 } }).maxOutputTokens).toBe(8192);
    expect(parseCompatModel({ id: 'local', max_output_tokens: 16384 }).maxOutputTokens).toBe(16384);
    expect(parseCompatModel({ id: 'unknown' }).maxOutputTokens).toBeUndefined();
    expect(parseAnthropicModel({ id: 'future', max_tokens: 64000 }).maxOutputTokens).toBe(64000);
  });
  it('caps compatible API and native Responses requests at the reported maximum', async () => {
    const options = { model: 'gpt-5.5', messages: [], maxOutputTokens: 32000, modelInfo: { id: 'gpt-5.5', maxOutputTokens: 8192 } };
    for await (const chunk of streamChatCompat('fixture', options, 'https://fixture.invalid')) void chunk;
    expect(body().max_tokens).toBe(8192);
    for await (const chunk of openaiAdapter.streamChat('fixture', { ...options, webSearch: true })) void chunk;
    expect(body().max_output_tokens).toBe(8192);
  });
  it.each(['adaptive', 'budget'] as const)('keeps %s thinking inside the configured/reported ceiling', async mode => {
    for await (const chunk of anthropicAdapter.streamChat('fixture', {
      model: 'future', messages: [], maxOutputTokens: 32000, reasoningEffort: 'high',
      modelInfo: { id: 'future', maxOutputTokens: 4096, caps: { reasoning: true }, reasoning: { mode, supportedEfforts: ['high'] } },
    })) void chunk;
    expect(body().max_tokens).toBe(4096);
    if (mode === 'budget') expect(body().thinking).toEqual({ type: 'enabled', budget_tokens: 3072 });
    else expect(body().thinking).toEqual({ type: 'adaptive' });
  });
});
