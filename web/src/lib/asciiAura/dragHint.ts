import {
  statusGlyphIndex,
  type ScreenRect,
  type StatusCell,
} from './statusText';
import { labelWrapCandidates } from './arrowLabels';

export interface DragHintLayout {
  cells: StatusCell[];
  /** Full grid-aligned footprint, used to keep arrow labels out of the hint. */
  rect: ScreenRect;
}

/**
 * Place a drag hint beside the node's top-right pin. Prefer one line; when the
 * remaining screen width is tight, use the same word wrapping as arrow labels
 * with a strict two-line cap.
 */
export function layoutDragHint(opts: {
  text: string;
  node: ScreenRect;
  /** Other on-screen node cards that the hint must not cover. */
  blockedRects?: readonly ScreenRect[];
  cellPx: number;
  cols: number;
  rows: number;
  /** Exact CSS viewport dimensions; the final ceil-allocated cell may be partial. */
  screenW: number;
  screenH: number;
}): DragHintLayout | null {
  const text = opts.text.toUpperCase().replace(/\s+/g, ' ').trim();
  const startCol = Math.floor((opts.node.x + opts.node.w) / opts.cellPx) + 2;
  const balancedTwoLine = labelWrapCandidates(text, Math.max(1, text.length), 2)
    .find((candidate) => candidate.length === 2);
  // The 32px pin button starts 6px below the card top, so its centre is 22px
  // down. Align the hint block to that centre rather than the node border.
  const pinRow = Math.floor((opts.node.y + 22) / opts.cellPx);
  const rectFor = (candidate: readonly string[]): ScreenRect => {
    const maxLength = Math.max(0, ...candidate.map((line) => line.length));
    const row = pinRow - Math.floor(candidate.length / 2);
    return {
      x: startCol * opts.cellPx,
      y: row * opts.cellPx,
      w: maxLength * opts.cellPx,
      h: candidate.length * opts.cellPx,
    };
  };
  const overlaps = (a: ScreenRect, b: ScreenRect): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x
    && a.y < b.y + b.h && a.y + a.h > b.y;
  const fits = (candidate: readonly string[]): boolean => {
    const rect = rectFor(candidate);
    if (
      rect.x < 0 || rect.y < 0
      || rect.x + rect.w > opts.screenW
      || rect.y + rect.h > opts.screenH
    ) return false;
    return !(opts.blockedRects ?? []).some((blocked) => overlaps(rect, blocked));
  };
  const oneLine = [text];
  // Always prefer the original one-line form. Only use the balanced two-line
  // form when the full one-line footprint hits the screen edge or another card.
  // Like arrow labels, disappear rather than clipping when neither form fits.
  const lines = fits(oneLine)
    ? oneLine
    : balancedTwoLine && fits(balancedTwoLine)
      ? balancedTwoLine
      : null;
  if (!lines) return null;
  const layoutRect = rectFor(lines);
  const maxLineLength = layoutRect.w / opts.cellPx;
  const startRow = pinRow - Math.floor(lines.length / 2);
  const cells: StatusCell[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const row = startRow + lineIndex;
    const lineStart = startCol + Math.floor((maxLineLength - line.length) / 2);
    for (let charIndex = 0; charIndex < line.length; charIndex++) {
      const glyphIndex = statusGlyphIndex(line[charIndex]!);
      if (glyphIndex == null) continue;
      const col = lineStart + charIndex;
      if (col < 0 || col >= opts.cols || row < 0 || row >= opts.rows) continue;
      cells.push({ col, row, glyphIndex });
    }
  }

  return {
    cells,
    rect: layoutRect,
  };
}
