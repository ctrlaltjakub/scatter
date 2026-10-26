/**
 * R5.4 — tests for the GPU cooling encoding + time-based step.
 *
 * The 2D path cools one ramp stage per paint at the 50 ms urgent
 * cadence (coolStage in cellDiff.ts). The GPU path is frame-rate
 * independent: displayed stage decays at COOL_STAGES_PER_SEC, with
 * the fractional part carried in a second byte of the RGBA8 cell-
 * state texture. These TS functions are the spec the GLSL mirrors —
 * and the simulation test pins parity with the legacy per-paint step.
 */
import { describe, test, expect } from 'vitest';
import { coolStage } from '../cellDiff';
import {
  COOL_STAGES_PER_SEC,
  coolDisplayedStage,
  encodeStageBytes,
  decodeStageBytes,
} from './coolingEncode';

describe('coolDisplayedStage', () => {
  test('heating is instant', () => {
    expect(coolDisplayedStage(2, 7, 16)).toBe(7);
    expect(coolDisplayedStage(0, 3, 0)).toBe(3);
  });

  test('cooling decays at COOL_STAGES_PER_SEC and floors at the target', () => {
    // 50 ms at 20 stages/sec = exactly 1 stage.
    expect(coolDisplayedStage(8, 0, 50)).toBe(7);
    // 25 ms = half a stage.
    expect(coolDisplayedStage(8, 0, 25)).toBeCloseTo(7.5, 6);
    // Huge dt clamps to target, never below.
    expect(coolDisplayedStage(8, 3, 10_000)).toBe(3);
    expect(coolDisplayedStage(1, 0, 10_000)).toBe(0);
  });

  test('matches legacy coolStage chain when stepped at the 50 ms urgent cadence', () => {
    let legacy = 8;
    let gpu = 8;
    for (let i = 0; i < 10; i++) {
      legacy = coolStage(legacy, 0);
      gpu = coolDisplayedStage(gpu, 0, 50);
      expect(gpu).toBeCloseTo(legacy, 6);
    }
  });
});

describe('stage byte encoding (RGBA8 R + G channels)', () => {
  test('round-trips integer stages exactly', () => {
    for (let stage = 0; stage <= 8; stage++) {
      const [r, g] = encodeStageBytes(stage);
      expect(decodeStageBytes(r, g)).toBe(stage);
    }
  });

  test('round-trips fractional stages within one G-byte quantum (1/255)', () => {
    for (const s of [0.25, 1.5, 3.7, 7.996]) {
      const [r, g] = encodeStageBytes(s);
      expect(decodeStageBytes(r, g)).toBeCloseTo(s, 2);
      expect(Math.abs(decodeStageBytes(r, g) - s)).toBeLessThanOrEqual(1 / 255 + 1e-9);
    }
  });

  test('bytes stay in [0, 255]', () => {
    for (const s of [0, 0.004, 7.999, 8]) {
      const [r, g] = encodeStageBytes(s);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(Number.isInteger(r)).toBe(true);
      expect(Number.isInteger(g)).toBe(true);
    }
  });
});

test('cooling rate constant matches the legacy cadence (1 stage / 50 ms)', () => {
  expect(COOL_STAGES_PER_SEC).toBe(20);
});
