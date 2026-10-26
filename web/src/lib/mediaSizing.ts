/**
 * Pure sizing math for media nodes — no DOM, unit-testable.
 *
 * A media node sizes itself to its content: an attached photo/video drives the
 * card width + body height from its intrinsic proportions (aspect-locked, never
 * cropped/stretched); the empty chooser sizes snugly to its explainer text.
 */
import { NODE_BODY_H_PADDING, DEFAULT_NODE_W, MIN_NODE_W } from './nodeSize';
// NODE_BODY_H_PADDING is used by chooserWidth (the chooser keeps body padding);
// attached media removes it, so aspectResize uses the full width.

/** Attached media can be narrower than a normal node (portraits) … */
export const MEDIA_MIN_W = 280;
/** Initial (spawn) width is capped at a normal text node's minimum width, so a
 *  big photo doesn't spawn as a huge node. Manual resizing has no upper cap. */
export const MEDIA_SPAWN_MAX_W = MIN_NODE_W;

/** Empty chooser width bounds — snug, well under a normal node. */
export const CHOOSER_MIN_W = 360;
export const CHOOSER_MAX_W = 560;
/** Breathing room past the widest explainer sentence. */
export const CHOOSER_SLACK = 24;
/** Fixed width of an empty media node (no photo/video attached yet). The empty
 *  card no longer sizes to its explainer text — it's a constant 400px and the
 *  text wraps within it. (Filled media still sizes to the photo/video aspect.) */
export const MEDIA_CHOOSER_W = 400;

export interface FitResult {
  width: number;          // total card width
  bodyMaxHeight: number;  // body height (content box) that preserves the ratio
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Height-per-unit-width. Falls back to 9:16 (i.e. 16:9 landscape) when the
 *  intrinsic dimensions are unknown — used for embeds before/without oEmbed. */
export function mediaHeightPerWidth(natW: number, natH: number): number {
  if (Number.isFinite(natW) && natW > 0 && Number.isFinite(natH) && natH > 0) return natH / natW;
  return 9 / 16;
}

/** Aspect-locked size for a proposed card width (used by interactive resize).
 *  Attached media fills the body edge-to-edge (its `.node-body` padding is
 *  removed via CSS), so the height is derived from the FULL card width. */
export function aspectResize(natW: number, natH: number, proposedW: number): FitResult {
  const width = Math.max(MEDIA_MIN_W, Math.round(Number.isFinite(proposedW) ? proposedW : MEDIA_MIN_W));
  const bodyMaxHeight = Math.max(1, Math.round(width * mediaHeightPerWidth(natW, natH)));
  return { width, bodyMaxHeight };
}

/** Initial size on attach: fit the media inside a SPAWN_MAX × SPAWN_MAX box,
 *  preserving aspect — so neither a wide nor a tall photo spawns oversized.
 *  (The user can still resize larger afterwards via aspectResize.) */
export function fitMediaToWidth(natW: number, natH: number, targetCardW?: number): FitResult {
  const r = mediaHeightPerWidth(natW, natH); // height per unit width
  let width = Math.min(targetCardW ?? (natW > 0 ? natW : DEFAULT_NODE_W), MEDIA_SPAWN_MAX_W);
  // If that width would make it taller than the box, drive from the height cap.
  if (width * r > MEDIA_SPAWN_MAX_W && r > 0) width = MEDIA_SPAWN_MAX_W / r;
  width = clamp(Math.round(width), MEDIA_MIN_W, MEDIA_SPAWN_MAX_W);
  const bodyMaxHeight = clamp(Math.round(width * r), 1, MEDIA_SPAWN_MAX_W);
  return { width, bodyMaxHeight };
}

/** Snug chooser width: the widest no-wrap explainer sentence + body padding +
 *  a little slack, clamped to the chooser bounds. */
export function chooserWidth(widestSentencePx: number): number {
  return clamp(Math.round(widestSentencePx) + NODE_BODY_H_PADDING + CHOOSER_SLACK, CHOOSER_MIN_W, CHOOSER_MAX_W);
}
