import type { ModelInfo } from '@/providers/types';
import type { ProviderPreset, ReasoningEffort } from '@/store/types';
import { resolveCaps } from './modelMeta';
import { geminiReasoning } from '@/providers/geminiModels';

export const REASONING_LEVELS: readonly ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max',
};
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return REASONING_LEVELS.includes(value as ReasoningEffort);
}
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return value === 'none' ? 'off' : isReasoningEffort(value) ? value : undefined;
}

/** Prefer the provider's exact list. Fallbacks expose only documented safe levels. */
export function reasoningLevels(preset: ProviderPreset, model: string, info?: ModelInfo): ReasoningEffort[] {
  if (info?.reasoning?.supportedEfforts) {
    return REASONING_LEVELS.filter((level) => info.reasoning!.supportedEfforts!.includes(level)
      && !(level === 'off' && info.reasoning?.mandatory));
  }
  if (!resolveCaps(preset, model, info).reasoning) return [];
  // A reasoning capability does not specify a request parameter or levels.
  if (preset === 'ollama' || preset === 'lm-studio' || preset === 'custom') return [];
  if (preset === 'gemini') return geminiReasoning(model)!.supportedEfforts!;
  if (preset === 'openai') {
    if (/\bpro(?:-|$)/i.test(model)) return ['high'];
    if (/^(?:gpt-6-astra|gpt-6\.1-sol)(?:-|$)/i.test(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-(?:5\.[6-9]|[6-9])(?:-|\.|$)/i.test(model))
      return ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
  }
  return ['low', 'medium', 'high'];
}

/** Switching models never sends an unsupported saved level to the next provider. */
export function effectiveReasoningEffort(
  preset: ProviderPreset, model: string, requested: ReasoningEffort | undefined, info?: ModelInfo,
): ReasoningEffort | undefined {
  if (!requested) return undefined;
  const levels = reasoningLevels(preset, model, info);
  if (!levels.length) return undefined;
  if (levels.includes(requested)) return requested;
  const index = REASONING_LEVELS.indexOf(requested);
  return [...levels].reverse().find((level) => REASONING_LEVELS.indexOf(level) <= index && level !== 'off')
    ?? levels.find((level) => level !== 'off') ?? levels[0];
}
