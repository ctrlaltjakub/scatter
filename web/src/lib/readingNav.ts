/**
 * Reading-ruler key state machine (pure — no DOM, no stores).
 *
 * One function decides what each arrow key does given the current reading
 * position and the shape of the active section. The controller
 * (readingController.ts) executes the returned action: painting moves,
 * stepping the active section for crossings, or tearing the mode down.
 *
 * Horizontal arrows enter/step word mode; vertical arrows always move in line
 * mode. Pointer clicks and Escape own teardown, so arrow navigation never
 * switches the ruler off.
 */

export type ArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/** What the active section looks like (derived from the line model). */
export interface SectionShape {
  lineCount: number;
  clusterCount: number;
  /** Per line: the cluster its leftmost fragment belongs to. */
  firstClusterOnLine: number[];
  /** Per line: the cluster its rightmost fragment belongs to. */
  lastClusterOnLine: number[];
  /** Per cluster: the line it starts on. */
  clusterHomeLine: number[];
}

/** Where the current section sits in the node's stop sequence. */
export interface NavCtx {
  atFirstStop: boolean;
  atLastStop: boolean;
}

export interface ReadingPos {
  lineIdx: number;
  /** null = line mode; a number = word mode on that cluster. */
  clusterIdx: number | null;
}

export type ReadingAction =
  | { kind: 'start'; wordMode: boolean }
  | { kind: 'move'; lineIdx: number; clusterIdx: number | null }
  | { kind: 'crossSection'; dir: 1 | -1; wordMode: boolean }
  | { kind: 'exit' }
  | { kind: 'noop' };

const NOOP: ReadingAction = { kind: 'noop' };

export function transition(
  pos: ReadingPos | null,
  key: ArrowKey,
  shape: SectionShape,
  ctx: NavCtx,
): ReadingAction {
  if (pos === null) {
    if (key === 'ArrowDown' || key === 'ArrowUp') return { kind: 'start', wordMode: false };
    return { kind: 'start', wordMode: true };
  }
  if (shape.lineCount === 0) return NOOP;

  const { lineIdx, clusterIdx } = pos;

  // Vertical movement always returns to line mode.
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const target = key === 'ArrowDown' ? lineIdx + 1 : lineIdx - 1;
    if (target >= 0 && target < shape.lineCount) {
      return { kind: 'move', lineIdx: target, clusterIdx: null };
    }
    if (key === 'ArrowDown' && !ctx.atLastStop) return { kind: 'crossSection', dir: 1, wordMode: false };
    if (key === 'ArrowUp' && !ctx.atFirstStop) return { kind: 'crossSection', dir: -1, wordMode: false };
    return NOOP;
  }

  if (clusterIdx === null) {
    // Line mode.
    return { kind: 'move', lineIdx, clusterIdx: shape.firstClusterOnLine[lineIdx] ?? null };
  }

  // Word mode.
  if (key === 'ArrowRight') {
    const next = clusterIdx + 1;
    if (next < shape.clusterCount) {
      return { kind: 'move', lineIdx: shape.clusterHomeLine[next] ?? lineIdx, clusterIdx: next };
    }
    return ctx.atLastStop ? NOOP : { kind: 'crossSection', dir: 1, wordMode: true };
  }
  // ArrowLeft: at the line's first cluster → preceding visual line/section;
  // otherwise step to the preceding cluster.
  if (clusterIdx === shape.firstClusterOnLine[lineIdx]) {
    if (lineIdx > 0) {
      return {
        kind: 'move',
        lineIdx: lineIdx - 1,
        clusterIdx: shape.lastClusterOnLine[lineIdx - 1] ?? null,
      };
    }
    return ctx.atFirstStop ? NOOP : { kind: 'crossSection', dir: -1, wordMode: true };
  }
  const prev = clusterIdx - 1;
  return { kind: 'move', lineIdx: shape.clusterHomeLine[prev] ?? lineIdx, clusterIdx: prev };
}
