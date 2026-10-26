import { describe, expect, it } from 'vitest';
import { findWrapBreak, groupIntoLines, type Fragment } from './readingLines';

/** Fragment shorthand: cluster, char range, geometry (zoom-normalized px). */
const frag = (
  clusterIdx: number,
  start: number,
  end: number,
  top: number,
  left: number,
  height = 16,
): Fragment => ({ clusterIdx, start, end, top, left, height });

describe('groupIntoLines', () => {
  it('keeps Arabic words in logical reading order even when their screen positions run right to left', () => {
    const model = groupIntoLines([
      frag(2, 13, 20, 100, 10),
      frag(0, 0, 6, 100, 100),
      frag(1, 7, 12, 100, 50),
      frag(3, 21, 28, 120, 100),
    ], true);
    expect(model.lines).toEqual([
      { start: 0, end: 20, firstClusterIdx: 0, lastClusterIdx: 2 },
      { start: 21, end: 28, firstClusterIdx: 3, lastClusterIdx: 3 },
    ]);
    expect(model.clusterHomeLine).toEqual([0, 0, 0, 1]);
  });
  it('finishes all lines in one cell before moving to the next, even at the same screen height', () => {
    const model = groupIntoLines([
      { ...frag(0, 0, 6, 100, 0), flow: 0 },
      { ...frag(1, 7, 12, 120, 0), flow: 0 },
      { ...frag(2, 13, 18, 100, 120), flow: 1 },
      { ...frag(3, 19, 26, 120, 120), flow: 1 },
    ]);
    expect(model.lines.map((line) => [line.start, line.end])).toEqual([[0, 6], [7, 12], [13, 18], [19, 26]]);
    expect(model.clusterHomeLine).toEqual([0, 1, 2, 3]);
  });
  it('returns an empty model for no fragments', () => {
    expect(groupIntoLines([])).toEqual({ lines: [], clusterHomeLine: [] });
  });

  it('groups fragments with the same top into one line', () => {
    const model = groupIntoLines([
      frag(0, 0, 6, 100, 0),
      frag(1, 7, 12, 100, 50),
      frag(2, 13, 20, 100, 90),
    ]);
    expect(model.lines).toEqual([{ start: 0, end: 20, firstClusterIdx: 0, lastClusterIdx: 2 }]);
    expect(model.clusterHomeLine).toEqual([0, 0, 0]);
  });

  it('tolerates sub-pixel top jitter within half a fragment height', () => {
    const model = groupIntoLines([
      frag(0, 0, 6, 100, 0),
      frag(1, 7, 12, 100.4, 50), // jitter, same line
      frag(2, 0, 8, 121, 0), // a real new line (21px > 16/2)
    ]);
    expect(model.lines).toHaveLength(2);
    expect(model.clusterHomeLine).toEqual([0, 0, 1]);
  });

  it('splits a wrapped cluster across lines and keeps its home on the first', () => {
    // cluster 1 wraps: chars 7..12 on line 0, chars 12..20 on line 1.
    const model = groupIntoLines([
      frag(0, 0, 6, 100, 0),
      frag(1, 7, 12, 100, 50),
      frag(1, 12, 20, 120, 0),
      frag(2, 21, 30, 120, 60),
    ]);
    expect(model.lines).toEqual([
      { start: 0, end: 12, firstClusterIdx: 0, lastClusterIdx: 1 },
      { start: 12, end: 30, firstClusterIdx: 1, lastClusterIdx: 2 }, // line 1 STARTS with cluster 1's tail
    ]);
    expect(model.clusterHomeLine).toEqual([0, 0, 1]); // cluster 1's home = line where it begins
  });

  it('line char range spans interior whitespace between fragments', () => {
    const model = groupIntoLines([frag(0, 0, 5, 100, 0), frag(1, 8, 12, 100, 40)]);
    expect(model.lines[0]).toEqual({ start: 0, end: 12, firstClusterIdx: 0, lastClusterIdx: 1 });
  });

  it('sorts unordered input by geometry, not array order', () => {
    const model = groupIntoLines([
      frag(1, 7, 12, 120, 0),
      frag(0, 0, 6, 100, 0),
    ]);
    expect(model.lines).toEqual([
      { start: 0, end: 6, firstClusterIdx: 0, lastClusterIdx: 0 },
      { start: 7, end: 12, firstClusterIdx: 1, lastClusterIdx: 1 },
    ]);
  });
});

describe('findWrapBreak', () => {
  it('finds the smallest offset where a monotone predicate flips true', () => {
    expect(findWrapBreak((o) => o >= 7, 0, 20)).toBe(7);
    expect(findWrapBreak((o) => o >= 1, 0, 20)).toBe(1);
    expect(findWrapBreak((o) => o >= 20, 0, 20)).toBe(20);
  });
});
