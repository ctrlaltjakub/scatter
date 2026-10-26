import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openaiAdapter, openaiCompatibleAdapter } from './openai';
import { FACT_CHECK_SEARCH_POLICY } from '@/lib/factCheckRequest';

const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

describe('openaiAdapter.listModels', () => {
  it('returns the data array from /v1/models', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }] }),
    });
    const models = await openaiAdapter.listModels('sk-test');
    expect(models.map(m => m.id)).toEqual(['gpt-5.5', 'gpt-5.4-mini']);
  });
  it('throws on non-2xx', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => 'bad key',
    });
    await expect(openaiAdapter.listModels('sk-bad')).rejects.toThrow(/key was rejected/i);
  });
});

describe('openaiAdapter.streamChat', () => {
  function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    });
  }

  it('uses the current direct-OpenAI token limit without changing compatible providers', async () => {
    const mocked = fetch as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(async () => ({ ok: true, body: sseStream(['data: [DONE]\n\n']) }));
    for (const adapter of [openaiAdapter, openaiCompatibleAdapter]) {
      for await (const chunk of adapter.streamChat('test', { model: 'gpt-6-luna',
        messages: [{ role: 'user', content: 'Test' }], maxOutputTokens: 2048 })) void chunk;
    }
    const bodies = mocked.mock.calls.map(call => JSON.parse(call[1].body));
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 2048 });
    expect(bodies[0].max_tokens).toBeUndefined();
    expect(bodies[1]).toMatchObject({ max_tokens: 2048 });
    expect(bodies[1].max_completion_tokens).toBeUndefined();
  });

  it('uses Responses for GPT-6 tools without enabling search, including the final tool-less round', async () => {
    const mocked = fetch as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementation(async () => ({ ok: true, body: sseStream([
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ]) }));
    const common = { model: 'gpt-6.1-sol', messages: [], maxOutputTokens: 2048, webSearch: false };
    for await (const c of openaiAdapter.streamChat('test', { ...common, tools: [{ name: 'read_document',
      description: 'Read', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }] })) void c;
    for await (const c of openaiAdapter.streamChat('test', { ...common, tools: [], conversation: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_document', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call', content: 'Document' },
    ] })) void c;
    for (const [url, init] of mocked.mock.calls) {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(JSON.parse(init.body).tools.some((tool: { type: string }) => tool.type === 'web_search')).toBe(false);
    }
  });

  it('preserves optional tool arguments instead of forcing an invalid strict schema', async () => {
    const mocked = fetch as unknown as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValue({ ok: true, body: sseStream([
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
    ]) });
    const parameters = { type: 'object', properties: { actions: { type: 'array', items: {
      type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } },
      required: ['selector'], additionalProperties: false,
    } } }, required: [], additionalProperties: false };
    for await (const c of openaiAdapter.streamChat('test', { model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: 'Check' }], maxOutputTokens: 1024,
      tools: [{ name: 'check_document', description: 'Check', parameters }],
    })) void c;
    expect(JSON.parse(mocked.mock.calls[0]![1].body).tools[0]).toMatchObject({ strict: false, parameters });
  });

  it('parses SSE deltas and yields text', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    const out: string[] = [];
    let done = false;
    for await (const chunk of openaiAdapter.streamChat('sk', {
      model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100,
    })) {
      out.push(chunk.delta);
      if (chunk.done) done = true;
    }
    expect(out.join('')).toBe('Hello world');
    expect(done).toBe(true);
  });

  it('throws when a mid-stream chunk carries an API error (e.g. a 504 timeout)', async () => {
    // OpenRouter delivers some errors mid-stream with HTTP 200 (e.g. a web-search
    // timeout). These must surface, not be swallowed into an empty result.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"error":{"message":"The operation was aborted","code":504}}\n\n',
      ]),
    });
    await expect((async () => {
      for await (const _ of openaiAdapter.streamChat('sk', {
        model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100,
      })) { void _; }
    })()).rejects.toThrow(/aborted/);
  });

  it('keeps Chat Completions and omits search options when webSearch is off', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const empty = () => ({ ok: true, body: sseStream(['data: [DONE]\n\n']) });

    fetchMock.mockResolvedValue(empty());
    for await (const _ of openaiAdapter.streamChat('sk', {
      model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100,
    })) { void _; }
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).web_search_options).toBeUndefined();
  });

  it('sends labelled image URLs in the final user turn for visual assessment', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: sseStream(['data: [DONE]\n\n']) });
    for await (const _ of openaiAdapter.streamChat('sk', {
      model: 'gpt-5',
      messages: [{ role: 'system', content: 'Judge pixels only.' }, { role: 'user', content: 'Choose.' }],
      maxOutputTokens: 100,
      imageInputs: [{ id: 'image-1', url: 'https://example.org/one.jpg', detail: 'low' }],
    })) { void _; }
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages).toEqual([
      { role: 'system', content: 'Judge pixels only.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'image-1:' },
          { type: 'image_url', image_url: { url: 'https://example.org/one.jpg', detail: 'low' } },
          { type: 'text', text: 'Choose.' },
        ],
      },
    ]);
  });

  it('uses the Responses API with required web search for a supported current model', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: sseStream(['data: {"type":"response.completed","response":{"status":"completed"}}\n\n']) });
    for await (const _ of openaiAdapter.streamChat('sk', {
      model: 'gpt-5.5',
      messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Latest?' }],
      maxOutputTokens: 700,
      webSearch: true,
      reasoningEffort: 'high',
    })) { void _; }
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'gpt-5.5',
      instructions: 'System',
      input: [{ role: 'user', content: 'Latest?' }],
      max_output_tokens: 700,
      stream: true,
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      max_tool_calls: 1,
      reasoning: { effort: 'high' },
    });
  });

  it.each([false, true])('uses portable fact-check search with hosted or MCP tools (MCP=%s)', async mcp => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, body: sseStream(['data: {"type":"response.completed","response":{"status":"completed"}}\n\n']) } as Response);
    for await (const chunk of openaiAdapter.streamChat('test-only', {
      model: 'gpt-5.5', messages: [{ role: 'user', content: 'Search before checking this fact.' }], maxOutputTokens: 2400,
      webSearch: true, webSearchPolicy: FACT_CHECK_SEARCH_POLICY,
      ...(mcp ? { serverSearch: { kind: 'responses-mcp' as const, url: 'https://example.org/mcp', tools: ['web_search'] } } : {}),
    })) void chunk;
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(body.tool_choice).toBe('auto');
    expect(body.max_tool_calls).toBe(1);
    expect(body.tools).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('normalizes Responses streaming text, successful search, and url citations', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: sseStream([
        'data: {"type":"response.web_search_call.completed","item_id":"ws_1"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Fresh answer"}\n\n',
        'data: {"type":"response.output_text.annotation.added","annotation":{"type":"url_citation","url":"https://example.com/x","title":"Example","start_index":0,"end_index":12}}\n\n',
        'data: {"type":"response.completed","response":{"status":"completed","usage":{"server_tool_use":{"web_search_requests":1}}}}\n\n',
      ]),
    });
    const chunks = [];
    for await (const chunk of openaiAdapter.streamChat('sk', {
      model: 'gpt-5.5', messages: [{ role: 'user', content: 'Latest?' }], maxOutputTokens: 100, webSearch: true,
    })) chunks.push(chunk);
    expect(chunks.map((c) => c.delta).join('')).toBe('Fresh answer');
    expect(chunks.some((c) => c.webSearch?.used && c.webSearch.requestCount === 1)).toBe(true);
    expect(chunks.flatMap((c) => c.citations ?? [])).toEqual([{
      url: 'https://example.com/x', title: 'Example', startIndex: 0, endIndex: 12,
      offsetKind: 'citation-label',
    }]);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  it('skips web_search_options on a non-search model even when webSearch is on', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: sseStream(['data: [DONE]\n\n']) });
    for await (const _ of openaiAdapter.streamChat('sk', {
      model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, webSearch: true,
    })) { void _; }
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).web_search_options).toBeUndefined();
  });

  const bodyOf = async (model: string, reasoningEffort: 'off' | 'low' | 'medium' | 'high') => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: true, body: sseStream(['data: [DONE]\n\n']) });
    for await (const _ of openaiAdapter.streamChat('sk', {
      model, messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 100, reasoningEffort,
    })) { void _; }
    return JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
  };

  it('sends reasoning_effort only on a reasoning model', async () => {
    expect((await bodyOf('o3', 'high')).reasoning_effort).toBe('high');
    expect((await bodyOf('gpt-5.1', 'low')).reasoning_effort).toBe('low');
    // gpt-4o is NOT a reasoning model — sending reasoning_effort would 400, so omit.
    expect((await bodyOf('gpt-4o', 'high')).reasoning_effort).toBeUndefined();
  });

  it('uses the lowest supported effort when a saved Off choice is not available', async () => {
    expect((await bodyOf('o3', 'off')).reasoning_effort).toBe('low');
  });
});
