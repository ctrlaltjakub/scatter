/**
 * R5.4 — tests for the GL aura/ghost record packing.
 *
 * Records are uploaded as an RGBA32F data texture: 4 texels
 * (16 floats) per record. The shader's candidate loop iterates
 * records in packed order, which must equal the 2D renderer's
 * candidate order (auras in Map insertion order, then ghosts) so
 * the arbitration lottery picks the same winners.
 */
import { describe, test, expect, vi } from 'vitest';
import type { AuraEntry, Ghost } from '../sceneState';
import type { Wave } from '../wave';
import {
  packRecords,
  FLOATS_PER_RECORD,
  TEXELS_PER_RECORD,
  MAX_RECORDS,
  KIND_AURA,
  KIND_EXPLAIN_AURA,
  KIND_CHAT_AURA,
  KIND_GHOST,
  WAVE_NONE,
  WAVE_RIPPLE,
  WAVE_COLLAPSE,
  WAVE_RECEDE,
  type ResolvedTintNumeric,
  shouldUseExplainQuestion,
} from './recordPacking';

const TINT: ResolvedTintNumeric = {
  r: 136 / 255, g: 57 / 255, b: 239 / 255,
  alphaBase: 0.2, alphaFocus: 0.55,
};
const FALLBACK_TINT: ResolvedTintNumeric = {
  r: 0, g: 0, b: 0, alphaBase: 0.06, alphaFocus: 0.16,
};
const resolveTint = (accent: string | null): ResolvedTintNumeric =>
  accent ? TINT : FALLBACK_TINT;

/** No overlapping focus echoes for most tests. */
const NO_ECHOES = new Map<string, readonly number[]>();

function makeAura(id: string, over: Partial<AuraEntry> = {}): AuraEntry {
  return {
    id,
    rect: { x: 100, y: 200, w: 480, h: 240 },
    focused: false,
    accent: 'mauve',
    intensity: 0,
    intensityFrom: 0,
    intensityFlipAt: 0,
    isExplain: false,
    isChat: false,
    glyphSeed: 0,
    ...over,
  };
}

function makeGhost(id: string, t0: number): Ghost {
  return {
    id,
    rect: { x: 50, y: 60, w: 300, h: 150 },
    wave: { kind: 'collapse', t0, startRadius: 200 },
  };
}

test('layout constants are consistent', () => {
  expect(FLOATS_PER_RECORD).toBe(TEXELS_PER_RECORD * 4);
});

describe('packRecords', () => {
  test('packs an unfocused aura without wave into the documented texel layout', () => {
    const out = new Float32Array(FLOATS_PER_RECORD * 4);
    const n = packRecords([makeAura('a')], [], new Map(), NO_ECHOES, 1000, resolveTint, out);
    expect(n).toBe(1);
    // T0: rect
    expect(Array.from(out.slice(0, 4))).toEqual([100, 200, 480, 240]);
    // T1: radius (unfocused = 200), focused 0, alpha = alphaBase, kind aura
    expect(out[4]).toBe(200);
    expect(out[5]).toBe(0);
    expect(out[6]).toBeCloseTo(0.2, 6);
    expect(out[7]).toBe(KIND_AURA);
    // T2: rgb + waveKind none
    expect(out[8]).toBeCloseTo(136 / 255, 6);
    expect(out[9]).toBeCloseTo(57 / 255, 6);
    expect(out[10]).toBeCloseTo(239 / 255, 6);
    expect(out[11]).toBe(WAVE_NONE);
    // T3: no wave → all ripple slots empty (-1)
    expect(out[12]).toBe(-1);
    expect(out[13]).toBe(-1);
    expect(out[14]).toBe(-1);
    expect(out[15]).toBe(-1);
  });

  test('focused aura: radius 300 and intensity-lerped alpha', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    packRecords(
      [makeAura('a', { focused: true, intensity: 0.5 })],
      [], new Map(), NO_ECHOES, 1000, resolveTint, out,
    );
    expect(out[4]).toBe(300);
    expect(out[5]).toBe(1);
    // alphaBase + 0.5 * (alphaFocus - alphaBase) = 0.2 + 0.5*0.35
    expect(out[6]).toBeCloseTo(0.375, 6);
  });

  test('packs explain identity and its stable glyph seed without changing normal auras', () => {
    const out = new Float32Array(FLOATS_PER_RECORD * 2);
    packRecords(
      [makeAura('normal'), makeAura('explain', { isExplain: true, glyphSeed: 43210 })],
      [], new Map(), NO_ECHOES, 0, resolveTint, out,
    );
    expect(out[7]).toBe(KIND_AURA);
    const encodedExplain = out[FLOATS_PER_RECORD + 7]!;
    expect(Math.floor(encodedExplain)).toBe(KIND_EXPLAIN_AURA);
    expect(Math.round((encodedExplain - KIND_EXPLAIN_AURA) * 65536)).toBe(43210);
  });

  test('packs chat identity at both focus levels without altering the focus tint', () => {
    for (const focused of [false, true]) {
      const out = new Float32Array(FLOATS_PER_RECORD);
      packRecords([makeAura('chat', { isChat: true, focused, intensity: focused ? 1 : 0 })],
        [], new Map(), NO_ECHOES, 0, resolveTint, out);
      expect(out[7]).toBe(KIND_CHAT_AURA);
      expect(out[6]).toBeCloseTo(focused ? TINT.alphaFocus : TINT.alphaBase);
    }
  });

  test('preserves the chat glyph seed so randomized ray rows differ per node', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    packRecords([makeAura('chat', { isChat: true, glyphSeed: 65535 })],
      [], new Map(), NO_ECHOES, 0, resolveTint, out);
    expect(Math.floor(out[7]!)).toBe(KIND_CHAT_AURA);
    expect(Math.round((out[7]! - KIND_CHAT_AURA) * 65536)).toBe(65535);
  });

  test('question marks sample about one in three cells only in the dense inner aura', () => {
    const seed = 43210;
    for (const stage of [0, 1, 2, 3, 4, 5]) {
      expect(Array.from({ length: 500 }, (_, i) =>
        shouldUseExplainQuestion(i % 50, Math.floor(i / 50), seed, stage),
      ).some(Boolean)).toBe(false);
    }
    for (const stage of [6, 7, 8]) {
      const samples = Array.from({ length: 10_000 }, (_, i) =>
        shouldUseExplainQuestion(i % 100, Math.floor(i / 100), seed, stage),
      );
      const ratio = samples.filter(Boolean).length / samples.length;
      expect(ratio).toBeGreaterThan(0.31);
      expect(ratio).toBeLessThan(0.35);
    }
  });

  test('ripples cannot push question marks out into normally sparse cells', () => {
    for (const steadyStage of [0, 1, 2, 3, 4, 5]) {
      expect(Array.from({ length: 500 }, (_, i) =>
        shouldUseExplainQuestion(i % 50, Math.floor(i / 50), 43210, 8, steadyStage),
      ).some(Boolean)).toBe(false);
    }
  });

  test('aura wave: ripple kind + elapsed (never raw t0 — float32 precision)', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    const waves = new Map<string, Wave>([['a', { kind: 'focus', t0: 800 }]]);
    packRecords([makeAura('a')], [], waves, NO_ECHOES, 1000, resolveTint, out);
    expect(out[11]).toBe(WAVE_RIPPLE);
    expect(out[12]).toBe(200); // elapsed = now - t0 (primary)
    // No echoes → the 3 overlap slots stay empty.
    expect(out[13]).toBe(-1);
    expect(out[14]).toBe(-1);
    expect(out[15]).toBe(-1);
  });

  test('R6.10 — overlapping focus echoes pack into T3.yzw as ms-elapsed', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    const waves = new Map<string, Wave>([['a', { kind: 'focus', t0: 900 }]]);
    const echoes = new Map<string, readonly number[]>([['a', [700, 500]]]);
    packRecords([makeAura('a')], [], waves, echoes, 1000, resolveTint, out);
    expect(out[11]).toBe(WAVE_RIPPLE);
    expect(out[12]).toBe(100); // primary elapsed (now 1000 - 900)
    expect(out[13]).toBe(300); // echo 0 elapsed (1000 - 700)
    expect(out[14]).toBe(500); // echo 1 elapsed (1000 - 500)
    expect(out[15]).toBe(-1);  // unused
  });

  test('R6.10 — echoes are ignored for a non-focus primary wave', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    const waves = new Map<string, Wave>([['a', { kind: 'unfocus', t0: 700 }]]);
    const echoes = new Map<string, readonly number[]>([['a', [600]]]);
    packRecords([makeAura('a')], [], waves, echoes, 1000, resolveTint, out);
    expect(out[11]).toBe(WAVE_RECEDE);
    expect(out[12]).toBe(300); // primary elapsed
    expect(out[13]).toBe(-1);  // unfocus does not stack echoes
  });

  test('spawn waves use the same ripple envelope as focus waves', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    const waves = new Map<string, Wave>([['a', { kind: 'spawn', t0: 900 }]]);
    packRecords([makeAura('a')], [], waves, NO_ECHOES, 1000, resolveTint, out);
    expect(out[11]).toBe(WAVE_RIPPLE);
    expect(out[12]).toBe(100);
  });

  test('unfocus waves map to the receding-ripple kind', () => {
    const out = new Float32Array(FLOATS_PER_RECORD);
    const waves = new Map<string, Wave>([['a', { kind: 'unfocus', t0: 700 }]]);
    packRecords([makeAura('a')], [], waves, NO_ECHOES, 1000, resolveTint, out);
    expect(out[11]).toBe(WAVE_RECEDE);
    expect(out[12]).toBe(300); // elapsed
  });

  test('ghosts pack after all auras with collapse wave + startRadius + baseline tint', () => {
    const out = new Float32Array(FLOATS_PER_RECORD * 3);
    const n = packRecords(
      [makeAura('a1'), makeAura('a2')],
      [makeGhost('g1', 950)],
      new Map(), NO_ECHOES, 1000, resolveTint, out,
    );
    expect(n).toBe(3);
    const g = out.subarray(FLOATS_PER_RECORD * 2);
    expect(Array.from(g.slice(0, 4))).toEqual([50, 60, 300, 150]);
    expect(g[7]).toBe(KIND_GHOST);
    expect(g[8]).toBe(0); // baseline tint rgb
    expect(g[6]).toBeCloseTo(0.06, 6); // ghost alpha = fallback alphaBase
    expect(g[11]).toBe(WAVE_COLLAPSE);
    expect(g[12]).toBe(50);  // elapsed
    expect(g[13]).toBe(200); // startRadius
  });

  test('caps at MAX_RECORDS with a console warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const auras = Array.from({ length: MAX_RECORDS + 5 }, (_, i) => makeAura(`a${i}`));
    const out = new Float32Array(FLOATS_PER_RECORD * MAX_RECORDS);
    const n = packRecords(auras, [], new Map(), NO_ECHOES, 0, resolveTint, out);
    expect(n).toBe(MAX_RECORDS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
