/** Overlay-text cells use A as a runtime-only rendering mode flag. */
export const INHERIT_OVERLAY_OPACITY_BYTE = 255;
/** Group labels inherit cell alpha but take RGB from an aura record. The two
 *  mode bytes encode the ninth record-index bit; B stores the lower 8 bits. */
export const GROUP_COLOR_RECORD_LOW_BYTE = 254;
export const GROUP_COLOR_RECORD_HIGH_BYTE = 253;
/** Project sync labels use a status-palette RGB while retaining the alpha of
 * the canvas cell they replace. */
export const PROJECT_COLOR_INHERIT_OPACITY_BYTE = 252;

/**
 * Write a label glyph that borrows the underlying aura cell's color and alpha.
 * By default an already-written status or higher-priority label is preserved.
 * Arrow-label animation may explicitly replace older arrow glyphs so active
 * entries retain the existing priority over disappearing entries.
 */
export function placeBorrowedOverlayGlyph(
  data: Uint8Array,
  base: number,
  glyphIndex: number,
  options: { replaceExisting?: boolean } = {},
): boolean {
  if (!options.replaceExisting && data[base] !== 0) return false;
  data[base] = glyphIndex;
  data[base + 2] = 0;
  data[base + 3] = INHERIT_OVERLAY_OPACITY_BYTE;
  return true;
}

/** Arrow labels replace older arrow glyphs, but never an occupied drag hint. */
export function placeArrowOverlayGlyph(
  data: Uint8Array,
  base: number,
  glyphIndex: number,
  options: { dragHintOccupied: boolean },
): boolean {
  if (options.dragHintOccupied) return false;
  return placeBorrowedOverlayGlyph(data, base, glyphIndex, { replaceExisting: true });
}

/** Write a group-label glyph using a packed aura record as its colour source. */
export function placeGroupOverlayGlyph(
  data: Uint8Array,
  base: number,
  glyphIndex: number,
  recordIndex: number,
  options: { protectedCell?: boolean; replaceExisting?: boolean } = {},
): boolean {
  if (options.protectedCell) return false;
  if (!options.replaceExisting && data[base] !== 0) return false;
  if (!Number.isInteger(recordIndex) || recordIndex < 0 || recordIndex > 511) return false;
  data[base] = glyphIndex;
  data[base + 2] = recordIndex & 0xff;
  data[base + 3] = recordIndex >= 256
    ? GROUP_COLOR_RECORD_HIGH_BYTE
    : GROUP_COLOR_RECORD_LOW_BYTE;
  return true;
}

/** Write a project-coloured label without turning it into an opaque UI badge. */
export function placeProjectColorOverlayGlyph(
  data: Uint8Array,
  base: number,
  glyphIndex: number,
  colorIndex: number,
  options: { protectedCell?: boolean; replaceExisting?: boolean } = {},
): boolean {
  if (options.protectedCell || (!options.replaceExisting && data[base] !== 0)) return false;
  if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex > 255) return false;
  data[base] = glyphIndex;
  data[base + 2] = colorIndex;
  data[base + 3] = PROJECT_COLOR_INHERIT_OPACITY_BYTE;
  return true;
}
