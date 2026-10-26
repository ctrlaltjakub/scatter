import type { Settings, CustomPrompts } from '@/store/types';
import { DEFAULT_PROMPTS } from './promptDefaults';
import { PROMPT_KEYS } from './promptCatalog';
import { DEFAULT_PHYSICS_CONFIG, PHYSICS_FIELD_RANGES, clampPhysicsConfig } from '@/physics/defaults';
import { DEFAULT_BULLET_SIZING_CONFIG, BULLET_SIZING_FIELD_RANGES, clampBulletSizingConfig } from './bulletSizingDefaults';
import { GENERATION_LIMITS, normalizeGenerationLimits } from './generationLimits';
import { stringHash as defaultFingerprint } from './stringHash';
export { stringHash as defaultFingerprint } from './stringHash';

/** A baseline identifier, not a saved configuration or a history. Keep this
 * hash identical to the former prompt-default hash for legacy migration. */
export interface AdvancedDefaults {
  prompts?: Partial<Record<keyof CustomPrompts, string>>;
  physics?: string;
  bulletSizing?: string;
  generationLimits?: string;
}

// Derived from shipped values: changing a default automatically invalidates
// only that prompt or developer-settings group, without a manual version bump.
export const CURRENT_ADVANCED_DEFAULTS: Required<AdvancedDefaults> = {
  prompts: Object.fromEntries(PROMPT_KEYS.map(key => [key, defaultFingerprint(DEFAULT_PROMPTS[key])])),
  physics: defaultFingerprint(JSON.stringify([DEFAULT_PHYSICS_CONFIG, PHYSICS_FIELD_RANGES])),
  bulletSizing: defaultFingerprint(JSON.stringify([DEFAULT_BULLET_SIZING_CONFIG, BULLET_SIZING_FIELD_RANGES])),
  generationLimits: defaultFingerprint(JSON.stringify(Object.entries(GENERATION_LIMITS).map(([key, rule]) => [key, rule.default, rule.min, rule.max, rule.step]))),
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Shared by startup, file import and sync. Never attach today's baseline to
 * an unchecked old override: that would let old exports undo an app update. */
export function normalizeAdvancedSettings(raw: Record<string, unknown>): Pick<Settings,
  'advancedDefaults' | 'customPrompts' | 'physicsConfig' | 'bulletSizingConfig'
  | 'outputTokenCap' | 'secondaryOutputTokenCap' | 'interactiveOutputTokenCap' | 'generationLimitsVersion'> {
  const baseline = record(raw.advancedDefaults);
  const prompts = record(raw.customPrompts);
  // Old exports already recorded prompt baselines; use them if present. Old
  // layout settings had none, so their defaults cannot be verified safely.
  const promptBaselines = record(baseline.prompts ?? raw.acknowledgedPromptDefaults);
  const customPrompts: Partial<CustomPrompts> = {};
  for (const key of PROMPT_KEYS) {
    if (typeof prompts[key] === 'string' && promptBaselines[key] === CURRENT_ADVANCED_DEFAULTS.prompts[key]) {
      customPrompts[key] = prompts[key];
    }
  }
  return {
    advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
    customPrompts: Object.keys(customPrompts).length ? customPrompts : undefined,
    physicsConfig: baseline.physics === CURRENT_ADVANCED_DEFAULTS.physics && raw.physicsConfig
      ? clampPhysicsConfig(record(raw.physicsConfig)) : undefined,
    bulletSizingConfig: baseline.bulletSizing === CURRENT_ADVANCED_DEFAULTS.bulletSizing && raw.bulletSizingConfig
      ? clampBulletSizingConfig(record(raw.bulletSizingConfig)) : undefined,
    ...normalizeGenerationLimits(baseline.generationLimits === CURRENT_ADVANCED_DEFAULTS.generationLimits ? raw : {}),
  };
}
