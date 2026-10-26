import { describe, expect, it } from 'vitest';
import { anthropicConversation, compatConversation, providerMessages, responsesConversation, ToolCallAccumulator, ReasoningDetailAccumulator } from './conversation';
import type { ProviderConversationMessage } from './types';

const messages: ProviderConversationMessage[] = [
  { role: 'user', content: 'Earlier image', images: [{ id: 'parent-v1', url: 'data:image/png;base64,YQ==' }] },
  { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'call-1', name: 'search_conversation', arguments: '{"query":"Go"}' }] },
  { role: 'tool', toolCallId: 'call-1', content: 'Earlier passage' },
  { role: 'user', content: 'A newer question' },
];

describe('provider conversation translation', () => {
  it('joins textual reasoning deltas but preserves encrypted blocks verbatim', () => {
    const detail = new ReasoningDetailAccumulator();
    detail.add([{ type: 'reasoning.summary', summary: 'First ', index: 0, id: 'r' }]);
    detail.add([{ type: 'reasoning.summary', summary: 'thought.', index: 0 }]);
    detail.add([{ type: 'reasoning.text', text: 'Signed thought', index: 1, signature: null }]);
    detail.add([{ type: 'reasoning.text', signature: 'signature', index: 1 }]);
    const encrypted = { type: 'reasoning.encrypted', data: 'opaque', id: 'enc', index: 2 };
    detail.add([encrypted, { ...encrypted, id: 'enc2' }]);
    expect(detail.finish()).toEqual([
      { type: 'reasoning.summary', summary: 'First thought.', index: 0, id: 'r' },
      { type: 'reasoning.text', text: 'Signed thought', index: 1, signature: 'signature' },
      encrypted, { ...encrypted, id: 'enc2' },
    ]);
  });
  it('keeps historical images attached to their original turn', () => {
    const translated = compatConversation(messages) as Array<Record<string, unknown>>;
    expect(translated[0]?.content).toEqual(expect.arrayContaining([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'auto' } },
    ]));
    expect(translated[3]?.content).toBe('A newer question');
    expect(translated[2]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'Earlier passage' });
  });
  it('uses Anthropic base64 images and immediate tool result blocks', () => {
    const translated = anthropicConversation(messages);
    expect(translated[0]?.content).toContainEqual({ type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } });
    expect(translated[1]?.content).toContainEqual({ type: 'tool_use', id: 'call-1',
      name: 'search_conversation', input: { query: 'Go' } });
    expect(translated[2]?.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call-1', content: 'Earlier passage' });
  });
  it('replays native signed blocks unchanged and without duplication', () => {
    const blocks = [{ type: 'thinking', thinking: 'opaque', signature: 'signature' },
      { type: 'tool_use', id: 'x', name: 'search_conversation', input: { query: 'Go' } }];
    const extended: ProviderConversationMessage[] = [{ role: 'assistant', content: 'not duplicated', providerContent: blocks }];
    expect(anthropicConversation(extended)[0]?.content).toEqual(blocks);
    expect(responsesConversation(extended)).toEqual(blocks);
  });
  it('produces Responses function_call and function_call_output items', () => {
    expect(responsesConversation(messages)).toEqual(expect.arrayContaining([
      { type: 'function_call', call_id: 'call-1', name: 'search_conversation', arguments: '{"query":"Go"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'Earlier passage' },
    ]));
  });
  it('retains the legacy final-user image path without mutating caller data', () => {
    const input = [{ role: 'user' as const, content: 'Question' }];
    const result = providerMessages({ model: 'test', messages: input, maxOutputTokens: 100,
      imageInputs: [{ id: 'image', url: 'https://example.com/image.jpg' }] });
    expect(result[0]?.images).toHaveLength(1);
    expect(input[0]).not.toHaveProperty('images');
  });
  it('assembles interleaved partial JSON calls by index', () => {
    const accumulator = new ToolCallAccumulator();
    accumulator.add({ index: 0, id: 'first', function: { name: 'search_conversation', arguments: '{"query":' } });
    accumulator.add({ index: 1, id: 'second', function: { name: 'search_conversation', arguments: '{"query":"Japan"}' } });
    accumulator.add({ index: 0, function: { arguments: '"Go"}' } });
    expect(accumulator.finish()[0]?.arguments).toBe('{"query":"Go"}');
    expect(accumulator.finish()[1]?.id).toBe('second');
    expect(() => accumulator.add({ index: 9 })).toThrow();
    expect(() => accumulator.add({ index: 0, function: { arguments: 'x'.repeat(17_000) } })).toThrow();
  });
  it('allows a larger configured code call without enlarging ordinary or unknown tools', () => {
    const limits = { write_document: 32_000 };
    const accumulator = new ToolCallAccumulator(limits);
    accumulator.add({ id: 'write', function: { name: 'write_document', arguments: 'x'.repeat(32_000) } });
    expect(accumulator.finish()[0]?.arguments).toHaveLength(32_000);
    expect(() => accumulator.add({ function: { arguments: 'x' } })).toThrow('oversized tool call');
    for (const name of ['search_conversation', 'unknown', 'toString']) {
      expect(() => new ToolCallAccumulator(limits).add({ id: 'other', function: { name, arguments: 'x'.repeat(16_385) } })).toThrow('oversized tool call');
    }
  });
  it('supports fragmented code-tool names but checks the complete name before returning calls', () => {
    const accumulator = new ToolCallAccumulator({ write_document: 32_000 });
    accumulator.add({ id: 'write', function: { name: 'write_', arguments: 'x'.repeat(20_000) } });
    expect(() => accumulator.finish()).toThrow('oversized tool call');
    accumulator.add({ function: { name: 'document', arguments: 'tail' } });
    expect(accumulator.finish()[0]).toMatchObject({ name: 'write_document', arguments: 'x'.repeat(20_000) + 'tail' });
  });
  it.each([NaN, Infinity, -1, 0, 32_000.5])('ignores an invalid tool-argument allowance (%s)', value => {
    const accumulator = new ToolCallAccumulator({ write_document: value });
    expect(() => accumulator.add({ id: 'write', function: { name: 'write_document', arguments: 'x'.repeat(16_385) } })).toThrow('oversized tool call');
  });
  it('retains call-count and identifier bounds with a larger code allowance', () => {
    const limits = { write_document: 200_000 };
    expect(() => new ToolCallAccumulator(limits).add({ index: 8 })).toThrow('Too many tool calls');
    expect(() => new ToolCallAccumulator(limits).add({ id: 'x'.repeat(257), function: { name: 'write_document' } })).toThrow('oversized tool call');
    expect(() => new ToolCallAccumulator(limits).add({ id: 'call', function: { name: 'x'.repeat(129) } })).toThrow('oversized tool call');
  });
});
