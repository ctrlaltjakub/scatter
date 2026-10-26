import type { BulletSizingConfig } from '@/store/types';

/** Defaults match what AdaptiveBullets.tsx ships with. The user can
 *  override any field via the dev settings; the cascade falls back to
 *  these when no override is set. */
export const DEFAULT_BULLET_SIZING_CONFIG: BulletSizingConfig = {
  // Safety margins were 0.40 → 0.60 during the debugging journey but the
  // hidden-lab measurements at MEASURE_WIDTH (narrowest preset) combined
  // with the width-preset system have made the strict A/B math reliable
  // enough that no extra buffer is needed by default. User can still
  // dial these up via dev settings if a specific node misbehaves.
  safetyFraction: 0,
  safetyMinPx: 0,
  overflowTolerance: 8,
  underflowTolerance: 4,
  maxAdjustmentIter: 60,
};

export interface FieldRange { min: number; max: number; step: number; }

export const BULLET_SIZING_FIELD_RANGES: Record<keyof BulletSizingConfig, FieldRange> = {
  safetyFraction:     { min: 0,    max: 1,    step: 0.01 },
  safetyMinPx:        { min: 0,    max: 300,  step: 5 },
  overflowTolerance:  { min: 0,    max: 50,   step: 1 },
  underflowTolerance: { min: 0,    max: 50,   step: 1 },
  maxAdjustmentIter:  { min: 10,   max: 300,  step: 5 },
};

/** Snap each numeric field into its declared range. Drops invalid keys. */
export function clampBulletSizingConfig(input: Partial<BulletSizingConfig>): BulletSizingConfig {
  const out: BulletSizingConfig = { ...DEFAULT_BULLET_SIZING_CONFIG };
  for (const k of Object.keys(BULLET_SIZING_FIELD_RANGES) as (keyof BulletSizingConfig)[]) {
    const v = input[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = BULLET_SIZING_FIELD_RANGES[k];
    out[k] = Math.max(r.min, Math.min(r.max, v));
  }
  return out;
}
