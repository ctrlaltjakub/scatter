/**
 * R5 — glyph-atlas rasterization (DOM-bound thin layer).
 *
 * Draws the flattened ramp into an offscreen Canvas2D using a standard
 * fillText call shape (textBaseline 'top', glyph at the cell origin), so
 * glyphs are crisp at dpr 1 — and natively crisper at higher dpr
 * (cells/font scale by the device pixel ratio).
 *
 * Layout math lives in atlasLayout.ts (pure, unit-tested); this file
 * only rasterizes. White glyphs on transparent: pass B multiplies by
 * the per-cell color, using the atlas alpha as glyph coverage.
 */
import { atlasLayout, BOLD_RAY_GLYPH_OFFSET, type AtlasLayout } from './atlasLayout';

const FONT_FAMILY = "'Press Start 2P', monospace";

export interface BuiltAtlas {
  canvas: HTMLCanvasElement;
  layout: AtlasLayout;
}

export function buildAtlasCanvas(deviceCellPx: number, deviceFontPx: number): BuiltAtlas | null {
  const layout = atlasLayout(deviceCellPx, deviceFontPx);
  const canvas = document.createElement('canvas');
  canvas.width = layout.widthPx;
  canvas.height = layout.heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, layout.widthPx, layout.heightPx);
  ctx.font = `${layout.fontPx}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  // Add 0.375 CSS px on either side of the existing outline at the nominal
  // 8px font size. Keep the font/position unchanged and scale for native DPR.
  ctx.lineWidth = layout.fontPx / 8 * 0.75;
  ctx.lineJoin = 'round';
  for (let i = 0; i < layout.glyphs.length; i++) {
    const x = i * layout.cellPx;
    // The advance width is not the raster bounds: Windows font smoothing can
    // cover a pixel to the left of the glyph origin. Without a per-cell clip,
    // that pixel becomes a faint vertical edge on the PREVIOUS atlas glyph.
    // Isolate ordinary letters as well as the expanded bold-ray strokes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, 0, layout.cellPx, layout.cellPx);
    ctx.clip();
    if (i >= BOLD_RAY_GLYPH_OFFSET) {
      ctx.strokeText(layout.glyphs[i]!, x, 0);
    }
    ctx.fillText(layout.glyphs[i]!, x, 0);
    ctx.restore();
  }
  return { canvas, layout };
}
