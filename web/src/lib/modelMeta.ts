import type { ModelInfo, ModelCaps, ModelPricing, TextModelEndpoint } from '@/providers/types';
import type { OpenRouterRoutingPreference, ProviderPreset } from '@/store/types';
import { supportsModelSearch } from '@/providers/modelSearch';
import { isGeminiTextModel } from '@/providers/geminiModels';

/**
 * Model-metadata helpers used by the picker badges and the reasoning dial.
 *
 * Two sources of truth, merged: metadata PARSED from a provider's model list
 * (authoritative, OpenRouter only) wins over capabilities INFERRED from the
 * model name (fallback, for id-only providers like OpenAI/Anthropic/local).
 */

/** Guess what a model can do from its id, for providers whose `/models` is
 *  id-only. Deliberately conservative — only flags reasoning/vision on families
 *  known to support them, so we never enable a control the model will reject. */
export function inferModelCaps(preset: ProviderPreset, id: string): ModelCaps {
  const m = id.toLowerCase();
  if (preset === 'gemini' && isGeminiTextModel(id)) return { reasoning: true, vision: true, tools: true, json: true, textOutput: true };
  const clearlyNonText = /(^|\/)(text-embedding|embedding|moderation|whisper|tts|dall-e|gpt-image|imagen|veo|sora|audio-preview|realtime)/.test(m);
  if (preset === 'openai') {
    return {
      // o-series (o1/o3/o4…) and gpt-5+ are reasoning models; 4o/4.1 are not.
      reasoning: /(^|\/)o\d|(^|\/)gpt-[5-9]/.test(m),
      vision: /gpt-4o|gpt-4\.1|gpt-[5-9]|omni|vision|(^|\/)o\d/.test(m),
      tools: true,
      json: true,
      textOutput: !clearlyNonText,
    };
  }
  if (preset === 'anthropic') {
    return {
      // extended thinking: Claude 3.7 and the 4.x sonnet/opus line.
      reasoning: /claude-(3[.-]7|(sonnet|opus)-(4|5)|(fable|mythos)-|haiku-4-5)/.test(m),
      vision: /claude-(3|4|haiku|sonnet|opus|fable|mythos)/.test(m),
      tools: true,
      json: false, // Anthropic has no response_format json mode
      textOutput: true,
    };
  }
  // openrouter / local / custom: nothing reliable from the name alone.
  return clearlyNonText ? { textOutput: false } : {};
}

/** Merge parsed metadata (authoritative) over name-inferred fallback. */
export function resolveCaps(
  preset: ProviderPreset,
  id: string,
  info: ModelInfo | undefined,
): ModelCaps {
  return { ...inferModelCaps(preset, id), ...(info?.caps ?? {}) };
}

/** Shared main-model rule: image input, connected search, and ordinary function calls.
 * Unknown catalog metadata is not affirmative capability evidence. */
export function mainModelCompatible(preset: ProviderPreset, id: string, info?: ModelInfo, searchEndpoint?: string, serverSearch?: import('@/store/types').ServerSearch): boolean {
  const caps = resolveCaps(preset, id, info);
  return caps.vision === true && caps.tools === true && caps.textOutput !== false
    && supportsModelSearch(preset, id, info, searchEndpoint, serverSearch);
}

export function secondaryModelCompatible(preset: ProviderPreset, id: string, info?: ModelInfo, searchEndpoint?: string, serverSearch?: import('@/store/types').ServerSearch): boolean {
  const caps = resolveCaps(preset, id, info);
  return caps.vision === true && caps.textOutput !== false && supportsModelSearch(preset, id, info, searchEndpoint, serverSearch);
}

/** Screenshot review is mandatory for interactive builds. Tool calling is
 * preferred, but vision-capable text-only endpoints can use full HTML output. */
export function interactiveModelCompatible(preset: ProviderPreset, id: string, info?: ModelInfo): boolean {
  const caps = resolveCaps(preset, id, info);
  return caps.vision === true && caps.textOutput !== false;
}

/** Does this (preset, model[, metadata]) support a reasoning-effort control? */
export function modelSupportsReasoning(
  preset: ProviderPreset,
  id: string,
  info: ModelInfo | undefined,
): boolean {
  return resolveCaps(preset, id, info).reasoning === true;
}

/** Whether a model can emit ordinary text/code. Unknown generic/local models
 * remain eligible; only explicit metadata or clearly non-text families are
 * excluded. */
export function modelSupportsTextOutput(
  preset: ProviderPreset,
  id: string,
  info: ModelInfo | undefined,
): boolean {
  return resolveCaps(preset, id, info).textOutput !== false;
}

/** Image assessment is never enabled speculatively. Provider metadata or a
 * conservative first-party family inference must explicitly confirm vision. */
export function modelSupportsVision(
  preset: ProviderPreset,
  id: string,
  info: ModelInfo | undefined,
): boolean {
  return resolveCaps(preset, id, info).vision === true;
}

/** Compact context-window label, e.g. 128000 → "128k", 1048576 → "1M". */
export function formatContext(tokens: number | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/** Compact USD-per-1M-tokens label, e.g. 0.3 → "$0.30/M", 15 → "$15/M".
 *  Cents get two decimals; whole dollars round to an integer. */
export function formatPricePerM(usdPerM: number | undefined): string | null {
  if (usdPerM === undefined || usdPerM < 0) return null;
  if (usdPerM === 0) return 'free';
  const formatted = usdPerM.toFixed(usdPerM < 0.01 ? 4 : usdPerM < 10 ? 2 : 0);
  return `$${formatted}/M`;
}

/** Explicit provider sorting does not opt into OpenRouter's flex or priority
 * service tiers. Mirror that rule so the price shown in Scatter describes the
 * same ordinary endpoint pool used by generation. */
export function isDefaultTextEndpoint(endpoint: TextModelEndpoint): boolean {
  return !/(?:^|\/)(?:flex|priority|fast)$/i.test(endpoint.tag);
}

function priceScore(pricing: ModelPricing | undefined): number {
  if (!pricing) return Number.POSITIVE_INFINITY;
  const input = pricing.inputPerM ?? Number.POSITIVE_INFINITY;
  const output = pricing.outputPerM ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return Number.POSITIVE_INFINITY;
  // Equal weighting is only a display estimate. OpenRouter remains the source
  // of truth and chooses the endpoint using the actual request's token mix.
  return (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

/** Select the endpoint that best represents what OpenRouter is likely to use
 * for the chosen mode. Live routing uses fresher server metrics, so callers
 * should present this as an estimate rather than a guarantee. */
export function selectTextEndpointForRouting(
  endpoints: TextModelEndpoint[],
  routing: OpenRouterRoutingPreference,
): TextModelEndpoint | undefined {
  const defaultTier = endpoints.filter(isDefaultTextEndpoint);
  const available = defaultTier.filter((endpoint) => endpoint.status === undefined || endpoint.status === 0);
  const candidates = available.length ? available : defaultTier;
  if (!candidates.length) return undefined;
  return [...candidates].sort((a, b) => {
    if (routing === 'fast-start') {
      const latency = (a.latencyP50Ms ?? Number.POSITIVE_INFINITY)
        - (b.latencyP50Ms ?? Number.POSITIVE_INFINITY);
      if (latency) return latency;
    }
    const price = priceScore(a.pricing) - priceScore(b.pricing);
    if (price) return price;
    return a.providerName.localeCompare(b.providerName, undefined, { sensitivity: 'base' });
  })[0];
}

export function modelPricingForRouting(
  info: ModelInfo | undefined,
  endpoints: TextModelEndpoint[] | undefined,
  routing: OpenRouterRoutingPreference,
): { pricing?: ModelPricing; endpoint?: TextModelEndpoint } {
  const endpoint = endpoints?.length
    ? selectTextEndpointForRouting(endpoints, routing)
    : undefined;
  return { pricing: endpoint?.pricing ?? info?.pricing, endpoint };
}
