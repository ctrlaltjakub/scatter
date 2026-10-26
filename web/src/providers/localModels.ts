import type { ModelInfo, TextAdapter } from './types';
import { listModelsCompat, openaiCompatibleAdapter } from './openai';
import { parseReasoningEffort, REASONING_LEVELS } from '@/lib/modelReasoning';
import { compatibleMetadata } from './modelMetadata';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
const positive = (value: unknown): number | undefined => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

function localReasoning(values: unknown, defaultValue: unknown): ModelInfo['reasoning'] {
  if (!Array.isArray(values)) return undefined;
  const toggle = values.length > 0 && values.every(value => [true, false, 'on', 'off'].includes(value));
  const effort = (value: unknown) => value === true || value === 'on' ? 'high' as const
    : value === false ? 'off' as const : parseReasoningEffort(value);
  const supportedEfforts = REASONING_LEVELS.filter(level => values.some(value => effort(value) === level));
  const defaultEffort = effort(defaultValue);
  return { supportedEfforts, ...(defaultEffort && supportedEfforts.includes(defaultEffort) ? { defaultEffort } : {}),
    mandatory: supportedEfforts.length > 0 && !supportedEfforts.includes('off'), ...(toggle ? { mode: 'toggle' } : {}) };
}

/** Keep a reverse proxy's path prefix, replacing only the compatibility /v1 suffix. */
export function nativeModelUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '').replace(/\/v1$/, '')}${path}`;
}

export function enrichOllamaModel(model: ModelInfo, value: unknown): ModelInfo {
  const data = record(value);
  if (!data) return model;
  const caps = Array.isArray(data.capabilities) ? data.capabilities : undefined;
  const thinking = record(data.thinking);
  const reasoning = localReasoning(thinking?.values, thinking?.default);
  const metadata = record(data.model_info);
  const architecture = metadata?.['general.architecture'];
  const configuredContext = typeof data.parameters === 'string'
    ? positive(Number(data.parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1])) : undefined;
  const context = configuredContext ?? (typeof architecture === 'string' ? positive(metadata?.[`${architecture}.context_length`]) : undefined);
  const common = compatibleMetadata(data);
  return {
    ...model, ...common,
    ...(context ? { contextLength: context } : {}),
    ...(model.caps || common.caps ? { caps: { ...model.caps, ...common.caps } } : {}),
    // Current Ollama publishes exact controls used by its compatibility API.
    // Older servers with only a thinking capability retain no invented dial.
    ...(reasoning ? { reasoning } : caps?.includes('thinking') && !model.reasoning ? { reasoning: { supportedEfforts: [] } } : {}),
  };
}

export function enrichLmStudioModels(models: ModelInfo[], value: unknown): ModelInfo[] {
  const data = record(value);
  if (!Array.isArray(data?.models)) return models;
  const byId = new Map<string, RecordValue>();
  const contextById = new Map<string, number>();
  for (const entry of data.models) {
    const model = record(entry);
    if (!model || typeof model.key !== 'string') continue;
    byId.set(model.key, model);
    for (const entry of Array.isArray(model.loaded_instances) ? model.loaded_instances : []) {
      const instance = record(entry);
      if (typeof instance?.id === 'string') {
        byId.set(instance.id, model);
        const context = positive(record(instance.config)?.context_length);
        if (context) contextById.set(instance.id, context);
      }
    }
  }
  return models.map((model) => {
    const native = byId.get(model.id);
    if (!native) return model;
    const caps = record(native.capabilities);
    const thinking = record(caps?.reasoning);
    const reasoning = localReasoning(thinking?.allowed_options, thinking?.default);
    const common = compatibleMetadata(native);
    return {
      ...model, ...common,
      ...(typeof native.display_name === 'string' ? { name: native.display_name } : {}),
      ...(contextById.get(model.id) ?? positive(native.max_context_length)
        ? { contextLength: contextById.get(model.id) ?? positive(native.max_context_length) } : {}),
      caps: { ...model.caps, ...common.caps,
        ...(typeof caps?.vision === 'boolean' ? { vision: caps.vision } : {}),
        ...(typeof caps?.trained_for_tool_use === 'boolean' ? { tools: caps.trained_for_tool_use } : {}),
        ...(native.type === 'llm' || native.type === 'embedding' ? { textOutput: native.type === 'llm' } : {}),
        ...(reasoning ? { reasoning: (thinking!.allowed_options as unknown[]).some(value => value !== false && value !== 'off' && value !== 'none') } : {}),
      },
      ...(reasoning ? { reasoning } : {}),
    };
  });
}

async function nativeJson(url: string, apiKey: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET', signal,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error('Native model metadata is unavailable.');
  return response.json();
}

export const ollamaAdapter: TextAdapter = {
  ...openaiCompatibleAdapter,
  async listModels(apiKey, baseUrl = 'http://localhost:11434/v1') {
    const base = baseUrl.replace(/\/+$/, '');
    const models = await listModelsCompat(apiKey, base);
    const result = [...models];
    // Model discovery must not load models, or launch an unbounded request per
    // installed model. All workers share one deadline; old servers keep /v1 data.
    const signal = AbortSignal.timeout(8000);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, models.length) }, async () => {
      while (next < models.length && !signal.aborted) {
        const index = next++;
        const model = models[index]!;
        try {
          result[index] = enrichOllamaModel(model, await nativeJson(nativeModelUrl(base, '/api/show'), apiKey, signal, { model: model.id }));
        } catch { /* Missing metadata stays unknown, never guessed from a name. */ }
      }
    }));
    return result;
  },
};

export const lmStudioAdapter: TextAdapter = {
  ...openaiCompatibleAdapter,
  async listModels(apiKey, baseUrl = 'http://localhost:1234/v1') {
    const base = baseUrl.replace(/\/+$/, '');
    const models = await listModelsCompat(apiKey, base);
    try {
      return enrichLmStudioModels(models, await nativeJson(nativeModelUrl(base, '/api/v1/models'), apiKey, AbortSignal.timeout(8000)));
    } catch { return models; }
  },
};
