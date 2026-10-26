import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { anthropicAdapter } from './anthropic';
import { FACT_CHECK_SEARCH_POLICY } from '@/lib/factCheckRequest';

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('anthropicAdapter.listModels', () => {
  it('returns the data array from /v1/models', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }] }),
    });
    const models = await anthropicAdapter.listModels('sk-ant-test');
    expect(models.map(m => m.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
  });

  it('sends the required Anthropic headers', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await anthropicAdapter.listModels('sk-ant-test');
    const callArgs = fetchMock.mock.calls[0]!;
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('throws on non-2xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key',
    });
    await expect(anthropicAdapter.listModels('sk-bad')).rejects.toThrow(/key was rejected/i);
  });
});

describe('anthropicAdapter.streamChat', () => {
  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    });
  }
  const completedStream = () => sseStream(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);

  it('parses Anthropic SSE deltas and yields text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });
    const out: string[] = [];
    let done = false;
    for await (const chunk of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    })) {
      out.push(chunk.delta);
      if (chunk.done) done = true;
    }
    expect(out.join('')).toBe('Hello world');
    expect(done).toBe(true);
  });

  it('extracts the system message and sends it as the top-level system field', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      body: completedStream(),
    });
    const iter = anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      maxOutputTokens: 600,
    });
    // consume the iterator
    for await (const _ of iter) { void _; }
    const callArgs = fetchMock.mock.calls[0]!;
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body.system).toBe('You are a helpful assistant.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(body.model).toBe('claude-opus-4-7');
    expect(body.max_tokens).toBe(600);
    expect(body.stream).toBe(true);
  });

  it('sends labelled URL image blocks in the final user turn', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: completedStream() });
    for await (const _ of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'Choose from the visible images.' }],
      maxOutputTokens: 300,
      imageInputs: [{ id: 'image-1', url: 'https://example.org/one.jpg' }],
    })) { void _; }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'image-1:' },
        { type: 'image', source: { type: 'url', url: 'https://example.org/one.jpg' } },
        { type: 'text', text: 'Choose from the visible images.' },
      ],
    }]);
  });

  it('sends uploaded images as base64 sources for both ordinary and tool conversations', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async () => ({ ok: true, body: completedStream() }));
    const image = { id: 'uploaded', url: 'data:image/png;base64,aGVsbG8=' };
    for (const conversation of [undefined, [{ role: 'user' as const, content: 'Read it', images: [image] }]]) {
      for await (const chunk of anthropicAdapter.streamChat('test', {
        model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Read it' }],
        imageInputs: [image], conversation, maxOutputTokens: 1024,
      })) void chunk;
    }
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(init.body);
      expect(body.messages[0].content).toContainEqual({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      });
    }
  });

  it('adds web_search tool to request body when webSearch=true', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      body: completedStream(),
    });
    const iter = anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      maxOutputTokens: 600,
      webSearch: true,
    });
    for await (const _ of iter) { void _; }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('keeps extended reasoning while web search remains automatic', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: sseStream(['event: message_stop\ndata: {"type":"message_stop"}\n\n']) });
    for await (const _ of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Latest?' }],
      maxOutputTokens: 600, webSearch: true, reasoningEffort: 'low',
    })) { void _; }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it.each(['claude-opus-5-5', 'claude-sonnet-4-6', 'unknown-future-model'])('keeps fact-check search portable for %s', async model => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: completedStream() } as Response);
    for await (const chunk of anthropicAdapter.streamChat('test-only', {
      model, messages: [{ role: 'user', content: 'Search before checking this fact.' }], maxOutputTokens: 2400,
      webSearch: true, webSearchPolicy: FACT_CHECK_SEARCH_POLICY,
    })) void chunk;
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes successful search usage and web-search citation deltas', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://example.com","title":"Example"}]}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Fresh claim"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com","title":"Example","cited_text":"Source claim"}}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"server_tool_use":{"web_search_requests":1}}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });
    const chunks = [];
    for await (const chunk of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Latest?' }], maxOutputTokens: 600, webSearch: true,
    })) chunks.push(chunk);
    expect(chunks.map((c) => c.delta).join('')).toBe('Fresh claim');
    expect(chunks.some((c) => c.webSearch?.used && c.webSearch.requestCount === 1)).toBe(true);
    expect(chunks.flatMap((c) => c.citations ?? [])).toEqual([{
      url: 'https://example.com', title: 'Example', content: 'Source claim', startIndex: 0, endIndex: 11,
      offsetKind: 'claim',
    }]);
  });

  it('surfaces an in-body search error without discarding a later usable answer', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":{"type":"web_search_tool_result_error","error_code":"unavailable"}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Fallback answer"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });
    const chunks = [];
    for await (const chunk of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Latest?' }], maxOutputTokens: 600, webSearch: true,
    })) chunks.push(chunk);
    expect(chunks.map((c) => c.delta).join('')).toBe('Fallback answer');
    expect(chunks.some((c) => c.webSearch?.error === 'unavailable' && !c.webSearch.used)).toBe(true);
  });

  it('continues a pause_turn with the unchanged assistant content blocks', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce({ ok: true, body: sseStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[]}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"server_tool_use":{"web_search_requests":1}}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]) })
      .mockResolvedValueOnce({ ok: true, body: sseStream([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Continued answer"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]) });
    const chunks = [];
    for await (const chunk of anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'Latest?' }], maxOutputTokens: 600, webSearch: true,
    })) chunks.push(chunk);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondBody.messages.at(-1)).toEqual({ role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
    ] });
    expect(chunks.map((c) => c.delta).join('')).toBe('Continued answer');
    expect(chunks.filter((c) => c.done)).toHaveLength(1);
  });

  it('omits tools when webSearch is false or missing', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      body: completedStream(),
    });
    const iter = anthropicAdapter.streamChat('sk-ant', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 100,
    });
    for await (const _ of iter) { void _; }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toBeUndefined();
  });

  const bodyOf = async (model: string, reasoningEffort: 'off' | 'low' | 'medium' | 'high', maxOutputTokens = 600) => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: completedStream() });
    const iter = anthropicAdapter.streamChat('sk-ant', {
      model, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens, reasoningEffort,
    });
    for await (const _ of iter) { void _; }
    return JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
  };

  it('uses adaptive thinking without silently raising the chosen output ceiling', async () => {
    const body = await bodyOf('claude-opus-4-8', 'high', 600);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.max_tokens).toBe(600);
  });

  it('does not enable thinking on a non-thinking model', async () => {
    const body = await bodyOf('claude-3-5-haiku', 'high', 600);
    expect(body.thinking).toBeUndefined();
    expect(body.max_tokens).toBe(600);
  });

  it('uses the lowest supported effort when a saved Off choice is not available', async () => {
    const body = await bodyOf('claude-opus-4-8', 'off', 600);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens).toBe(600);
  });

  it('also exposes capabilities.webSearch = true', () => {
    expect(anthropicAdapter.capabilities.webSearch).toBe(true);
  });
});
