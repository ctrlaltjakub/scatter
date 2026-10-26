import type { ScreenRect, StatusCell } from './statusText';
import { labelWrapCandidates } from './arrowLabels';
import { statusGlyphIndex } from './statusText';

export interface ProjectSyncLabelLayout {
  cells: StatusCell[];
  rect: ScreenRect;
}

const EDGE_GAP_CELLS = 1;

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x
    && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Place the hovered project's sync state in the canvas ASCII grid. The label
 * begins beside the sidebar. It stays on one line whenever possible, then uses
 * the same two-line word wrapping as arrow labels to fit before an obstruction.
 * It never jumps across a node: if neither shape fits at the expected edge, it
 * disappears instead.
 */
export function layoutProjectSyncLabel(opts: {
  text: string;
  anchorY: number;
  leftInsetPx?: number;
  blockedRects: readonly ScreenRect[];
  cellPx: number;
  cols: number;
  rows: number;
  screenW: number;
  screenH: number;
}): ProjectSyncLabelLayout | null {
  const text = opts.text.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // The canvas covers the complete viewport and continues underneath the
  // sidebar. Begin one full cell after the visible sidebar edge rather than
  // one cell after canvas x=0, where an otherwise valid label would be hidden.
  const firstVisibleCol = Math.max(
    EDGE_GAP_CELLS,
    Math.ceil((opts.leftInsetPx ?? 0) / opts.cellPx) + EDGE_GAP_CELLS,
  );
  const maxCols = Math.max(1, opts.cols - firstVisibleCol - EDGE_GAP_CELLS);
  const candidates = labelWrapCandidates(text, maxCols, 2);
  if (candidates.length === 0) return null;

  for (const lines of candidates) {
    const widthCells = Math.max(...lines.map((line) => line.length));
    const heightCells = lines.length;
    const anchorRow = Math.round(opts.anchorY / opts.cellPx);
    const startRow = Math.max(
      EDGE_GAP_CELLS,
      Math.min(
        opts.rows - heightCells - EDGE_GAP_CELLS,
        anchorRow - Math.floor(heightCells / 2),
      ),
    );
    if (startRow < 0 || startRow + heightCells > opts.rows) continue;
    const startCol = firstVisibleCol;
    if (startCol + widthCells + EDGE_GAP_CELLS > opts.cols) continue;
    const rect: ScreenRect = {
      x: startCol * opts.cellPx,
      y: startRow * opts.cellPx,
      w: widthCells * opts.cellPx,
      h: heightCells * opts.cellPx,
    };
    if (rect.x + rect.w > opts.screenW || rect.y + rect.h > opts.screenH) continue;
    if (opts.blockedRects.some((blocked) => overlaps(rect, blocked))) continue;

    const cells: StatusCell[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const lineStart = startCol + Math.floor((widthCells - line.length) / 2);
      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        const glyphIndex = statusGlyphIndex(line[charIndex]!);
        if (glyphIndex == null) continue;
        cells.push({
          col: lineStart + charIndex,
          row: startRow + lineIndex,
          glyphIndex,
        });
      }
    }
    return { cells, rect };
  }
  return null;
}
