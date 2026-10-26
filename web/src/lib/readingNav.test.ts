import { describe, expect, it } from 'vitest';
import { transition, type NavCtx, type SectionShape } from './readingNav';

/**
 * Section used throughout: 3 lines, 6 clusters.
 *   line 0: clusters 0, 1
 *   line 1: clusters 2, 3
 *   line 2: clusters 4, 5
 */
const shape: SectionShape = {
  lineCount: 3,
  clusterCount: 6,
  firstClusterOnLine: [0, 2, 4],
  lastClusterOnLine: [1, 3, 5],
  clusterHomeLine: [0, 0, 1, 1, 2, 2],
};
const mid: NavCtx = { atFirstStop: false, atLastStop: false };
const only: NavCtx = { atFirstStop: true, atLastStop: true };

describe('transition — inactive', () => {
  it('starts line mode on ↓ or ↑ and word mode on either horizontal arrow', () => {
    expect(transition(null, 'ArrowDown', shape, mid)).toEqual({ kind: 'start', wordMode: false });
    expect(transition(null, 'ArrowUp', shape, mid)).toEqual({ kind: 'start', wordMode: false });
    expect(transition(null, 'ArrowRight', shape, mid)).toEqual({ kind: 'start', wordMode: true });
    expect(transition(null, 'ArrowLeft', shape, mid)).toEqual({ kind: 'start', wordMode: true });
  });
});

describe('transition — line mode', () => {
  const at = (lineIdx: number) => ({ lineIdx, clusterIdx: null });

  it('steps lines with ↓ / ↑', () => {
    expect(transition(at(0), 'ArrowDown', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: null });
    expect(transition(at(2), 'ArrowUp', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: null });
  });

  it('crosses sections at the edges', () => {
    expect(transition(at(2), 'ArrowDown', shape, mid)).toEqual({ kind: 'crossSection', dir: 1, wordMode: false });
    expect(transition(at(0), 'ArrowUp', shape, mid)).toEqual({ kind: 'crossSection', dir: -1, wordMode: false });
  });

  it('clamps at the document ends', () => {
    expect(transition(at(2), 'ArrowDown', shape, only)).toEqual({ kind: 'noop' });
    expect(transition(at(0), 'ArrowUp', shape, only)).toEqual({ kind: 'noop' });
  });

  it('either horizontal arrow enters word mode at the first cluster of the current line', () => {
    expect(transition(at(1), 'ArrowRight', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: 2 });
    expect(transition(at(1), 'ArrowLeft', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: 2 });
  });
});

describe('transition — word mode', () => {
  const at = (lineIdx: number, clusterIdx: number) => ({ lineIdx, clusterIdx });

  it('→ steps clusters, snapping the line to the next cluster (line wrap emergent)', () => {
    expect(transition(at(1, 2), 'ArrowRight', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: 3 });
    expect(transition(at(1, 3), 'ArrowRight', shape, mid)).toEqual({ kind: 'move', lineIdx: 2, clusterIdx: 4 });
  });

  it('→ at the last cluster crosses forward in word mode, clamps at document end', () => {
    expect(transition(at(2, 5), 'ArrowRight', shape, mid)).toEqual({ kind: 'crossSection', dir: 1, wordMode: true });
    expect(transition(at(2, 5), 'ArrowRight', shape, only)).toEqual({ kind: 'noop' });
  });

  it('← steps back within the line', () => {
    expect(transition(at(1, 3), 'ArrowLeft', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: 2 });
  });

  it('← at the first word of a line moves to the previous visual line’s last word', () => {
    expect(transition(at(1, 2), 'ArrowLeft', shape, mid)).toEqual({ kind: 'move', lineIdx: 0, clusterIdx: 1 });
    expect(transition(at(2, 4), 'ArrowLeft', shape, mid)).toEqual({ kind: 'move', lineIdx: 1, clusterIdx: 3 });
  });

  it('← crosses to the previous section at the first word, and no-ops at the absolute beginning', () => {
    expect(transition(at(0, 0), 'ArrowLeft', shape, mid)).toEqual({ kind: 'crossSection', dir: -1, wordMode: true });
    expect(transition(at(0, 0), 'ArrowLeft', shape, only)).toEqual({ kind: 'noop' });
  });

  it('↑ / ↓ return to line mode on the neighboring line', () => {
    expect(transition(at(1, 3), 'ArrowUp', shape, mid)).toEqual({ kind: 'move', lineIdx: 0, clusterIdx: null });
    expect(transition(at(1, 3), 'ArrowDown', shape, mid)).toEqual({ kind: 'move', lineIdx: 2, clusterIdx: null });
  });

  it('↑ / ↓ cross sections in line mode at the edges, clamping at document ends', () => {
    expect(transition(at(0, 1), 'ArrowUp', shape, mid)).toEqual({ kind: 'crossSection', dir: -1, wordMode: false });
    expect(transition(at(2, 4), 'ArrowDown', shape, mid)).toEqual({ kind: 'crossSection', dir: 1, wordMode: false });
    expect(transition(at(0, 1), 'ArrowUp', shape, only)).toEqual({ kind: 'noop' });
    expect(transition(at(2, 4), 'ArrowDown', shape, only)).toEqual({ kind: 'noop' });
  });

  it('a line starting with a wrapped cluster tail: ← lands on the wrapped cluster at its HOME line', () => {
    // cluster 1 wraps from line 0 onto line 1; line 1 starts with its tail.
    const wrapped: SectionShape = {
      lineCount: 2,
      clusterCount: 3,
      firstClusterOnLine: [0, 1],
      lastClusterOnLine: [1, 2],
      clusterHomeLine: [0, 0, 1],
    };
    // From cluster 2 (line 1), ← goes to cluster 1 whose home is line 0.
    expect(transition(at(1, 2), 'ArrowLeft', wrapped, mid)).toEqual({ kind: 'move', lineIdx: 0, clusterIdx: 1 });
    // Cluster 1 is also the last cluster represented on the preceding visual line.
    expect(transition(at(1, 1), 'ArrowLeft', wrapped, mid)).toEqual({ kind: 'move', lineIdx: 0, clusterIdx: 1 });
  });
});

describe('transition — degenerate sections', () => {
  it('no lines → noop for every arrow while active', () => {
    const empty: SectionShape = { lineCount: 0, clusterCount: 0, firstClusterOnLine: [], lastClusterOnLine: [], clusterHomeLine: [] };
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const) {
      expect(transition({ lineIdx: 0, clusterIdx: null }, key, empty, mid)).toEqual({ kind: 'noop' });
    }
  });
});
