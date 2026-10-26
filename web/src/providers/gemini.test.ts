import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiAdapter, geminiConversation, geminiTextIndex } from './gemini';
import { geminiImageAdapter } from './geminiImages';
import { parseGeminiModel, parseGeminiImageModel } from './geminiModels';
import { mainModelCompatible, secondaryModelCompatible } from '@/lib/modelMeta';
import { modelSupportsWebSearch } from './registry';
import { reasoningLevels } from '@/lib/modelReasoning';
import type { ChatChunk, StreamChatOpts } from './types';

afterEach(() => vi.unstubAllGlobals());
const baseOpts: StreamChatOpts = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 1024, reasoningEffort: 'low' };
const event = (event_type: string, extra: object = {}) => ({ event_type, ...extra });
const start = (index: number, step: object) => event('step.start', { index, step });
const delta = (index: number, delta: object) => event('step.delta', { index, delta });
const stop = (index: number) => event('step.stop', { index });
const end = (status = 'completed') => event('interaction.completed', { interaction: { status } });
function stream(events: object[]) {
  return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
async function collect(opts: Partial<StreamChatOpts> = {}) {
  const chunks: ChatChunk[] = [];
  for await (const chunk of geminiAdapter.streamChat('test-only-key', { ...baseOpts, ...opts })) chunks.push(chunk);
  return chunks;
}

describe('Gemini native provider', () => {
  it('paginates discovery and exposes only confirmed capabilities', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-3.8-flash', thinking: true,
      inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next/page' }))
      .mockResolvedValueOnce(Response.json({ models: [{ name: 'models/gemini-embedding-2', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] }] }));
    vi.stubGlobal('fetch', fetch);
    const models = await geminiAdapter.listModels('test-only-key');
    expect(models.map(model => model.id)).toEqual(['gemini-3.8-flash', 'gemini-3.1-flash-image']);
    expect(fetch.mock.calls[1]![0]).toContain('pageToken=next%2Fpage');
    expect(mainModelCompatible('gemini', models[0]!.id, models[0])).toBe(true);
    expect(secondaryModelCompatible('gemini', models[0]!.id, models[0])).toBe(true);
    expect(mainModelCompatible('gemini', models[1]!.id, models[1])).toBe(false);
    expect(modelSupportsWebSearch('gemini', 'gemma-4-31b-it')).toBe(false);
    expect(modelSupportsWebSearch('gemini', 'gemini-3.8-flash-tts')).toBe(false);
    expect(reasoningLevels('gemini', models[0]!.id, models[0])).toEqual(['low', 'medium', 'high']);
    expect(parseGeminiModel({ name: 'models/new-unknown-model' }).caps?.vision).toBeUndefined();
  });

  it('streams text, preserves native continuations, and excludes search when off', async () => {
    const fetch = vi.fn().mockResolvedValue(stream([start(0, { type: 'thought' }), delta(0, { type: 'thought_signature', signature: 'signed' }), stop(0),
      start(1, { type: 'model_output' }), delta(1, { type: 'text', text: 'Hello' }), stop(1), end()]));
    vi.stubGlobal('fetch', fetch);
    const result = await collect({ webSearch: false });
    expect(result.map(chunk => chunk.delta).join('')).toBe('Hello');
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request).toMatchObject({ store: false, stream: true, generation_config: { max_output_tokens: 1024, thinking_level: 'low' } });
    expect(request.tools).toBeUndefined();
    expect(result.at(-1)?.providerResponse).toEqual([{ type: 'thought', signature: 'signed' }, { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }]);
  });

  it('retains search suggestions and maps byte citation offsets to the answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream([
      start(0, { type: 'google_search_call', id: 'search', signature: 'call-signature' }),
      delta(0, { type: 'google_search_call', arguments: { queries: ['test'] }, signature: 'call-signature' }), stop(0),
      start(1, { type: 'google_search_result', call_id: 'search' }),
      delta(1, { type: 'google_search_result', result: [{ search_suggestions: '<div>Google Search</div>' }], signature: 'result-signature' }), stop(1),
      start(2, { type: 'model_output' }), delta(2, { type: 'text', text: 'Żółw 🐢.' }),
      delta(2, { type: 'text_annotation_delta', annotations: [{ type: 'url_citation', url: 'https://example.org', title: 'Source', start_index: 0, end_index: 12 }] }), stop(2), end(),
    ])));
    const result = await collect({ webSearch: true });
    expect(result.some(chunk => chunk.webSearch?.used)).toBe(true);
    expect(result.flatMap(chunk => chunk.googleSearchSuggestions ?? [])).toEqual(['<div>Google Search</div>']);
    expect(result.flatMap(chunk => chunk.citations ?? [])[0]).toMatchObject({ startIndex: 0, endIndex: 7, offsetKind: 'claim' });
    expect(geminiTextIndex('Żółw 🐢.', 13)).toBe(8);
    expect(result.at(-1)?.providerResponse).toContainEqual(expect.objectContaining({ type: 'google_search_result', signature: 'result-signature' }));
  });

  it('replays tools, images, and signed steps without flattening or duplicating them', async () => {
    const signed = [{ type: 'thought', signature: 'signed', summary: [] }, { type: 'function_call', id: 'c1', name: 'calculate', arguments: { n: 2 } }];
    const conversation = await geminiConversation([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Look', images: [{ id: 'image1', url: 'data:image/png;base64,YQ==' }] },
      { role: 'assistant', content: '', providerContent: signed, toolCalls: [{ id: 'c1', name: 'calculate', arguments: '{"n":2}' }] },
      { role: 'tool', content: '{"result":4}', toolCallId: 'c1' },
    ]);
    expect(conversation).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'Look' }, { type: 'text', text: 'image1:' }, { type: 'image', mime_type: 'image/png', data: 'YQ==' }] },
      ...signed, { type: 'function_result', name: 'calculate', call_id: 'c1', result: [{ type: 'text', text: '{"result":4}' }], is_error: false }]);
  });

  it('assembles split function arguments and respects tool-specific limits', async () => {
    const fetch = vi.fn().mockImplementation(async () => stream([start(0, { type: 'function_call', id: 'c1', name: 'write_document', arguments: {} }),
      delta(0, { type: 'function_call_arguments', arguments: '{"text":"' }), delta(0, { type: 'function_call_arguments', arguments: `${'x'.repeat(17000)}"}` }), stop(0), end('requires_action')]));
    vi.stubGlobal('fetch', fetch);
    await expect(collect()).rejects.toThrow('oversized tool call');
    const result = await collect({ toolArgumentLimits: { write_document: 20000 } });
    expect(result.at(-1)?.toolCalls?.[0]?.name).toBe('write_document');
    expect(result.at(-1)?.finishReason).toBe('tool_calls');
  });

  it('does not execute truncated tool calls and rejects incomplete streams', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(stream([start(0, { type: 'function_call', name: 'write_document' }), end('incomplete')]))
      .mockResolvedValueOnce(stream([start(0, { type: 'model_output' }), delta(0, { type: 'text', text: 'Partial' })]));
    vi.stubGlobal('fetch', fetch);
    expect((await collect()).at(-1)).toMatchObject({ done: true, finishReason: 'length' });
    await expect(collect()).rejects.toThrow('ended early');
  });

  it('normalizes quota errors and caps output to the model limit', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'You exceeded your current quota' } }), { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    await expect(collect({ modelInfo: { id: baseOpts.model, maxOutputTokens: 512 }, maxOutputTokens: 32000 })).rejects.toMatchObject({ kind: 'insufficient_credits' });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).generation_config.max_output_tokens).toBe(512);
  });

  it('offers editing-capable image models and sends original plus reference images', async () => {
    expect(parseGeminiImageModel({ name: 'models/gemini-3.8-flash' })).toBeNull();
    expect(parseGeminiImageModel({ name: 'models/gemini-3.1-flash-lite-image' })).toMatchObject({ supportsImageEditing: true, resolutions: ['1K'] });
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Done' }, { type: 'image', data: 'aW1hZ2U=', mime_type: 'image/png' }] }] }));
    vi.stubGlobal('fetch', fetch);
    const blob = new Blob(['image'], { type: 'image/png' });
    const image = await geminiImageAdapter.edit!('test-only-key', { model: 'gemini-3.1-flash-image', prompt: 'Edit the indicated part', image: blob, referenceImages: [blob], resolution: '1K', aspectRatio: '4:3' });
    expect(new TextDecoder().decode(image.bytes)).toBe('image');
    const request = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(request.input).toHaveLength(3);
    expect(request).toMatchObject({ store: false, response_format: { type: 'image', mime_type: 'image/jpeg', image_size: '1K', aspect_ratio: '4:3' } });
  });
});
