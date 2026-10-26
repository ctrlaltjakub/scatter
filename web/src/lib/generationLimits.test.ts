import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/store/types';
import { GENERATION_LIMITS, GenerationOutputLimitError, isOutputLimit, mainOutputTokens, modelOutputTokenLimit, normalizeGenerationLimits, secondaryOutputTokens } from './generationLimits';

describe('generation token limits', () => {
  it('keeps shipped limits and task proportions unchanged by default', () => {
    expect(normalizeGenerationLimits({})).toEqual({ generationLimitsVersion: 1, outputTokenCap: 16000, secondaryOutputTokenCap: 12000, interactiveOutputTokenCap: 50000 });
    expect(DEFAULT_SETTINGS.interactiveOutputTokenCap).toBe(GENERATION_LIMITS.interactiveOutputTokenCap.default);
    for (const budget of [256, 350, 900, 2000, 8000, 12000]) {
      expect(secondaryOutputTokens(DEFAULT_SETTINGS, budget)).toBe(budget);
    }
    expect(mainOutputTokens(16000, 8000)).toBe(8000);
    expect(mainOutputTokens(32000, 8000)).toBe(16000);
    expect(mainOutputTokens(32000)).toBe(32000);
    expect(secondaryOutputTokens({ secondaryOutputTokenCap: 24000 }, 256)).toBe(512);
  });
  it('preserves deliberate lower limits but still upgrades legacy non-editable defaults', () => {
    expect(normalizeGenerationLimits({ outputTokenCap: 8000 }).outputTokenCap).toBe(16000);
    expect(normalizeGenerationLimits({ generationLimitsVersion: 1, outputTokenCap: 8000 }).outputTokenCap).toBe(8000);
    expect(normalizeGenerationLimits({ generationLimitsVersion: 1, interactiveOutputTokenCap: 32000 }).interactiveOutputTokenCap).toBe(32000);
  });
  it.each([NaN, Infinity, -Infinity, '40000', null, undefined])('safely defaults invalid values: %s', value => {
    const limits = normalizeGenerationLimits({ generationLimitsVersion: 1, outputTokenCap: value, secondaryOutputTokenCap: value, interactiveOutputTokenCap: value });
    for (const key of Object.keys(GENERATION_LIMITS) as Array<keyof typeof GENERATION_LIMITS>) expect(limits[key]).toBe(GENERATION_LIMITS[key].default);
  });
  it('bounds imported budgets and never invents a missing provider ceiling', () => {
    expect(normalizeGenerationLimits({ generationLimitsVersion: 1, outputTokenCap: -50, interactiveOutputTokenCap: 1000000 })).toMatchObject({ outputTokenCap: 1000, interactiveOutputTokenCap: 128000 });
    expect(modelOutputTokenLimit(32000, { id: 'future', maxOutputTokens: 8192 })).toBe(8192);
    expect(modelOutputTokenLimit(4000, { id: 'future', maxOutputTokens: 8192 })).toBe(4000);
    expect(modelOutputTokenLimit(32000, { id: 'unknown' })).toBe(32000);
    expect(modelOutputTokenLimit(32000, { id: 'invalid', maxOutputTokens: NaN })).toBe(32000);
  });
  it.each(['main', 'secondary', 'interactive'] as const)('explains the %s limit and where to change it', role => {
    expect(new GenerationOutputLimitError(role).message).toContain('Settings → Models and generation → Generation token limits');
    expect(new GenerationOutputLimitError(role).message).toContain('Reasoning and the answer');
    expect(isOutputLimit('length')).toBe(true);
    expect(isOutputLimit('max_tokens')).toBe(true);
    expect(isOutputLimit('stop')).toBe(false);
  });
});
