import { statusGlyphIndex, type ScreenRect, type StatusCell } from './statusText';
import { placeBorrowedOverlayGlyph } from './gl/overlay';

export interface SelectionAura { rect: ScreenRect; radius: number; }

/** Rasterize the UNION of the selected auras, with a one-cell offscreen pad.
 * A shared silhouette naturally removes seams where two auras overlap. The
 * pad avoids inventing a border along the viewport edge when an aura is clipped. */
export function selectionAuraBorder(auras: readonly SelectionAura[], cell: number, cols: number, rows: number): StatusCell[] {
  if (!auras.length || cell <= 0 || cols <= 0 || rows <= 0) return [];
  const stride = cols + 2;
  const mask = new Uint8Array(stride * (rows + 2));
  for (const { rect, radius } of auras) {
    const x0 = Math.max(-1, Math.floor((rect.x - radius) / cell));
    const x1 = Math.min(cols, Math.ceil((rect.x + rect.w + radius) / cell));
    const y0 = Math.max(-1, Math.floor((rect.y - radius) / cell));
    const y1 = Math.min(rows, Math.ceil((rect.y + rect.h + radius) / cell));
    for (let row = y0; row <= y1; row++) {
      const y = (row + 0.5) * cell;
      const dy = Math.max(rect.y - y, 0, y - rect.y - rect.h);
      for (let col = x0; col <= x1; col++) {
        const x = (col + 0.5) * cell;
        const dx = Math.max(rect.x - x, 0, x - rect.x - rect.w);
        if (dx * dx + dy * dy <= radius * radius) mask[(row + 1) * stride + col + 1] = 1;
      }
    }
  }
  const border: StatusCell[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const i = (row + 1) * stride + col + 1;
    if (!mask[i] || (mask[i - 1] && mask[i + 1] && mask[i - stride] && mask[i + stride])) continue;
    // Sobel normal: smoothly rotate /, \, |, _ around curved corners instead
    // of boxing each card separately. All glyphs remain on the shared grid.
    const nx = mask[i - stride - 1]! + 2 * mask[i - 1]! + mask[i + stride - 1]!
      - mask[i - stride + 1]! - 2 * mask[i + 1]! - mask[i + stride + 1]!;
    const ny = mask[i - stride - 1]! + 2 * mask[i - stride]! + mask[i - stride + 1]!
      - mask[i + stride - 1]! - 2 * mask[i + stride]! - mask[i + stride + 1]!;
    const glyph = Math.abs(nx) > 2 * Math.abs(ny) ? '|' : Math.abs(ny) > 2 * Math.abs(nx) ? '_'
      : nx * ny > 0 ? '/' : '\\';
    border.push({ col, row, glyphIndex: statusGlyphIndex(glyph)! });
  }
  return border;
}

/** Lowest-priority shape overlay. Retains both RGB and alpha; yields to text,
 * its negative aura, arrow clearing, and node cards. No opacity floor. */
export function paintSelectionOverlay(
  data: Uint8Array, cols: number, rows: number, cell: number,
  border: readonly StatusCell[], marquee: ScreenRect | null, blocked: readonly ScreenRect[],
): void {
  const blockedMask = new Uint8Array(cols * rows);
  for (const rect of blocked) {
    const from = Math.max(0, Math.min(cols, Math.floor(rect.x / cell)));
    const to = Math.max(0, Math.min(cols, Math.ceil((rect.x + rect.w) / cell)));
    if (from >= to) continue;
    for (let row = Math.max(0, Math.floor(rect.y / cell)); row < Math.min(rows, Math.ceil((rect.y + rect.h) / cell)); row++) {
      blockedMask.fill(1, row * cols + from, row * cols + to);
    }
  }
  const paint = (col: number, row: number, glyphIndex: number) => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const index = row * cols + col;
    const base = index * 4;
    if (blockedMask[index] || data[base + 1]) return;
    placeBorrowedOverlayGlyph(data, base, glyphIndex);
  };
  if (marquee) {
    const glyphIndex = statusGlyphIndex('+')!;
    for (let row = Math.max(0, Math.ceil(marquee.y / cell - 0.5)); row <= Math.min(rows - 1, Math.floor((marquee.y + marquee.h) / cell - 0.5)); row++) {
      for (let col = Math.max(0, Math.ceil(marquee.x / cell - 0.5)); col <= Math.min(cols - 1, Math.floor((marquee.x + marquee.w) / cell - 0.5)); col++) paint(col, row, glyphIndex);
    }
  }
  // While drawing, '+' owns cells inside the rectangle; the outline stays
  // visible on the portions of the aura silhouette outside it.
  for (const part of border) paint(part.col, part.row, part.glyphIndex);
}
