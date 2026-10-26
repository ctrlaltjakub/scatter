import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichLmStudioModels, enrichOllamaModel, lmStudioAdapter, nativeModelUrl, ollamaAdapter } from './localModels';
import { mainModelCompatible, secondaryModelCompatible } from '@/lib/modelMeta';

afterEach(() => vi.unstubAllGlobals());
describe('native local model metadata', () => {
  it('preserves reverse-proxy prefixes and removes trailing slashes', () => {
    expect(nativeModelUrl('https://home.test/ollama/v1/', '/api/show')).toBe('https://home.test/ollama/api/show');
  });
  it('reads Ollama vision/tool support without guessing from model names', () => {
    const model = enrichOllamaModel({ id: 'anything' }, { capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'general.architecture': 'arch', 'arch.context_length': 32768 } });
    expect(model).toMatchObject({ contextLength: 32768, caps: { vision: true, tools: true, reasoning: true, textOutput: true }, reasoning: { supportedEfforts: [] } });
    expect(mainModelCompatible('ollama', model.id, model, 'http://localhost:8080')).toBe(true);
    expect(secondaryModelCompatible('ollama', model.id, model, 'http://localhost:8080')).toBe(true);
    expect(mainModelCompatible('ollama', model.id, model)).toBe(false);
    expect(enrichOllamaModel({ id: 'vision-in-name' }, {})).toEqual({ id: 'vision-in-name' });
    expect(enrichOllamaModel({ id: 'vision-in-name' }, { capabilities: ['completion'] }).caps?.vision).toBeUndefined();
    expect(enrichOllamaModel({ id: 'configured' }, { parameters: 'temperature 0.7\n num_ctx 8192', model_info: { 'general.architecture': 'arch', 'arch.context_length': 32768 } }).contextLength).toBe(8192);
  });
  it('matches LM Studio loaded-instance IDs and leaves unrelated models unknown', () => {
    const models = enrichLmStudioModels([{ id: 'running-alias' }, { id: 'unknown' }], { models: [{ key: 'local-vlm', display_name: 'Local VLM', type: 'llm', max_context_length: 32000,
      loaded_instances: [{ id: 'running-alias', config: { context_length: 4096 } }], capabilities: { vision: true, trained_for_tool_use: true } }] });
    expect(models[0]).toMatchObject({ id: 'running-alias', name: 'Local VLM', contextLength: 4096, caps: { vision: true, tools: true, textOutput: true } });
    expect(models[1]).toEqual({ id: 'unknown' });
    expect(enrichLmStudioModels([{ id: 'nested' }], { models: [{ key: 'nested', capabilities: { vision: { supported: true }, tool_calling: { supported: false } }, max_context_length: '16384' }] })[0])
      .toMatchObject({ contextLength: 16384, caps: { vision: true, tools: false } });
  });
  it('reads exact named and binary reasoning controls without inventing levels', () => {
    const binary = enrichOllamaModel({ id: 'qwen' }, { capabilities: ['thinking'], thinking: { values: [false, true], default: true } });
    expect(binary.reasoning).toEqual({ supportedEfforts: ['off', 'high'], defaultEffort: 'high', mode: 'toggle', mandatory: false });
    const named = enrichOllamaModel({ id: 'named' }, { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } });
    expect(named.reasoning).toEqual({ supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium', mandatory: true });
    const [lm] = enrichLmStudioModels([{ id: 'qwen' }], { models: [{ key: 'qwen', capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } }] });
    expect(lm?.reasoning).toEqual(binary.reasoning);
    expect(lm?.caps?.reasoning).toBe(true);
    expect(enrichOllamaModel({ id: 'future' }, { thinking: { values: ['unknown-mode'] } }).reasoning?.supportedEfforts).toEqual([]);
    expect(enrichLmStudioModels([{ id: 'future' }], { models: [{ key: 'future', capabilities: { reasoning: { allowed_options: ['unknown-mode'] } } }] })[0])
      .toMatchObject({ caps: { reasoning: true }, reasoning: { supportedEfforts: [] } });
  });
  it('enriches catalog requests and safely falls back for older servers', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'vlm' }, { id: 'old' }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: ['completion', 'vision', 'tools'] })))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const models = await ollamaAdapter.listModels('local', 'http://localhost:11434/v1');
    expect(models[0]?.caps?.vision).toBe(true);
    expect(models[1]?.caps).toBeUndefined();
    expect(fetcher.mock.calls.slice(1).every((call) => String(call[0]).endsWith('/api/show'))).toBe(true);
    fetcher.mockReset().mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'old' }] })))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await lmStudioAdapter.listModels('local')).toEqual([{ id: 'old' }]);
  });
});
