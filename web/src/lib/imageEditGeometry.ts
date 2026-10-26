/**
 * Cropper geometry for the image editor — pure math, no DOM/Konva.
 *
 * Model (mirrors standard photo croppers): the image is first turned in 90°
 * steps (dimension swap), then a crop window lives in that turned frame, and
 * a fine "straighten" angle rotates the image about the CROP CENTER. The
 * straighten rotation must never expose empty corners inside the crop window,
 * so the image gets uniformly zoomed about the crop center by
 * `coverScaleForRotation` — the minimum scale at which the rotated image
 * still covers the whole crop rect.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const DEG = Math.PI / 180;

/**
 * Minimum uniform scale (≥ 1) applied to the image about the crop-rect center
 * so that, after rotating the image by `angleDeg` about that same center, the
 * crop rect is still fully covered by image pixels.
 *
 * Derivation: scaling the image by s about center C maps image point p to
 * C + s·(p − C); a crop corner q is covered iff C + (q′ − C)/s lies inside the
 * unrotated image, where q′ is q rotated by −angle about C. Each corner/edge
 * pair yields a lower bound on s; take the max.
 */
export function coverScaleForRotation(
  crop: Rect,
  imgW: number,
  imgH: number,
  angleDeg: number,
): number {
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  const cos = Math.cos(-angleDeg * DEG);
  const sin = Math.sin(-angleDeg * DEG);

  let s = 1;
  for (const [px, py] of [
    [crop.x, crop.y],
    [crop.x + crop.width, crop.y],
    [crop.x + crop.width, crop.y + crop.height],
    [crop.x, crop.y + crop.height],
  ] as const) {
    // Corner offset from the crop center, rotated by −angle.
    const dx0 = px - cx;
    const dy0 = py - cy;
    const ex = dx0 * cos - dy0 * sin;
    const ey = dx0 * sin + dy0 * cos;
    // Available image extent from C toward this corner's direction.
    if (ex < 0 && cx > 0) s = Math.max(s, -ex / cx);
    if (ex > 0 && imgW - cx > 0) s = Math.max(s, ex / (imgW - cx));
    if (ey < 0 && cy > 0) s = Math.max(s, -ey / cy);
    if (ey > 0 && imgH - cy > 0) s = Math.max(s, ey / (imgH - cy));
  }
  return s;
}

/** Keep a crop rect inside the image, respecting a minimum size. */
export function clampCropRect(rect: Rect, imgW: number, imgH: number, minSize: number): Rect {
  const width = Math.min(Math.max(rect.width, Math.min(minSize, imgW)), imgW);
  const height = Math.min(Math.max(rect.height, Math.min(minSize, imgH)), imgH);
  const x = Math.min(Math.max(rect.x, 0), imgW - width);
  const y = Math.min(Math.max(rect.y, 0), imgH - height);
  return { x, y, width, height };
}

/**
 * Drag one of the 8 crop handles by (dx, dy). Only the edges the handle owns
 * move; each is clamped to the image bounds and to `minSize` against its
 * opposite edge.
 */
export function resizeCropRect(
  rect: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
  minSize: number,
): Rect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes('w')) left = Math.min(Math.max(left + dx, 0), right - minSize);
  if (handle.includes('e')) right = Math.max(Math.min(right + dx, imgW), left + minSize);
  if (handle.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - minSize);
  if (handle.includes('s')) bottom = Math.max(Math.min(bottom + dy, imgH), top + minSize);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Bounding box of the (turned) image after the straighten transform: rotated
 * by `angleDeg` and scaled by `scale`, both about the crop-rect center — the
 * same transform the editor's world group applies. Used to size the crop-mode
 * view so image parts pushed outside the frame stay visible (dimmed).
 */
export function transformedImageBBox(
  imgW: number,
  imgH: number,
  crop: Rect,
  angleDeg: number,
  scale: number,
): Rect {
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  const cos = Math.cos(angleDeg * DEG);
  const sin = Math.sin(angleDeg * DEG);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [[0, 0], [imgW, 0], [imgW, imgH], [0, imgH]] as const) {
    const dx = px - cx;
    const dy = py - cy;
    const x = cx + scale * (dx * cos - dy * sin);
    const y = cy + scale * (dx * sin + dy * cos);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Smallest rect containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Image dimensions after a number of 90° turns. */
export function turnedDims(w: number, h: number, quarterTurns: number): { w: number; h: number } {
  return quarterTurns % 2 === 0 ? { w, h } : { w: h, h: w };
}

/**
 * Map a crop rect across one 90° turn of the image it lives in.
 * `imgW`/`imgH` are the dimensions BEFORE this turn; dir 1 = clockwise,
 * −1 = counter-clockwise. Four identical turns are the identity.
 */
export function rotateCropForQuarterTurn(
  rect: Rect,
  imgW: number,
  imgH: number,
  dir: 1 | -1,
): Rect {
  if (dir === 1) {
    // CW: (x, y) → (imgH − y, x)
    return {
      x: imgH - (rect.y + rect.height),
      y: rect.x,
      width: rect.height,
      height: rect.width,
    };
  }
  // CCW: (x, y) → (y, imgW − x)
  return {
    x: rect.y,
    y: imgW - (rect.x + rect.width),
    width: rect.height,
    height: rect.width,
  };
}

/**
 * Largest cursor image browsers honor. Chrome/Firefox don't CLAMP an oversize
 * `cursor: url(...)` — they DROP it and show the fallback keyword, so the
 * brush preview must switch rendering strategy at this size, not saturate.
 */
export const CURSOR_IMG_MAX = 128;

export type BrushCursorSpec =
  | { kind: 'svg'; size: number }      // cursor-image square, px (incl. 4px breathing room)
  | { kind: 'ring'; diameter: number } // Konva-drawn ring following the pointer, screen px
;

/**
 * How to preview the brush for an on-screen stroke diameter: a real cursor
 * image while it fits the browser cap (zero-lag, moves with the compositor),
 * a canvas-drawn ring beyond it.
 */
export function brushCursorSpec(screenBrushPx: number): BrushCursorSpec {
  const size = Math.max(6, screenBrushPx + 4);
  if (size <= CURSOR_IMG_MAX) return { kind: 'svg', size };
  return { kind: 'ring', diameter: screenBrushPx };
}
