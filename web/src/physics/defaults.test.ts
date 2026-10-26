import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PHYSICS_CONFIG, PHYSICS_FIELD_RANGES, clampPhysicsConfig,
} from './defaults';

describe('PHYSICS_FIELD_RANGES', () => {
  it('every default value is inside its range', () => {
    for (const k of Object.keys(PHYSICS_FIELD_RANGES) as (keyof typeof PHYSICS_FIELD_RANGES)[]) {
      const r = PHYSICS_FIELD_RANGES[k];
      const v = DEFAULT_PHYSICS_CONFIG[k];
      expect(v).toBeGreaterThanOrEqual(r.min);
      expect(v).toBeLessThanOrEqual(r.max);
    }
  });
});

describe('clampPhysicsConfig', () => {
  it('returns defaults when input is empty', () => {
    expect(clampPhysicsConfig({})).toEqual(DEFAULT_PHYSICS_CONFIG);
  });
  it('clamps out-of-range values', () => {
    const out = clampPhysicsConfig({ linkDistance: 99999, linkStrength: -5 });
    // linkDistance max is now 800 (border-distance ranges)
    expect(out.linkDistance).toBe(800);
    expect(out.linkStrength).toBe(0);
  });
  it('passes through valid values', () => {
    const out = clampPhysicsConfig({ linkDistance: 600 });
    expect(out.linkDistance).toBe(600);
  });
  it('ignores non-numeric values', () => {
    const out = clampPhysicsConfig({ linkDistance: NaN });
    expect(out.linkDistance).toBe(DEFAULT_PHYSICS_CONFIG.linkDistance);
  });
});
