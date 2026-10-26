import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiAdapter, openaiCompatibleAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { openrouterAdapter } from './openrouter';
import type { ChatChunk, ProviderConversationMessage, TextToolDefinition } from './types';
import { INTERACTIVE_TOOL_ARGUMENT_LIMITS } from '@/lib/interactiveDocument';

const tool: TextToolDefinition = { name: 'search_conversation', description: 'Recall a passage',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
function response(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    controller.close();
  } }));
}
async function collect(iter: AsyncIterable<ChatChunk>) { const values = []; for await (const value of iter) values.push(value); return values; }
afterEach(() => vi.unstubAllGlobals());
describe('native chat tool transport', () => {
  it.each([
    ['OpenRouter', openrouterAdapter], ['OpenAI', openaiAdapter], ['local/custom', openaiCompatibleAdapter],
  ] as const)('receives interactive programs larger than the ordinary chat-tool limit through %s', async (_name, adapter) => {
    const html = '<!doctype html><html><body>' + '<button>Count</button>\n'.repeat(1500) + '</body></html>';
    const argumentsJson = JSON.stringify({ html });
    const events: unknown[] = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: { name: 'write_document', arguments: '' } }] } }] }];
    for (let offset = 0; offset < argumentsJson.length; offset += 4096) {
      events.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argumentsJson.slice(offset, offset + 4096) } }] } }] });
    }
    events.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    const request = vi.fn().mockResolvedValue(response(events));
    vi.stubGlobal('fetch', request);
    const chunks = await collect(adapter.streamChat('test', {
      model: 'fixture/model', messages: [], maxOutputTokens: 32_000,
      tools: [{ name: 'write_document', description: 'Save program code', parameters: { type: 'object' } }],
      toolArgumentLimits: INTERACTIVE_TOOL_ARGUMENT_LIMITS,
    }));
    expect(JSON.parse(chunks.at(-1)?.toolCalls?.[0]?.arguments ?? '{}')).toEqual({ html });
    const body = JSON.parse(request.mock.calls[0]![1].body);
    expect(body[adapter === openaiAdapter ? 'max_completion_tokens' : 'max_tokens']).toBe(32_000);
    expect(body).not.toHaveProperty('toolArgumentLimits');
    expect(body.tools[0].function).not.toHaveProperty('toolArgumentLimits');
  });
  it('receives large native Anthropic code calls with the same program content', async () => {
    const html = '<!doctype html><html><body>' + '<button>Count</button>\n'.repeat(1500) + '</body></html>';
    const argumentsJson = JSON.stringify({ html });
    const events: unknown[] = [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'write', name: 'write_document', input: {} } }];
    for (let offset = 0; offset < argumentsJson.length; offset += 4096) {
      events.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: argumentsJson.slice(offset, offset + 4096) } });
    }
    events.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(events)));
    const chunks = await collect(anthropicAdapter.streamChat('test', {
      model: 'fixture', messages: [], maxOutputTokens: 32_000,
      tools: [{ name: 'write_document', description: 'Save program code', parameters: { type: 'object' } }],
      toolArgumentLimits: INTERACTIVE_TOOL_ARGUMENT_LIMITS,
    }));
    expect(JSON.parse(chunks.at(-1)?.toolCalls?.[0]?.arguments ?? '{}')).toEqual({ html });
  });
  it('keeps OpenAI Responses signed output with the exact tool result on continuation', async () => {
    const output = [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque' },
      { type: 'function_call', id: 'fc', call_id: 'call', name: tool.name, arguments: '{"query":"memory"}' }];
    const request = vi.fn().mockResolvedValueOnce(response([{ type: 'response.completed', response: { status: 'completed', output } }]))
      .mockResolvedValueOnce(response([{ type: 'response.output_text.delta', delta: 'A reply.' }, { type: 'response.completed', response: { status: 'completed' } }]));
    vi.stubGlobal('fetch', request);
    const base = { model: 'gpt-5.5', messages: [], tools: [tool], maxOutputTokens: 1000, webSearch: true };
    const first = await collect(openaiAdapter.streamChat('test', { ...base, conversation: [{ role: 'user', content: 'Recall' }] }));
    expect(first.at(-1)?.toolCalls?.[0]?.id).toBe('call');
    expect(first.at(-1)?.providerResponse).toEqual(output);
    const conversation: ProviderConversationMessage[] = [{ role: 'assistant', content: '', providerContent: first.at(-1)?.providerResponse },
      { role: 'tool', content: 'Earlier passage', toolCallId: 'call' }];
    await collect(openaiAdapter.streamChat('test', { ...base, conversation }));
    const body = JSON.parse(request.mock.calls[1]![1].body);
    expect(body.input).toEqual([...output, { type: 'function_call_output', call_id: 'call', output: 'Earlier passage' }]);
    expect(body.store).toBe(false);
  });
  it('reconstructs Anthropic signed thinking and fragmented tool input without exposing thinking', async () => {
    const request = vi.fn().mockResolvedValue(response([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hidden' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: tool.name, input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"memory"}' } },
      { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
    ]));
    vi.stubGlobal('fetch', request);
    const chunks = await collect(anthropicAdapter.streamChat('test', { model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Recall' }], tools: [tool], maxOutputTokens: 1800 }));
    expect(chunks.map((chunk) => chunk.delta).join('')).toBe('');
    expect(chunks.at(-1)?.toolCalls?.[0]).toMatchObject({ id: 'call', arguments: '{"query":"memory"}' });
    expect(chunks.at(-1)?.providerResponse?.[0]).toEqual({ type: 'thinking', thinking: 'Hidden', signature: 'signed' });
  });
  it('joins OpenRouter tool and reasoning fragments and requires compatible routes', async () => {
    const request = vi.fn().mockResolvedValue(response([
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'First ', index: 0 }], tool_calls: [{ index: 0, id: 'call', function: { name: tool.name, arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'thought', index: 0 }], tool_calls: [{ index: 0, function: { arguments: '"memory"}' } }] }, finish_reason: 'tool_calls' }] },
    ]));
    vi.stubGlobal('fetch', request);
    const chunks = await collect(openrouterAdapter.streamChat('test', { model: 'google/gemini-3.5-flash',
      messages: [{ role: 'user', content: 'Recall' }], tools: [tool], maxOutputTokens: 1800 }));
    expect(chunks.at(-1)?.toolCalls?.[0]?.arguments).toBe('{"query":"memory"}');
    expect(chunks.at(-1)?.providerResponse).toEqual([{ type: 'reasoning.summary', summary: 'First thought', index: 0 }]);
    expect(JSON.parse(request.mock.calls[0]![1].body).provider.require_parameters).toBe(true);
  });
  it('does not swallow a mid-stream Anthropic error after visible partial text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Partial' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Provider overloaded' } },
    ])));
    await expect(collect(anthropicAdapter.streamChat('test', { model: 'claude-sonnet-4-6', messages: [], maxOutputTokens: 100 }))).rejects.toThrow('Provider overloaded');
  });
});
