import { describe, it, expect } from 'vitest';
import { RAMP_FLAT } from './ramp';
import {
  STATUS_CHARS,
  statusGlyphIndex,
  renderableCount,
  wrapStatus,
  layoutStatus,
  layoutStatusProcesses,
  statusFullyDeleted,
  STATUS_REVEAL_MS_PER_CHAR,
  STATUS_DELETE_MS_PER_CHAR,
  STATUS_GAP_ROWS,
  STATUS_DOT_RESERVE,
} from './statusText';

const RAMP_N = RAMP_FLAT.length;

describe('statusGlyphIndex', () => {
  it('maps a status char to an atlas index AFTER the ramp glyphs', () => {
    expect(statusGlyphIndex('A')).toBe(RAMP_N + STATUS_CHARS.indexOf('A'));
    // first status char sits exactly at RAMP_FLAT.length (parity preserved)
    expect(statusGlyphIndex(STATUS_CHARS[0]!)).toBe(RAMP_N);
  });
  it('returns null for space / unknown / lowercase chars', () => {
    expect(statusGlyphIndex(' ')).toBeNull();
    expect(statusGlyphIndex('a')).toBeNull();
    expect(statusGlyphIndex('@')).toBeNull();
  });
  it('never collides with a ramp glyph index', () => {
    expect(statusGlyphIndex('Z')!).toBeGreaterThanOrEqual(RAMP_N);
  });
  it('includes a distinct continuation glyph for shortened ASCII labels', () => {
    expect(statusGlyphIndex('~')).toBe(RAMP_N + STATUS_CHARS.indexOf('~'));
  });
});

describe('layoutStatusProcesses', () => {
  it('shares one heading while independently revealing simultaneous processes', () => {
    const cells = layoutStatusProcesses({
      processes: [
        { text: 'GENERATING TEXT', startedAt: 0, clearedAt: null },
        { text: 'FINDING WIKIMEDIA IMAGES', startedAt: 100, clearedAt: null },
      ],
      node: { x: 100, y: 200, w: 300, h: 160 },
      cellPx: 10,
      cols: 100,
      rows: 100,
      now: 10_000,
    });
    const rows = new Set(cells.map((cell) => cell.row));
    expect(rows.size).toBeGreaterThanOrEqual(3);
  });
});

describe('renderableCount', () => {
  it('counts renderable chars, ignoring spaces, case-insensitively', () => {
    expect(renderableCount('MARKING CHIPS')).toBe(12);
    expect(renderableCount('marking chips')).toBe(12);
    expect(renderableCount('')).toBe(0);
    expect(renderableCount('   ')).toBe(0);
  });
});

describe('wrapStatus', () => {
  it('keeps a short status on one line', () => {
    expect(wrapStatus('MARKING CHIPS', 20)).toEqual(['MARKING CHIPS']);
  });
  it('wraps on word boundaries when it exceeds the width', () => {
    expect(wrapStatus('MARKING CHIPS', 7)).toEqual(['MARKING', 'CHIPS']);
  });
  it('hard-splits a single word longer than the width', () => {
    expect(wrapStatus('ABCDEFGH', 4)).toEqual(['ABCD', 'EFGH']);
  });
  it('returns [] for empty text', () => {
    expect(wrapStatus('', 10)).toEqual([]);
  });
});

// A node rect well inside a large grid so placement never clips.
const NODE = { x: 90, y: 180, w: 270, h: 90 }; // CSS px
const CELL = 9;
const GRID = { cols: 200, rows: 200 };
const FAR = 10_000_000; // "animation finished" sentinel for `now`

describe('layoutStatus — placement', () => {
  it('centres a single line over the node, reserving the dot columns', () => {
    const dot = statusGlyphIndex('.');
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: FAR,
    }).filter((c) => c.glyphIndex !== dot); // drop the trailing working dots
    expect(cells.length).toBe(2);
    const topRow = Math.floor(NODE.y / CELL);
    const row = topRow - 1 - STATUS_GAP_ROWS;
    const centerCol = (NODE.x + NODE.w / 2) / CELL;
    const start = Math.round(centerCol - (2 + STATUS_DOT_RESERVE) / 2); // 'AB' + 3 dots
    expect(cells[0]).toEqual({ col: start, row, glyphIndex: statusGlyphIndex('A') });
    expect(cells[1]).toEqual({ col: start + 1, row, glyphIndex: statusGlyphIndex('B') });
  });

  it('uppercases the text before mapping glyphs', () => {
    const dot = statusGlyphIndex('.');
    const cells = layoutStatus({
      text: 'ab', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: FAR,
    }).filter((c) => c.glyphIndex !== dot);
    expect(cells.map((c) => c.glyphIndex)).toEqual([statusGlyphIndex('A'), statusGlyphIndex('B')]);
  });

  it('falls back to BELOW the node when there is no room above', () => {
    const top = { x: 90, y: 2, w: 270, h: 90 }; // top edge near row 0
    const cells = layoutStatus({
      text: 'AB', node: top, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: FAR,
    });
    const bottomRow = Math.floor((top.y + top.h) / CELL);
    expect(cells.every((c) => c.row > bottomRow)).toBe(true);
  });

  it('culls cells that fall outside the grid bounds', () => {
    const tiny = { cols: 5, rows: 5 };
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: tiny.cols, rows: tiny.rows,
      startedAt: 0, clearedAt: null, now: FAR,
    });
    expect(cells.length).toBe(0); // node is at col 10 / row 20 → off a 5×5 grid
  });
});

describe('layoutStatus — animation', () => {
  it('reveals left-to-right: at t=0 only the first char shows', () => {
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: 0,
    });
    expect(cells.length).toBe(1);
    expect(cells[0]!.glyphIndex).toBe(statusGlyphIndex('A'));
  });

  it('reveals the second char once its delay elapses', () => {
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: STATUS_REVEAL_MS_PER_CHAR,
    });
    expect(cells.length).toBe(2);
  });

  it('deletes right-to-left: at clear t=0 the LAST char goes first', () => {
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: 0, now: 0,
    });
    // total=2 → k=1 (B) deletes immediately, k=0 (A) still visible.
    expect(cells.length).toBe(1);
    expect(cells[0]!.glyphIndex).toBe(statusGlyphIndex('A'));
  });
});

describe('layoutStatus — working dots', () => {
  const dot = statusGlyphIndex('.')!;

  it('appends cycling dots after the base once fully revealed', () => {
    // 'AB' fully revealed by 2·REVEAL; now in [800,1200) → dotCount 3.
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: 800,
    });
    const dots = cells.filter((c) => c.glyphIndex === dot);
    expect(dots.length).toBe(3);
    const base = cells.filter((c) => c.glyphIndex !== dot);
    const lastBaseCol = Math.max(...base.map((c) => c.col));
    // dots run contiguously right after the last base char
    expect(dots.map((c) => c.col)).toEqual([lastBaseCol + 1, lastBaseCol + 2, lastBaseCol + 3]);
  });

  it('shows no dots before the base is fully revealed', () => {
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: null, now: STATUS_REVEAL_MS_PER_CHAR, // only 1 char in
    });
    expect(cells.some((c) => c.glyphIndex === dot)).toBe(false);
  });

  it('shows no dots while clearing', () => {
    const cells = layoutStatus({
      text: 'AB', node: NODE, cellPx: CELL, cols: GRID.cols, rows: GRID.rows,
      startedAt: 0, clearedAt: 1000, now: 1000, // fully revealed but wiping
    });
    expect(cells.some((c) => c.glyphIndex === dot)).toBe(false);
  });
});

describe('statusFullyDeleted', () => {
  it('is false while not cleared', () => {
    expect(statusFullyDeleted('MARKING CHIPS', null, FAR)).toBe(false);
  });
  it('is false immediately after clearing, true once the delete animation finishes', () => {
    expect(statusFullyDeleted('AB', 1000, 1000)).toBe(false);
    expect(statusFullyDeleted('AB', 1000, 1000 + 2 * STATUS_DELETE_MS_PER_CHAR + 100)).toBe(true);
  });
});
