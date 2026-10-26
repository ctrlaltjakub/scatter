import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openrouterAdapter } from './openrouter';
import { parseOpenRouterTextEndpoints } from './openrouter';
import { useSettingsStore } from '@/store/useSettingsStore';
import { FACT_CHECK_SEARCH_POLICY } from '@/lib/factCheckRequest';

const ORIG_FETCH = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
  useSettingsStore.setState({ openRouterRouting: 'fast-start' });
});
afterEach(() => { globalThis.fetch = ORIG_FETCH; });

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } });
}
async function drain(iter: AsyncIterable<unknown>) { for await (const _ of iter) { void _; } }

describe('openrouterAdapter', () => {
  it.each(['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1', 'anthropic/claude-mythos-5.1:variant',
    'google/gemini-3.8-flash', 'openai/example-reasoning-model', 'new-vendor/unknown-model'])(
    'uses automatic tool choice for %s without disabling required-search intent', async model => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, body: emptyStream() } as Response);
      await drain(openrouterAdapter.streamChat('test-key', { model, messages: [{ role: 'user', content: 'Search before checking this fact.' }],
        maxOutputTokens: 2400, reasoningEffort: 'low', webSearch: true, webSearchPolicy: FACT_CHECK_SEARCH_POLICY }));
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
      expect(body).toMatchObject({ tool_choice: 'auto', max_tool_calls: 1, reasoning: { effort: 'low' },
        tools: [{ type: 'openrouter:web_search' }] });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('allows automatic web search with the current server tool and plain model id', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      webSearch: true,
    }));
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('google/gemini-2.5-flash');
    expect(body.provider).toEqual({ sort: 'latency' });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.tools).toEqual([{
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        max_results: 5,
        max_total_results: 5,
        max_characters: 2000,
      },
    }]);
    expect(body.tool_choice).toBeUndefined();
    expect(body.max_tool_calls).toBe(1);
    expect((init.headers as Record<string, string>)['X-Title']).toBe('Scatter');
  });

  it('switches every subsequent request to cheapest-provider ordering immediately', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    useSettingsStore.setState({ openRouterRouting: 'lowest-cost' });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.provider).toEqual({ sort: 'price' });
  });

  it('honors an explicit reasoning effort when web search is on', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'google/gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
      webSearch: true,
      reasoningEffort: 'high',
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('google/gemini-2.5-flash');
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('forces one bounded provider-neutral search for required evidence workflows', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'google/gemini-3.6-flash',
      messages: [{ role: 'user', content: 'Fact-check this.' }],
      maxOutputTokens: 500,
      webSearch: true,
      webSearchPolicy: {
        required: true,
        maxToolCalls: 1,
        maxResults: 5,
        maxTotalResults: 10,
        maxCharacters: 5000,
      },
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toBe('required');
    expect(body.max_tool_calls).toBe(1);
    expect(body.tools).toEqual([{
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        max_results: 5,
        max_total_results: 10,
        max_characters: 5000,
      },
    }]);
  });

  it('reports actual web-search usage from the final OpenRouter stream chunk', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"server_tool_use_details":{"web_search_requests":2}}}\n\n'));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, body });
    const chunks = [];
    for await (const chunk of openrouterAdapter.streamChat('or-key', {
      model: 'google/gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'latest research' }],
      maxOutputTokens: 100,
      webSearch: true,
    })) chunks.push(chunk);
    expect(chunks.some((c) => c.webSearch?.used && c.webSearch.requestCount === 2)).toBe(true);
  });

  it('keeps reasoning.exclude and the plain model when webSearch is off', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'openai/gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    }));
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe('openai/gpt-5');
    expect(body.reasoning).toEqual({ exclude: true });
    expect(body.tools).toBeUndefined();
  });

  it('web search off + an explicit effort keeps exclude + that effort', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'x/y', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, reasoningEffort: 'medium',
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reasoning).toEqual({ exclude: true, effort: 'medium' });
  });

  it("'off' disables reasoning (enabled:false)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'x/y', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, reasoningEffort: 'off',
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reasoning).toEqual({ enabled: false });
  });

  it("'off' falls back to minimal hidden reasoning when the model mandates reasoning", async () => {
    // Gemini 3.x answers enabled:false with a 400 "cannot be disabled" (verified
    // live). The adapter retries once with exclude+low so 'Off' degrades instead
    // of failing the whole generation.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({
        ok: false, status: 400, statusText: 'Bad Request',
        text: async () => '{"error":{"message":"Reasoning is mandatory for this endpoint and cannot be disabled."}}',
      })
      .mockResolvedValueOnce({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'google/gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, reasoningEffort: 'off',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).reasoning).toEqual({ enabled: false });
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).reasoning).toEqual({ exclude: true, effort: 'low' });
  });

  it('advertises web-search capability', () => {
    expect(openrouterAdapter.capabilities.webSearch).toBe(true);
  });
  it.each([false, true])('never sends an unsupported effort from search defaults (search=%s)', async (webSearch) => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => ({ ok: true, body: emptyStream() }));
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'test/model', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100,
      webSearch, reasoningEffort: 'off',
      modelInfo: { id: 'test/model', caps: { reasoning: true }, reasoning: { supportedEfforts: ['off', 'high'] } },
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reasoning).toEqual(webSearch ? { effort: 'high' } : { enabled: false });
  });
  it('leaves fixed reasoning models at their provider default, including search', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: emptyStream() });
    await drain(openrouterAdapter.streamChat('or-key', {
      model: 'test/model', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100,
      webSearch: true, reasoningEffort: 'low',
      modelInfo: { id: 'test/model', caps: { reasoning: true }, reasoning: { supportedEfforts: [] } },
    }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reasoning.effort).toBeUndefined();
  });
});

describe('OpenRouter text endpoint metadata', () => {
  it('normalizes endpoint prices and median latency', () => {
    expect(parseOpenRouterTextEndpoints({ data: { endpoints: [{
      provider_name: 'Amazon Bedrock',
      tag: 'amazon-bedrock/us-east-1',
      pricing: { prompt: '0.00000022', completion: '0.00000132', web_search: '0.01' },
      latency_last_30m: { p50: 1104 },
      status: 0,
    }] } })).toEqual([{
      providerName: 'Amazon Bedrock',
      tag: 'amazon-bedrock/us-east-1',
      pricing: { inputPerM: 0.22, outputPerM: 1.32, webSearchPerCall: 0.01 },
      latencyP50Ms: 1104,
      status: 0,
    }]);
  });
});
