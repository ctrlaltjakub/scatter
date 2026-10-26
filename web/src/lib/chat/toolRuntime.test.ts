import { describe, expect, it, vi } from 'vitest';
import { runChatToolLoop, type ChatTool } from './toolRuntime';
import type { ChatChunk, ProviderConversationMessage } from '@/providers/types';
import type { ChatToolActivity } from '@/store/chatTypes';
import { chatFactUnits } from './markdown';

function tool(execute = vi.fn(async () => ({ text: 'Original passage', summary: 'Found one passage' }))) {
  const definition: ChatTool = {
    definition: { name: 'search_conversation', description: 'Search', parameters: {} },
    parse(input) {
      if (!input || typeof input !== 'object' || !('query' in input)) throw new Error('Missing query');
      return input;
    },
    summary: () => 'Searching earlier messages', execute,
  };
  return definition;
}
const call: ChatChunk = { delta: '', done: true,
  toolCalls: [{ id: 'call', name: 'search_conversation', arguments: '{"query":"Go"}' }] };

describe('bounded conversation tool execution', () => {
  it('rebases provider citation offsets after a tool round', async () => {
    const output: ChatChunk[] = [];
    await runChatToolLoop({ messages: [], tools: [tool()], signal: new AbortController().signal,
      onChunk: (chunk) => output.push(chunk), onActivity: () => {},
      async *invoke(_messages, _tools, round) {
        yield round === 0 ? { ...call, delta: 'Looking. ' } : { delta: 'Found.', done: true,
          citations: [{ url: 'https://example.com', startIndex: 0, endIndex: 6 }] };
      } });
    expect(output.at(-1)?.citations?.[0]).toMatchObject({ startIndex: 11, endIndex: 17 });
  });
  it('separates the continued Markdown table from pre-tool prose', async () => {
    let text = '';
    await runChatToolLoop({ messages: [], tools: [tool()], signal: new AbortController().signal,
      onChunk: (chunk) => { text += chunk.delta; }, onActivity: () => {},
      async *invoke(_messages, _tools, round) {
        yield round === 0 ? { ...call, delta: 'Let me look that up.' }
          : { delta: '| Field | Value |\n|---|---|\n| Code | 42 |', done: true };
      } });
    expect(chatFactUnits(text).some((unit) => unit.id === 'chat-row:0:0')).toBe(true);
  });
  it('returns matching results to the model and exposes truthful lifecycle summaries', async () => {
    const activities: ChatToolActivity[] = [];
    const requests: ProviderConversationMessage[][] = [];
    await runChatToolLoop({ messages: [{ role: 'user', content: 'What did we say?' }], tools: [tool()],
      signal: new AbortController().signal, onChunk: () => {}, onActivity: (a) => activities.push(a),
      async *invoke(messages, _tools, round) {
        requests.push(structuredClone(messages));
        yield round === 0 ? call : { delta: 'We discussed Go.', done: true };
      },
    });
    expect(activities.map((a) => a.state)).toEqual(['running', 'complete']);
    expect(requests[1]?.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call', content: 'Original passage' });
    expect(requests[0]).toHaveLength(1);
  });
  it('does not execute unknown tools or malformed inputs', async () => {
    const registered = tool();
    const activities: ChatToolActivity[] = [];
    await runChatToolLoop({ messages: [], tools: [registered], signal: new AbortController().signal,
      onChunk: () => {}, onActivity: (a) => activities.push(a),
      async *invoke(_messages, _tools, round) {
        yield round === 0 ? { ...call, toolCalls: [
          { id: 'bad', name: '__proto__', arguments: '{}' },
          { id: 'json', name: 'search_conversation', arguments: '{' },
        ] } : { delta: 'No exact record.', done: true };
      },
    });
    expect(registered.execute).not.toHaveBeenCalled();
    expect(activities.every((a) => a.state === 'failed')).toBe(true);
  });
  it('cancels an executor that ignores its signal without continuing the model', async () => {
    const controller = new AbortController();
    const activities: ChatToolActivity[] = [];
    let invoked = 0;
    const pending = runChatToolLoop({ messages: [], tools: [tool(vi.fn(() => new Promise(() => {})))],
      signal: controller.signal, onChunk: () => {}, onActivity: (a) => activities.push(a),
      async *invoke() { invoked++; yield call; },
    });
    await vi.waitFor(() => expect(activities).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoked).toBe(1);
    expect(activities.at(-1)?.state).toBe('stopped');
  });
  it('rejects repeated call identities instead of repeating execution', async () => {
    const registered = tool();
    await expect(runChatToolLoop({ messages: [], tools: [registered], signal: new AbortController().signal,
      onChunk: () => {}, onActivity: () => {}, async *invoke() { yield call; },
    })).rejects.toThrow(/identity/);
    expect(registered.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects output truncation instead of marking the answer complete', async () => {
    await expect(runChatToolLoop({ messages: [], tools: [], signal: new AbortController().signal,
      onChunk: () => {}, onActivity: () => {},
      async *invoke() { yield { delta: 'Cut off', done: true, finishReason: 'length' }; },
    })).rejects.toThrow(/output limit/);
  });
});
