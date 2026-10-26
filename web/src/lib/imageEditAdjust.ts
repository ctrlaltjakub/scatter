/**
 * Color adjustments for the image editor — the per-pixel core, Konva-free so
 * it stays testable in jsdom. One pass applies, in order: hue rotation
 * (standard Rec.709 hue-rotate matrix, same as CSS/SVG), saturation (luma
 * lerp), contrast (pivot at mid-gray), warmth (R up / B down). The Konva
 * filter wrapper that feeds this from node attrs lives in ImageEditorCanvas —
 * preview and baked export run this exact function, so WYSIWYG holds.
 *
 * All amounts are 0 = neutral: saturation/warmth/contrast −100..100,
 * hue −180..180 degrees.
 */
import type { Adjustments } from './imageEditElements';

export function applyAdjustments(data: Uint8ClampedArray, adj: Adjustments): void {
  const { saturation, warmth, contrast, hue } = adj;
  if (!saturation && !warmth && !contrast && !hue) return;

  const rad = (hue * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // CSS `hue-rotate` matrix (Rec.709 luma weights).
  const m00 = 0.213 + cos * 0.787 - sin * 0.213;
  const m01 = 0.715 - cos * 0.715 - sin * 0.715;
  const m02 = 0.072 - cos * 0.072 + sin * 0.928;
  const m10 = 0.213 - cos * 0.213 + sin * 0.143;
  const m11 = 0.715 + cos * 0.285 + sin * 0.14;
  const m12 = 0.072 - cos * 0.072 - sin * 0.283;
  const m20 = 0.213 - cos * 0.213 - sin * 0.787;
  const m21 = 0.715 - cos * 0.715 + sin * 0.715;
  const m22 = 0.072 + cos * 0.928 + sin * 0.072;

  const clampPct = (v: number) => Math.max(-100, Math.min(100, v));
  const satF = 1 + clampPct(saturation) / 100; // 0 (gray) .. 2 (double)
  const conF = 1 + clampPct(contrast) / 100;   // 0 (flat) .. 2 (harsh)

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]!;
    let g = data[i + 1]!;
    let b = data[i + 2]!;
    if (hue) {
      const nr = m00 * r + m01 * g + m02 * b;
      const ng = m10 * r + m11 * g + m12 * b;
      const nb = m20 * r + m21 * g + m22 * b;
      r = nr; g = ng; b = nb;
    }
    if (satF !== 1) {
      const luma = 0.213 * r + 0.715 * g + 0.072 * b;
      r = luma + (r - luma) * satF;
      g = luma + (g - luma) * satF;
      b = luma + (b - luma) * satF;
    }
    if (conF !== 1) {
      r = (r - 128) * conF + 128;
      g = (g - 128) * conF + 128;
      b = (b - 128) * conF + 128;
    }
    if (warmth) {
      r += warmth;
      b -= warmth;
    }
    // Uint8ClampedArray rounds + clamps assignments to 0..255 on its own.
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}
