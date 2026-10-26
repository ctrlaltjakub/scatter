import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter, streamChatCompat } from './openai';
import { anthropicAdapter } from './anthropic';

const stream = (events: unknown[]) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  },
}));
afterEach(() => vi.unstubAllGlobals());

describe('observable interactive generation activity', () => {
  it('reports Responses reasoning and code-writing phases while retaining tool size limits', async () => {
    const request = vi.fn(async () => stream([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call', name: 'write_document', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"html":"code"}' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', call_id: 'call', name: 'write_document', arguments: '{"html":"code"}' },
      ] } },
    ]));
    vi.stubGlobal('fetch', request);
    const onActivity = vi.fn(); const chunks = [];
    const opts = { model: 'gpt-6.1-sol', messages: [], maxOutputTokens: 100,
      tools: [{ name: 'write_document', description: 'Write', parameters: { type: 'object' } }], onActivity };
    for await (const chunk of openaiAdapter.streamChat('test', opts)) chunks.push(chunk);
    expect(onActivity.mock.calls.map(([a]) => a)).toEqual([{ phase: 'waiting' }, { phase: 'reasoning' }, { phase: 'tool', tool: 'write_document' }]);
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('write_document');
    const consume = async () => { for await (const chunk of openaiAdapter.streamChat('test', { ...opts, toolArgumentLimits: { write_document: 5 } })) void chunk; };
    await expect(consume()).rejects.toThrow('oversized tool call');
  });
  it('reports compatible-provider reasoning and code calls without exposing reasoning content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      { choices: [{ delta: { reasoning: 'Private model text' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'write_document', arguments: '{"html":"code"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])));
    const onActivity = vi.fn(); const chunks = [];
    for await (const chunk of streamChatCompat('test', { model: 'future-model', messages: [], maxOutputTokens: 100, onActivity }, 'https://fixture.invalid')) chunks.push(chunk);
    expect(onActivity.mock.calls.map(([a]) => a)).toEqual([{ phase: 'waiting' }, { phase: 'reasoning' }, { phase: 'tool', tool: 'write_document' }]);
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('Private model text');
    expect(chunks.map(c => c.delta).join('')).toBe('');
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('write_document');
  });
  it('reports native Anthropic thinking and tool phases', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Private model text' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'write_document', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"html":"code"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])));
    const onActivity = vi.fn(); const chunks = [];
    for await (const chunk of anthropicAdapter.streamChat('test', { model: 'future-model', messages: [], maxOutputTokens: 100, onActivity })) chunks.push(chunk);
    expect(onActivity.mock.calls.map(([a]) => a)).toEqual([{ phase: 'waiting' }, { phase: 'reasoning' }, { phase: 'tool', tool: 'write_document' }]);
    expect(JSON.stringify(onActivity.mock.calls)).not.toContain('Private model text');
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('write_document');
  });
});
