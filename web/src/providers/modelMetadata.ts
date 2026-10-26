import type { ModelInfo, ModelCaps } from './types';
import { parseReasoningEffort, REASONING_LEVELS } from '@/lib/modelReasoning';

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): string[] | undefined => Array.isArray(v)
  ? v.filter((x): x is string => typeof x === 'string').map(x => x.toLowerCase()) : undefined;
const number = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const n = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
};

/** Accept explicit metadata, never infer local capabilities from model names.
 * Capability lists are often partial; absence is unknown, not false. Modality
 * and supported-parameter lists, in contrast, describe complete API contracts. */
export function compatibleMetadata(data: Record<string, unknown>): Partial<ModelInfo> {
  const caps: ModelCaps = {};
  const c = object(data.capabilities), a = object(data.architecture), top = object(data.top_provider);
  const metadata = object(data.meta), config = object(data.config);
  const flags: [keyof ModelCaps, unknown[]][] = [
    ['vision', [c.vision, c.supports_vision, data.supports_vision, data.vision, data.supportsVision, object(c.image_input).supported]],
    ['tools', [c.tools, c.tool_calling, c.function_calling, c.trained_for_tool_use, c.supports_tools, data.supports_tools, data.supports_tool_calling, data.supports_function_calling, data.tool_calling, data.function_calling]],
    ['json', [c.json, c.structured_output, data.supports_structured_output]],
    ['reasoning', [c.reasoning, c.thinking, data.supports_reasoning]],
    ['textOutput', [c.text_output, data.supports_text_output]],
  ];
  for (const [name, values] of flags) {
    const explicit = values.map(v => typeof v === 'boolean' ? v : object(v).supported).find(v => typeof v === 'boolean');
    if (typeof explicit === 'boolean') caps[name] = explicit;
  }
  const advertised = list(data.capabilities) ?? list(metadata.capabilities) ?? [];
  for (const [key, names] of Object.entries({ vision: ['vision', 'image'], tools: ['tools', 'tool_use', 'tool_calling', 'function_calling'],
    reasoning: ['reasoning', 'thinking'], textOutput: ['completion', 'text'], json: ['json', 'structured_output'] })) {
    if (caps[key as keyof ModelCaps] === undefined && names.some(name => advertised.includes(name))) caps[key as keyof ModelCaps] = true;
  }
  const input = list(a.input_modalities) ?? list(data.input_modalities) ?? list(object(data.modalities).input);
  const output = list(a.output_modalities) ?? list(data.output_modalities) ?? list(object(data.modalities).output);
  if (input) caps.vision = input.includes('image') || input.includes('vision');
  if (output) caps.textOutput = output.includes('text');
  const parameters = list(data.supported_parameters);
  if (parameters) {
    caps.tools = parameters.includes('tools') || parameters.includes('functions');
    caps.json = parameters.includes('response_format') || parameters.includes('json_schema');
    caps.reasoning = parameters.includes('reasoning') || parameters.includes('reasoning_effort');
  }
  const r = object(data.reasoning), cr = object(c.reasoning);
  const values = r.supported_efforts ?? r.allowed_options ?? cr.allowed_options ?? data.supported_reasoning_efforts;
  let reasoning: ModelInfo['reasoning'];
  if (Array.isArray(values)) {
    const toggle = values.length > 0 && values.every(v => [true, false, 'on', 'off'].includes(v));
    const effort = (v: unknown) => v === true || v === 'on' ? 'high' : v === false ? 'off' : parseReasoningEffort(v);
    const supportedEfforts = REASONING_LEVELS.filter(level => values.some(v => effort(v) === level));
    const defaultEffort = effort(r.default_effort ?? r.default ?? cr.default);
    reasoning = { supportedEfforts, ...(defaultEffort && supportedEfforts.includes(defaultEffort) ? { defaultEffort } : {}),
      ...(r.mandatory === true ? { mandatory: true } : {}), ...(toggle ? { mode: 'toggle' } : {}) };
    if (supportedEfforts.length) caps.reasoning = supportedEfforts.some(v => v !== 'off');
    else if (values.length) caps.reasoning = true;
  } else if (data.reasoning || caps.reasoning) {
    // Known reasoning, unknown API controls: leave the server in control.
    reasoning = { supportedEfforts: [] };
  }
  const contextLength = number(data.context_length, data.max_context_length, data.max_model_len,
    data.context_window, data.context_window_size, data.context_size, data.n_ctx, top.context_length, metadata.context_length, config.max_position_embeddings);
  const maxOutputTokens = number(data.max_output_tokens, data.max_completion_tokens, top.max_completion_tokens);
  return { ...(contextLength ? { contextLength } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(Object.keys(caps).length ? { caps } : {}), ...(reasoning ? { reasoning } : {}) };
}
