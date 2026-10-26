/**
 * The Scatter density ramp. 9 stages from sparsest (.) to densest (#).
 *
 * Letters are restricted to {s, S, c, C, t, T, r, R} — the user wants
 * the field to feel like a single repeated motif (the project name's
 * core consonant family) instead of a varied alphabet. Stages whose
 * letters have near-equal density hold multiple glyphs; pickGlyph
 * selects within a stage by a stable per-cell seed so adjacent
 * same-density cells show a mix without ever shimmering across frames.
 *
 * All glyphs are within the Basic Latin block, which Press Start 2P
 * covers completely.
 */
export const RAMP: readonly (readonly string[])[] = [
  ['.'],         // 0   baseline, everywhere outside auras
  [',', '`'],    // 1   sparsest punctuation pair
  [':'],         // 2
  [';'],         // 3
  ['r', 'c'],    // 4   lightest letters — narrow, open
  ['s', 't'],    // 5   medium-low letters
  ['C', 'T'],    // 6   medium-high uppercase
  ['S', 'R'],    // 7   densest letters
  ['#'],         // 8   densest, only right at the node border
] as const;

/** Map a density in [0, 1] to a stage index in [0, RAMP.length - 1].
 *  Clamps out-of-range inputs to the nearest end. */
export function densityToStage(density: number): number {
  if (density <= 0) return 0;
  if (density >= 1) return RAMP.length - 1;
  return Math.floor(density * RAMP.length);
}

/** Pick a glyph from a stage given a seed in [0, 1). For single-glyph
 *  stages the seed is ignored. */
export function pickGlyph(stage: number, seed: number): string {
  const pool = RAMP[stage]!;
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(seed * pool.length)));
  return pool[idx]!;
}

// ── R5 — flat tables for the glyph-atlas renderer ──────────────────
// The WebGL pass B addresses glyphs by index into ONE flat array (the
// atlas is a single row of cells in this order). Stage pools map into
// the flat array via offset + length, and the in-stage pick uses
// `hash % length` on the raw uint32 cell hash — bit-identical between
// TS and the GLSL uint port, unlike float `floor(seed * n)` which
// diverges at float32 precision boundaries.

/** All ramp glyphs concatenated in stage order. Atlas column i holds
 *  RAMP_FLAT[i]. */
export const RAMP_FLAT: readonly string[] = RAMP.flat();

/** Start index of each stage's pool inside RAMP_FLAT. */
export const STAGE_OFFSETS: readonly number[] = RAMP.reduce<number[]>(
  (offs, _pool, i) => {
    offs.push(i === 0 ? 0 : offs[i - 1]! + RAMP[i - 1]!.length);
    return offs;
  },
  [],
);

/** Pool size of each stage. */
export const STAGE_LENGTHS: readonly number[] = RAMP.map((pool) => pool.length);

/** Flat-array glyph index for a stage given the raw uint32 cell hash.
 *  Mirrored 1:1 in the pass-B fragment shader. */
export function glyphIndexByHash(stage: number, hashUint: number): number {
  return STAGE_OFFSETS[stage]! + (hashUint >>> 0) % STAGE_LENGTHS[stage]!;
}

/** Glyph string for a stage given the raw uint32 cell hash. */
export function pickGlyphByHash(stage: number, hashUint: number): string {
  return RAMP_FLAT[glyphIndexByHash(stage, hashUint)]!;
}
