/**
 * R5 — baseline-palette packing for the GL renderer.
 *
 * Builds the baseline palette: one entry per active group accent
 * (sorted by sceneState) at its alphaBase tier, plus a neutral entry
 * when any ungrouped node exists. Packed as a flat vec4 array for a
 * fragment-shader uniform; pass B indexes it with `cellHash % count`.
 */
import type { GroupColor } from '@/store/types';
import type { ResolvedTintNumeric } from './recordPacking';

/** Uniform array size — 14 Catppuccin accents + neutral, padded. */
export const MAX_PALETTE = 16;

export interface PaletteVec4 {
  /** MAX_PALETTE × 4 floats, rgba in [0, 1]; entries past `count`
   *  are zero. */
  data: Float32Array;
  count: number;
}

export function buildBaselinePaletteVec4(
  accents: readonly GroupColor[],
  anyUngrouped: boolean,
  resolveTint: (accent: GroupColor | null) => ResolvedTintNumeric,
  neutral: { r: number; g: number; b: number; a: number },
): PaletteVec4 {
  const data = new Float32Array(MAX_PALETTE * 4);
  let count = 0;
  for (const accent of accents) {
    if (count >= MAX_PALETTE) break;
    const t = resolveTint(accent);
    const o = count * 4;
    data[o] = t.r;
    data[o + 1] = t.g;
    data[o + 2] = t.b;
    data[o + 3] = t.alphaBase;
    count++;
  }
  if (anyUngrouped && count < MAX_PALETTE) {
    const o = count * 4;
    data[o] = neutral.r;
    data[o + 1] = neutral.g;
    data[o + 2] = neutral.b;
    data[o + 3] = neutral.a;
    count++;
  }
  return { data, count };
}
