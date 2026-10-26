/**
 * R5 — glyph-atlas layout math (pure).
 *
 * The atlas is ONE row of square cells, one per glyph of the
 * flattened ramp (RAMP_FLAT order). Pass B addresses it as
 *   u = (glyphIndex * cellPx + inCellX + 0.5) / widthPx
 * with NEAREST sampling, so layout math is shared verbatim between
 * the rasterizer (atlas.ts, DOM-bound) and the shader's uv lookup.
 *
 * Sizes are DEVICE pixels: deviceCellPx = round(9 × dpr),
 * deviceFontPx = round(8 × dpr) — at dpr 1 identical to the 2D
 * path's 9 px cells / 8 px font; at higher dpr the glyphs rasterize
 * crisp at native resolution (user-approved sharpness change).
 */
import { RAMP_FLAT } from '../ramp';
import { STATUS_CHARS } from '../statusText';

/** Dedicated heavier copies: labels/selection borders keep their normal glyphs. */
export const BOLD_RAY_GLYPHS = ['_', '|', '\\', '/'] as const;
export const BOLD_RAY_GLYPH_OFFSET = RAMP_FLAT.length + STATUS_CHARS.length;

export function boldRayGlyphIndex(glyph: typeof BOLD_RAY_GLYPHS[number]): number {
  return BOLD_RAY_GLYPH_OFFSET + BOLD_RAY_GLYPHS.indexOf(glyph);
}

export interface AtlasLayout {
  glyphs: readonly string[];
  cellPx: number;
  fontPx: number;
  widthPx: number;
  heightPx: number;
}

/** Every glyph the atlas holds, in column order: the density ramp first
 *  (indices 0..RAMP_FLAT.length-1 — the cooling/glyph-pick parity with
 *  the GLSL port depends on these positions) then the status alphabet
 *  (Part F), addressed only via statusGlyphIndex, then bold ray variants.
 *  Appending variants preserves every existing ramp/status index. */
export const ATLAS_GLYPHS: readonly string[] = [...RAMP_FLAT, ...STATUS_CHARS, ...BOLD_RAY_GLYPHS];

export function atlasLayout(deviceCellPx: number, deviceFontPx: number): AtlasLayout {
  return {
    glyphs: ATLAS_GLYPHS,
    cellPx: deviceCellPx,
    fontPx: deviceFontPx,
    widthPx: deviceCellPx * ATLAS_GLYPHS.length,
    heightPx: deviceCellPx,
  };
}
