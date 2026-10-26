/**
 * R5 — aura/ghost record packing for the WebGL renderer.
 *
 * Pass A's fragment shader iterates a flat list of records uploaded
 * as an RGBA32F data texture: 4 texels (16 floats) per record.
 *
 *   T0  rect.x      rect.y      rect.w       rect.h     (world units)
 *   T1  radius      focused     alpha        kind
 *   T2  r           g           b            waveKind   (rgb 0-1)
 *   T3  elapsedMs   echo0|startR echo1        echo2
 *
 *   T3 dual use by waveKind: for a COLLAPSE ghost it is
 *   (elapsedMs, startRadius, —, —); for a ripple/recede aura it is up to
 *   FOUR concurrent ripple start times in ms-elapsed (the primary plus 3
 *   older overlapping echoes), with -1 marking an empty slot. R6.10.
 *
 * Invariants the shader relies on:
 *   - Records are packed auras-first (Map insertion order), then
 *     ghosts — a fixed candidate order (auras first, then ghosts), so
 *     the per-cell arbitration lottery picks deterministic winners.
 *   - `alpha` is pre-lerped on the CPU from the intensity tween
 *     (N multiplications per frame — not worth moving to the GPU).
 *   - Wave time is passed as ELAPSED milliseconds, never the raw
 *     performance.now() origin: float32 loses sub-ms precision past
 *     ~4.6 h of uptime (2^24 ms) and the envelopes need ms accuracy.
 */
import type { AuraEntry, Ghost } from '../sceneState';
import { AURA_RADIUS_FOCUSED, AURA_RADIUS_UNFOCUSED } from '../sceneState';
import type { Wave } from '../wave';
import type { GroupColor } from '@/store/types';

export const TEXELS_PER_RECORD = 4;
export const FLOATS_PER_RECORD = TEXELS_PER_RECORD * 4;
/** Hard cap on records per frame. Far above any realistic scene (the
 *  old CPU path was unusable two orders of magnitude earlier); packing
 *  truncates with a console.warn rather than corrupting the layout. */
export const MAX_RECORDS = 512;

export const KIND_AURA = 0;
export const KIND_GHOST = 1;
export const KIND_EXPLAIN_AURA = 2;
export const KIND_CHAT_AURA = 3;
export const EXPLAIN_QUESTION_MIN_STAGE = 6;
export const EXPLAIN_QUESTION_MAX_STAGE = 8;
export const EXPLAIN_QUESTION_SAMPLE_EVERY = 3;
const GLYPH_SEED_SCALE = 65536;

/** Mirrors the GLSL cell hash used by the aura renderer. */
function cellHash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul((h ^ (h >>> 13)) >>> 0, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Stable one-in-three sampler in the dense inner aura only. The steady-stage
 * gate prevents passing ripples from scattering questions into the outer aura. */
export function shouldUseExplainQuestion(
  x: number,
  y: number,
  glyphSeed: number,
  effectiveStage: number,
  steadyStage: number = effectiveStage,
): boolean {
  if (
    effectiveStage < EXPLAIN_QUESTION_MIN_STAGE
    || effectiveStage > EXPLAIN_QUESTION_MAX_STAGE
    || steadyStage < EXPLAIN_QUESTION_MIN_STAGE
  ) return false;
  let h = (cellHash(x, y) ^ (Math.imul(glyphSeed & 0xffff, -2048144789) >>> 0)) >>> 0;
  h = Math.imul((h ^ (h >>> 15)) >>> 0, -1028477387) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % EXPLAIN_QUESTION_SAMPLE_EVERY === 0;
}

export const WAVE_NONE = 0;
/** 'focus' and 'spawn' share one envelope (expanding water ripple). */
export const WAVE_RIPPLE = 1;
export const WAVE_COLLAPSE = 2;
/** 'unfocus' — the receding ripple (crest drains inward). */
export const WAVE_RECEDE = 3;

/** Numeric tint: rgb in [0, 1], plus the two steady alpha tiers.
 *  Resolved per accent by the renderer (DOM read, cached) and passed
 *  in so this module stays pure and unit-testable. */
export interface ResolvedTintNumeric {
  r: number;
  g: number;
  b: number;
  alphaBase: number;
  alphaFocus: number;
}

/**
 * Pack the scene into `out` (length ≥ MAX_RECORDS * FLOATS_PER_RECORD
 * or at least count * FLOATS_PER_RECORD). Returns the record count.
 */
export function packRecords(
  auras: Iterable<AuraEntry>,
  ghosts: Iterable<Ghost>,
  waves: ReadonlyMap<string, Wave>,
  focusEchoes: ReadonlyMap<string, readonly number[]>,
  now: number,
  resolveTint: (accent: GroupColor | null) => ResolvedTintNumeric,
  out: Float32Array,
): number {
  let n = 0;
  let truncated = false;

  for (const a of auras) {
    if (n >= MAX_RECORDS) { truncated = true; break; }
    const o = n * FLOATS_PER_RECORD;
    const tint = resolveTint(a.accent);
    const wave = waves.get(a.id);
    out[o] = a.rect.x;
    out[o + 1] = a.rect.y;
    out[o + 2] = a.rect.w;
    out[o + 3] = a.rect.h;
    out[o + 4] = a.focused ? AURA_RADIUS_FOCUSED : AURA_RADIUS_UNFOCUSED;
    out[o + 5] = a.focused ? 1 : 0;
    out[o + 6] = tint.alphaBase + a.intensity * (tint.alphaFocus - tint.alphaBase);
    out[o + 7] = a.isChat
      ? KIND_CHAT_AURA + (a.glyphSeed & 0xffff) / GLYPH_SEED_SCALE
      : a.isExplain
      ? KIND_EXPLAIN_AURA + (a.glyphSeed & 0xffff) / GLYPH_SEED_SCALE
      : KIND_AURA;
    out[o + 8] = tint.r;
    out[o + 9] = tint.g;
    out[o + 10] = tint.b;
    out[o + 11] = wave ? (wave.kind === 'unfocus' ? WAVE_RECEDE : WAVE_RIPPLE) : WAVE_NONE;
    out[o + 12] = wave ? now - wave.t0 : -1;
    // R6.10 — up to 3 older overlapping focus ripples; -1 = empty slot.
    out[o + 13] = -1;
    out[o + 14] = -1;
    out[o + 15] = -1;
    if (wave && wave.kind === 'focus') {
      const echoes = focusEchoes.get(a.id);
      if (echoes) {
        for (let k = 0; k < echoes.length && k < 3; k++) {
          out[o + 13 + k] = now - echoes[k]!;
        }
      }
    }
    n++;
  }

  for (const g of ghosts) {
    if (n >= MAX_RECORDS) { truncated = true; break; }
    const o = n * FLOATS_PER_RECORD;
    // Ghosts always render in the neutral baseline tint (this is how the
    // original CPU paint loop did it — s.baselineColor for ghost wins).
    const tint = resolveTint(null);
    out[o] = g.rect.x;
    out[o + 1] = g.rect.y;
    out[o + 2] = g.rect.w;
    out[o + 3] = g.rect.h;
    out[o + 4] = 0; // no steady radius — density comes from the collapse wave
    out[o + 5] = 0;
    out[o + 6] = tint.alphaBase;
    out[o + 7] = KIND_GHOST;
    out[o + 8] = tint.r;
    out[o + 9] = tint.g;
    out[o + 10] = tint.b;
    out[o + 11] = WAVE_COLLAPSE;
    out[o + 12] = now - g.wave.t0;
    out[o + 13] = g.wave.startRadius;
    out[o + 14] = 0;
    out[o + 15] = 0;
    n++;
  }

  if (truncated) {
    // eslint-disable-next-line no-console
    console.warn(`[asciiAura] record cap hit — scene exceeds ${MAX_RECORDS} auras+ghosts; extras not rendered`);
  }
  return n;
}
