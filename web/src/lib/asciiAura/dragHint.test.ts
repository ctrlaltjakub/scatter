import { describe, expect, it } from 'vitest';
import { layoutDragHint } from './dragHint';
import { statusGlyphIndex } from './statusText';

const base = {
  text: 'DRAG AWAY TO PIN',
  node: { x: 100, y: 90, w: 240, h: 160 },
  cellPx: 10,
  cols: 100,
  rows: 80,
  screenW: 1000,
  screenH: 800,
};

function requireLayout(result: ReturnType<typeof layoutDragHint>) {
  expect(result).not.toBeNull();
  return result!;
}

describe('layoutDragHint', () => {
  it('lays the uppercase label two cells outside the card beside its top-right pin', () => {
    const result = requireLayout(layoutDragHint(base));
    expect(result.cells[0]).toEqual({ col: 36, row: 11, glyphIndex: statusGlyphIndex('D') });
    expect(result.cells.every((cell) => cell.col >= 36)).toBe(true);
    expect(result.rect.x).toBe(360);
    expect(result.rect.y).toBe(110);
  });

  it('keeps the hint on one line whenever the full line fits', () => {
    const result = requireLayout(layoutDragHint(base));
    expect(new Set(result.cells.map((cell) => cell.row))).toEqual(new Set([11]));
    expect(result.rect.h).toBe(10);
    expect(result.rect.w).toBe('DRAG AWAY TO PIN'.length * 10);
  });

  it('wraps at words to at most two lines only when horizontal room is tight', () => {
    const result = requireLayout(layoutDragHint({ ...base, cols: 46, screenW: 460 }));
    const occupiedRows = [...new Set(result.cells.map((cell) => cell.row))];
    expect(occupiedRows).toEqual([10, 11]);
    expect(result.rect).toEqual({ x: 360, y: 100, w: 90, h: 20 });

    const rowText = occupiedRows.map((row) => {
      const cells = result.cells.filter((cell) => cell.row === row);
      return {
        first: Math.min(...cells.map((cell) => cell.col)),
        last: Math.max(...cells.map((cell) => cell.col)),
      };
    });
    expect(rowText).toEqual([
      { first: 36, last: 44 },
      { first: 37, last: 42 },
    ]);
  });

  it('wraps when a neighboring node blocks the one-line footprint', () => {
    const result = requireLayout(layoutDragHint({
      ...base,
      blockedRects: [{ x: 455, y: 70, w: 220, h: 180 }],
    }));

    expect([...new Set(result.cells.map((cell) => cell.row))]).toEqual([10, 11]);
    expect(result.rect).toEqual({ x: 360, y: 100, w: 90, h: 20 });
    expect(result.rect.x + result.rect.w).toBeLessThanOrEqual(455);
  });

  it('returns null when neither complete layout fits', () => {
    const result = layoutDragHint({ ...base, cols: 44, screenW: 440 });
    expect(result).toBeNull();
  });

  it('wraps instead of accepting a one-line label clipped by a partial final cell', () => {
    const result = requireLayout(layoutDragHint({
      ...base,
      cols: 52,
      screenW: 515,
    }));

    expect([...new Set(result.cells.map((cell) => cell.row))]).toEqual([10, 11]);
    expect(result.rect).toEqual({ x: 360, y: 100, w: 90, h: 20 });
  });

  it('hides instead of accepting a two-line label clipped by a partial final cell', () => {
    expect(layoutDragHint({
      ...base,
      cols: 45,
      screenW: 445,
    })).toBeNull();
  });

  it('hides a complete label that reaches beyond the exact viewport height', () => {
    expect(layoutDragHint({
      ...base,
      rows: 11,
      screenH: 105,
    })).toBeNull();
  });

  it('can place the hint again after the obstruction disappears', () => {
    const blocked = layoutDragHint({
      ...base,
      blockedRects: [{ x: 440, y: 70, w: 220, h: 180 }],
    });
    const reopened = layoutDragHint({ ...base, blockedRects: [] });
    expect(blocked).toBeNull();
    expect(requireLayout(reopened).cells.length).toBeGreaterThan(0);
  });

  it('never creates glyph cells for spaces', () => {
    const result = requireLayout(layoutDragHint(base));
    expect(result.cells).toHaveLength(13);
  });
});
