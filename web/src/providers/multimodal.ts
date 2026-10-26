import type { ChatImageInput } from './types';
import type { ChatMessage } from '@/lib/promptBuilder';

function lastUserIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

/** OpenAI Chat Completions and OpenRouter share this multimodal message shape. */
export function openAiMessagesWithImages(
  messages: ChatMessage[],
  images: ChatImageInput[] | undefined,
): unknown[] {
  if (!images?.length) return messages;
  const target = lastUserIndex(messages);
  if (target < 0) return messages;
  return messages.map((message, index) => index !== target ? message : {
    ...message,
    content: [
      ...images.flatMap((image) => [
        { type: 'text', text: `${image.id}:` },
        { type: 'image_url', image_url: { url: image.url, detail: image.detail ?? 'low' } },
      ]),
      { type: 'text', text: message.content },
    ],
  });
}

/** Uploaded images use base64 blocks; public HTTPS images can stay URLs. */
export function anthropicImageSource(url: string): Record<string, unknown> {
  const data = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(url);
  return data ? { type: 'base64', media_type: data[1], data: data[2] }
    : { type: 'url', url };
}

/** Anthropic uses an `image` block with a URL or an inline base64 source. */
export function anthropicMessagesWithImages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  images: ChatImageInput[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  if (!images?.length) return messages;
  const target = lastUserIndex(messages as ChatMessage[]);
  if (target < 0) return messages;
  return messages.map((message, index) => index !== target ? message : {
    ...message,
    content: [
      ...images.flatMap((image) => [
        { type: 'text', text: `${image.id}:` },
        { type: 'image', source: anthropicImageSource(image.url) },
      ]),
      { type: 'text', text: message.content },
    ],
  });
}
