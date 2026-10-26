/**
 * Reading-ruler visual-line model (pure — no DOM).
 *
 * The DOM glue (readingDom.ts) measures each cluster's client rects and
 * hands the zoom-normalized pieces here as FRAGMENTS: one fragment = the
 * part of one cluster that sits on one visual line (a wrapped cluster
 * yields several fragments with split char ranges). This module turns
 * fragments into LINES:
 *
 *   - a line's char range runs from its first to its last character
 *     (interior whitespace between clusters included, wrapped clusters
 *     split at the measured break), which is exactly what the line
 *     highlight paints;
 *   - `firstClusterIdx` is the first cluster in the line's reading direction —
 *     the "first word" the word mode lands on, even when the line starts
 *     with the tail of a cluster that began on the line above;
 *   - `clusterHomeLine[k]` is the line where cluster k BEGINS — used to
 *     snap the line highlight while stepping cluster by cluster.
 */

export interface Fragment {
  /** Independent reading lane, in DOM order (e.g. one table cell). */
  flow?: number;
  clusterIdx: number;
  start: number; // char range of this piece within the section text
  end: number; // exclusive
  top: number; // geometry, zoom-normalized px
  left: number;
  height: number;
}

export interface Line {
  start: number;
  end: number; // exclusive
  firstClusterIdx: number;
  /** Last cluster in this line's reading direction. */
  lastClusterIdx: number;
}

export interface LineModelData {
  lines: Line[];
  /** Per clusterIdx: index of the line the cluster starts on (-1 = unmeasured). */
  clusterHomeLine: number[];
}

export function groupIntoLines(fragments: Fragment[], rtl = false): LineModelData {
  if (fragments.length === 0) return { lines: [], clusterHomeLine: [] };

  const sorted = [...fragments].sort(
    (a, b) => (a.flow ?? 0) - (b.flow ?? 0) || a.top - b.top || (rtl ? a.start - b.start : a.left - b.left) || a.start - b.start,
  );

  const lines: Line[] = [];
  const fragLine: number[] = []; // per sorted fragment → its line index
  let lineTop = 0;
  let refHeight = 0;
  let flow = -1;
  for (const f of sorted) {
    // New line when the top jumps by more than half a line — absorbs the
    // sub-pixel jitter different inline elements (chips, bold) produce.
    const open = lines[lines.length - 1];
    if (!open || (f.flow ?? 0) !== flow || f.top > lineTop + refHeight / 2) {
      lines.push({ start: f.start, end: f.end, firstClusterIdx: f.clusterIdx, lastClusterIdx: f.clusterIdx });
      lineTop = f.top;
      refHeight = f.height;
      flow = f.flow ?? 0;
    } else {
      open.start = Math.min(open.start, f.start);
      open.end = Math.max(open.end, f.end);
      open.lastClusterIdx = f.clusterIdx;
    }
    fragLine.push(lines.length - 1);
  }

  const maxCluster = Math.max(...sorted.map((f) => f.clusterIdx));
  const clusterHomeLine = new Array<number>(maxCluster + 1).fill(-1);
  const bestStart = new Array<number>(maxCluster + 1).fill(Infinity);
  sorted.forEach((f, i) => {
    if (f.start < (bestStart[f.clusterIdx] ?? Infinity)) {
      bestStart[f.clusterIdx] = f.start;
      clusterHomeLine[f.clusterIdx] = fragLine[i] ?? -1;
    }
  });

  return { lines, clusterHomeLine };
}

/**
 * Smallest offset in (lo, hi] where a monotone predicate flips to true.
 * Used by readingDom to find the exact char where a wrapped cluster breaks
 * onto the next line (predicate = "Range(start, o) spans another line");
 * the predicate is injected so this stays testable without layout.
 */
export function findWrapBreak(pred: (o: number) => boolean, lo: number, hi: number): number {
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
