import type { ProviderConversationMessage, StreamChatOpts, TextToolCall } from './types';
import { anthropicImageSource } from './multimodal';

export function providerMessages(opts: StreamChatOpts): ProviderConversationMessage[] {
  if (opts.conversation) return opts.conversation;
  const messages: ProviderConversationMessage[] = opts.messages.map((message) => ({ ...message }));
  const lastUser = messages.findLast((message) => message.role === 'user');
  if (lastUser && opts.imageInputs?.length) lastUser.images = opts.imageInputs;
  return messages;
}

export function compatConversation(messages: ProviderConversationMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') return {
      role: 'tool', content: message.content, tool_call_id: message.toolCallId,
    };
    return {
      role: message.role,
      content: message.images?.length ? [
        { type: 'text', text: message.content },
        ...message.images.flatMap((image) => [
          { type: 'text', text: `${image.id}:` },
          { type: 'image_url', image_url: { url: image.url, detail: image.detail ?? 'auto' } },
        ]),
      ] : message.content,
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments } })),
      } : {}),
      ...(message.providerContent?.length ? { reasoning_details: message.providerContent } : {}),
    };
  });
}

export function anthropicConversation(messages: ProviderConversationMessage[]) {
  const output: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.providerContent ?? (message.role === 'tool' ? [{
      type: 'tool_result', tool_use_id: message.toolCallId,
      content: message.content, ...(message.toolError ? { is_error: true } : {}),
    }] : [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...(message.images ?? []).flatMap((image) => [
        { type: 'text', text: `${image.id}:` },
        { type: 'image', source: anthropicImageSource(image.url) },
      ]),
      ...(message.toolCalls ?? []).map((call) => ({ type: 'tool_use', id: call.id,
        name: call.name, input: JSON.parse(call.arguments) as unknown })),
    ]);
    const previous = output.at(-1);
    // Parallel results belong in ONE immediate user message with no intervening
    // text blocks. Merge adjacent same-role messages without losing order.
    if (previous?.role === role) previous.content.push(...content);
    else output.push({ role, content: [...content] });
  }
  return output;
}

export function responsesConversation(messages: ProviderConversationMessage[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    if (message.role === 'system') return [];
    if (message.providerContent) return message.providerContent;
    if (message.role === 'tool') return [{ type: 'function_call_output',
      call_id: message.toolCallId, output: message.content }];
    const output: unknown[] = [];
    if (message.content || message.images?.length) output.push({ role: message.role,
      content: message.images?.length ? [
        { type: 'input_text', text: message.content },
        ...message.images.flatMap((image) => [
          { type: 'input_text', text: `${image.id}:` },
          { type: 'input_image', image_url: image.url, detail: image.detail ?? 'auto' },
        ]),
      ] : message.content });
    for (const call of message.toolCalls ?? []) output.push({ type: 'function_call',
      call_id: call.id, name: call.name, arguments: call.arguments });
    return output;
  });
}

/** Bounded stream accumulator. An index is a stream-local slot, not an ID. */
export class ToolCallAccumulator {
  private calls = new Map<number, TextToolCall>();
  constructor(private readonly argumentLimits: Readonly<Record<string, number>> = {}) {}
  private argumentLimit(name: string, partialName: boolean): number {
    const exact = Object.hasOwn(this.argumentLimits, name) ? this.argumentLimits[name] : undefined;
    if (typeof exact === 'number' && Number.isSafeInteger(exact) && exact > 0) return exact;
    let limit = 16_384;
    // A provider may split the function name as well as its arguments. Allow
    // only matching prefixes while streaming; finish() checks the final name.
    if (partialName) for (const [tool, value] of Object.entries(this.argumentLimits)) {
      if (tool.startsWith(name) && Number.isSafeInteger(value) && value > 0) limit = Math.max(limit, value);
    }
    return limit;
  }
  add(value: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): void {
    const index = value.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('Too many tool calls.');
    const previous = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
    const next = { id: value.id ?? previous.id, name: previous.name + (value.function?.name ?? ''),
      arguments: previous.arguments + (value.function?.arguments ?? '') };
    if (next.name.length > 128 || next.id.length > 256 || next.arguments.length > this.argumentLimit(next.name, true)) {
      throw new Error('The model returned an oversized tool call.');
    }
    this.calls.set(index, next);
  }
  finish(): TextToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
      if (!call.id || !call.name) throw new Error('The model returned an incomplete tool call.');
      if (call.arguments.length > this.argumentLimit(call.name, false)) throw new Error('The model returned an oversized tool call.');
      return call;
    });
  }
}

/** Reconstruct consecutive textual reasoning deltas for native tool replay.
 * Encrypted blocks are discrete signed payloads and must stay untouched. */
export class ReasoningDetailAccumulator {
  private details: Record<string, unknown>[] = [];
  private bytes = 0;
  add(values: unknown[]): void {
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const detail = value as Record<string, unknown>;
      this.bytes += JSON.stringify(detail).length;
      if (this.bytes > 2_000_000) throw new Error('The provider returned oversized reasoning metadata.');
      const previous = this.details.at(-1);
      const field = detail.type === 'reasoning.text' ? 'text' : detail.type === 'reasoning.summary' ? 'summary' : null;
      const same = previous && previous.type === detail.type
        && (detail.id == null || previous.id == null || detail.id === previous.id)
        && (detail.index == null || previous.index == null || detail.index === previous.index);
      if (field && same) {
        const combined = String(previous[field] ?? '') + String(detail[field] ?? '');
        Object.assign(previous, Object.fromEntries(Object.entries(detail).filter(([, v]) => v != null)));
        previous[field] = combined;
      } else this.details.push({ ...detail });
    }
  }
  finish(): unknown[] | undefined { return this.details.length ? this.details : undefined; }
}
