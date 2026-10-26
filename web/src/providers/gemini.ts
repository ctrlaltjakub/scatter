import type { ChatChunk, Citation, ProviderConversationMessage, StreamChatOpts, TextAdapter } from './types';
import { providerMessages, ToolCallAccumulator } from './conversation';
import { geminiBase, geminiReasoning, isGeminiTextModel, listGeminiModels, parseGeminiModel } from './geminiModels';
import { effectiveReasoningEffort } from '@/lib/modelReasoning';
import { normalizeProviderError, ProviderError } from './errors';
import { sseEvents } from './sse';

type Native = Record<string, unknown>;
const record = (value: unknown): Native => value && typeof value === 'object' && !Array.isArray(value) ? value as Native : {};
const array = (value: unknown): Native[] => Array.isArray(value) ? value.map(record) : [];

export async function geminiImageInput(url: string, signal?: AbortSignal): Promise<Native> {
  const data = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(url);
  if (data) return { type: 'image', mime_type: data[1], data: data[2] };
  // The native API accepts remote URI inputs. Blob URLs are browser-local and
  // must be read here, never sent to Google as a URL it cannot retrieve.
  if (url.startsWith('blob:')) {
    const response = await fetch(url, { signal });
    const blob = await response.blob();
    return geminiBlobInput(blob);
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported image address for Gemini.');
  return { type: 'image', uri: url };
}

export async function geminiBlobInput(blob: Blob): Promise<Native> {
  if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(blob.type)) throw new Error('Gemini image input must be PNG, JPEG, WebP, or GIF.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { type: 'image', mime_type: blob.type, data: btoa(binary) };
}

export async function geminiConversation(messages: ProviderConversationMessage[], signal?: AbortSignal): Promise<Native[]> {
  const steps: Native[] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'system') continue;
    for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
    if (message.providerContent?.length) { steps.push(...message.providerContent.map(record)); continue; }
    if (message.role === 'tool') {
      const name = toolNames.get(message.toolCallId ?? '');
      if (!name) throw new Error('The Gemini tool result has no matching function call.');
      steps.push({ type: 'function_result', name, call_id: message.toolCallId,
        result: [{ type: 'text', text: message.content }], is_error: !!message.toolError });
      continue;
    }
    const content: Native[] = message.content ? [{ type: 'text', text: message.content }] : [];
    for (const image of message.images ?? []) content.push({ type: 'text', text: `${image.id}:` }, await geminiImageInput(image.url, signal));
    if (content.length) steps.push({ type: message.role === 'assistant' ? 'model_output' : 'user_input', content });
    for (const call of message.toolCalls ?? []) steps.push({ type: 'function_call', id: call.id,
      name: call.name, arguments: JSON.parse(call.arguments) });
  }
  return steps;
}

/** Native offsets are UTF-8 bytes, while the app indexes UTF-16 strings. */
export function geminiTextIndex(text: string, offset: unknown): number | undefined {
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return undefined;
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(bytes.subarray(0, Math.min(offset, bytes.length))).length;
}

export async function geminiRequest(key: string, body: Native, base?: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${geminiBase(base)}/interactions`, { method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, credentials: 'omit',
    body: JSON.stringify({ ...body, store: false }), signal,
  });
  if (!response.ok) throw normalizeProviderError(response.status, await response.text(), response.headers.get('retry-after'));
  return response;
}

export async function* streamGemini(key: string, opts: StreamChatOpts, base?: string): AsyncIterable<ChatChunk> {
  const messages = providerMessages(opts);
  const info = opts.modelInfo ?? { id: opts.model, caps: { reasoning: isGeminiTextModel(opts.model) }, reasoning: geminiReasoning(opts.model) };
  const effort = effectiveReasoningEffort('gemini', opts.model, opts.reasoningEffort, info);
  const tools: Native[] = (opts.tools ?? []).map(tool => ({ type: 'function', ...tool }));
  if (opts.webSearch) tools.push({ type: 'google_search' });
  const outputLimit = Math.min(opts.maxOutputTokens ?? 8192, info.maxOutputTokens ?? 65_536);
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
  opts.onActivity?.({ phase: 'waiting' });
  const response = await geminiRequest(key, { model: opts.model, input: await geminiConversation(messages, opts.signal),
    ...(system ? { system_instruction: system } : {}), ...(tools.length ? { tools } : {}),
    generation_config: { max_output_tokens: outputLimit, ...(effort ? { thinking_level: effort } : {}) }, stream: true,
  }, base, opts.signal);
  if (!response.body) throw new ProviderError('Google returned no response stream.', { kind: 'server' });
  const steps = new Map<number, Native>();
  const offsets = new Map<number, number>();
  const stopped = new Set<number>();
  const calls = new ToolCallAccumulator(opts.toolArgumentLimits);
  let callIndex = 0;
  let textLength = 0;
  let metadataSize = 0;
  let searches = 0;
  let completed = false;
  let finishReason = 'stop';
  for await (const block of sseEvents(response.body)) {
    opts.signal?.throwIfAborted();
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    let event: Native;
    try { event = record(JSON.parse(data)); } catch { throw new Error('Google returned an invalid stream event. Try again.'); }
    const type = event.event_type;
    if (type === 'error' || type === 'interaction.failed') {
      const error = record(event.error ?? record(event.interaction).error);
      throw normalizeProviderError(typeof error.code === 'number' ? error.code : 400, JSON.stringify({ error }));
    }
    const index = typeof event.index === 'number' ? event.index : -1;
    if (type === 'step.start') {
      if (index < 0 || steps.size >= 256) throw new Error('Google returned too many response steps.');
      const step = structuredClone(record(event.step));
      steps.set(index, step);
      offsets.set(index, textLength);
      if (step.type === 'model_output') {
        const text = array(step.content).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('');
        textLength += text.length;
        if (text) { opts.onActivity?.({ phase: 'responding' }); yield { delta: text, done: false }; }
      } else if (step.type === 'thought') opts.onActivity?.({ phase: 'reasoning' });
      else if (step.type === 'google_search_call') opts.onActivity?.({ phase: 'tool', tool: 'web_search' });
      else if (step.type === 'function_call') opts.onActivity?.({ phase: 'tool', tool: String(step.name ?? '') });
    } else if (type === 'step.delta') {
      const step = steps.get(index);
      if (!step) throw new Error('Google returned a response fragment without a step.');
      const delta = record(event.delta);
      if (step.type === 'model_output' && (delta.type === 'text' || delta.type === 'text_annotation_delta')) {
        const content = array(step.content);
        let part = content.findLast(item => item.type === 'text');
        if (!part) { part = { type: 'text', text: '' }; content.push(part); }
        if (delta.type === 'text') {
          const text = String(delta.text ?? '');
          part.text = String(part.text ?? '') + text;
          textLength += text.length;
          if (text) { opts.onActivity?.({ phase: 'responding' }); yield { delta: text, done: false }; }
        } else part.annotations = [...array(part.annotations), ...array(delta.annotations)];
        step.content = content;
      } else if (delta.type === 'thought_signature') {
        step.signature = String(step.signature ?? '') + String(delta.signature ?? '');
      } else if (delta.type === 'thought_summary') {
        // Retain the native block for signed continuation, never display it as answer text.
        step.summary = [...array(step.summary), record(delta.content)];
      } else {
        for (const [field, value] of Object.entries(delta)) {
          if (field === 'type') continue;
          if (field === 'arguments' && typeof value === 'string') step.arguments = (typeof step.arguments === 'string' ? step.arguments : '') + value;
          else if (Array.isArray(value)) step[field] = [...(Array.isArray(step[field]) ? step[field] as unknown[] : []), ...value];
          else step[field] = value;
        }
      }
      metadataSize += data.length;
      if (metadataSize > 4_000_000) throw new Error('Google returned oversized response metadata.');
    } else if (type === 'step.stop' && !stopped.has(index)) {
      stopped.add(index);
      const step = steps.get(index);
      if (!step) throw new Error('Google ended an unknown response step.');
      if (step.type === 'function_call') {
        calls.add({ index: callIndex++, id: String(step.id ?? ''), function: { name: String(step.name ?? ''),
          arguments: typeof step.arguments === 'string' ? step.arguments : JSON.stringify(step.arguments ?? {}) } });
        // Replay native parsed arguments, not the transport's serialized fragments.
        if (typeof step.arguments === 'string') step.arguments = JSON.parse(step.arguments);
      } else if (step.type === 'google_search_result') {
        if (!step.is_error) searches++;
        const suggestions = array(step.result).flatMap(item => typeof item.search_suggestions === 'string' ? [item.search_suggestions] : []);
        yield { delta: '', done: false, googleSearchSuggestions: suggestions,
          webSearch: { used: searches > 0, requestCount: searches, ...(step.is_error ? { error: 'Google Search did not complete.' } : {}) } };
      } else if (step.type === 'model_output') {
        let offset = offsets.get(index) ?? 0;
        const citations: Citation[] = [];
        for (const part of array(step.content)) {
          if (part.type !== 'text') continue;
          const text = String(part.text ?? '');
          for (const annotation of array(part.annotations)) {
            if (annotation.type !== 'url_citation' || typeof annotation.url !== 'string' || !/^https?:\/\//i.test(annotation.url)) continue;
            const start = geminiTextIndex(text, annotation.start_index);
            const end = geminiTextIndex(text, annotation.end_index);
            citations.push({ url: annotation.url, title: typeof annotation.title === 'string' ? annotation.title : undefined,
              startIndex: start == null ? undefined : offset + start, endIndex: end == null ? undefined : offset + end, offsetKind: 'claim' });
          }
          offset += text.length;
        }
        if (citations.length) yield { delta: '', done: false, citations };
      }
    } else if (type === 'interaction.completed' || type === 'interaction.incomplete') {
      const interaction = record(event.interaction);
      completed = true;
      finishReason = interaction.status === 'incomplete' || type === 'interaction.incomplete' ? 'length' : 'stop';
      if (interaction.status === 'failed') throw new Error('Google could not complete this response. Try again.');
      const reportedSearches = array(record(interaction.usage).grounding_tool_count)
        .filter(item => item.type === 'google_search' && typeof item.count === 'number')
        .reduce((total, item) => total + Number(item.count), 0);
      if (reportedSearches > searches) {
        searches = reportedSearches;
        yield { delta: '', done: false, webSearch: { used: true, requestCount: searches } };
      }
    }
  }
  if (!completed) throw new Error('The Gemini response stream ended early. Try again.');
  if (finishReason !== 'length' && [...steps.keys()].some(index => !stopped.has(index))) throw new Error('The Gemini response contained an incomplete step.');
  const toolCalls = finishReason === 'length' ? [] : calls.finish();
  yield { delta: '', done: true, finishReason: toolCalls.length ? 'tool_calls' : finishReason,
    ...(toolCalls.length ? { toolCalls } : {}), providerResponse: [...steps.values()] };
}

export const geminiAdapter: TextAdapter = {
  capabilities: { webSearch: true },
  async listModels(key, base) {
    return (await listGeminiModels(key, base)).filter(model => model.supportedGenerationMethods?.includes('generateContent')).map(parseGeminiModel);
  },
  streamChat: streamGemini,
};
