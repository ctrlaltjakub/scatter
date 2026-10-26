import type { Settings } from '@/store/types';
import type { ModelInfo } from '@/providers/types';

export const GENERATION_LIMITS = {
  outputTokenCap: { label: 'Main generations', default: 16_000, min: 1_000, max: 128_000, step: 1_000 },
  secondaryOutputTokenCap: { label: 'Secondary tasks', default: 12_000, min: 6_000, max: 48_000, step: 1_000 },
  interactiveOutputTokenCap: { label: 'Interactive steps', default: 50_000, min: 2_000, max: 128_000, step: 1_000 },
} as const;
export type GenerationLimitKey = keyof typeof GENERATION_LIMITS;

export function normalizeGenerationLimit(key: GenerationLimitKey, value: unknown): number {
  const rule = GENERATION_LIMITS[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(rule.min, Math.min(rule.max, value))) : rule.default;
}

export function normalizeGenerationLimits(raw: Record<string, unknown>) {
  const output = normalizeGenerationLimit('outputTokenCap', raw.outputTokenCap);
  return {
    generationLimitsVersion: 1 as const,
    // Legacy budgets were not editable and were deliberately upgraded to 16k.
    // Versioned, intentional lower limits must survive import and restart.
    outputTokenCap: raw.generationLimitsVersion === 1 ? output : Math.max(output, GENERATION_LIMITS.outputTokenCap.default),
    secondaryOutputTokenCap: normalizeGenerationLimit('secondaryOutputTokenCap', raw.secondaryOutputTokenCap),
    interactiveOutputTokenCap: normalizeGenerationLimit('interactiveOutputTokenCap', raw.interactiveOutputTokenCap),
  };
}

/** Keep task-specific secondary budgets: a title must not receive the same
 * allowance as an OCR page or a long term list. Defaults remain unchanged. */
export function secondaryOutputTokens(settings: Pick<Settings, 'secondaryOutputTokenCap'>, taskDefault: number): number {
  return Math.max(1, Math.round(taskDefault
    * normalizeGenerationLimit('secondaryOutputTokenCap', settings.secondaryOutputTokenCap)
    / GENERATION_LIMITS.secondaryOutputTokenCap.default));
}

export function mainOutputTokens(limit: number, taskDefault: number = GENERATION_LIMITS.outputTokenCap.default): number {
  return Math.max(1, Math.round(taskDefault * normalizeGenerationLimit('outputTokenCap', limit)
    / GENERATION_LIMITS.outputTokenCap.default));
}

/** Known model limits are authoritative; missing metadata is not a made-up cap.
 * The provider still validates the combined input/context budget. */
export function modelOutputTokenLimit(requested: number, info?: ModelInfo): number {
  const cap = info?.maxOutputTokens;
  const wanted = Math.max(1, Math.floor(requested));
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? Math.min(wanted, Math.floor(cap)) : wanted;
}

export function isOutputLimit(reason: string | null | undefined): boolean {
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens';
}

export class GenerationOutputLimitError extends Error {
  constructor(role: 'main' | 'secondary' | 'interactive') {
    const label = role === 'main' ? 'Main generations' : role === 'secondary' ? 'Secondary tasks' : 'Interactive steps';
    super(`The model reached its output limit before finishing. Reasoning and the answer can share this allowance. Increase “${label}” in Settings → Models and generation → Generation token limits${role === 'secondary' ? ', or simplify the task' : ', lower reasoning effort, or simplify the request'}. The provider’s own limits still apply.`);
    this.name = 'GenerationOutputLimitError';
  }
}
