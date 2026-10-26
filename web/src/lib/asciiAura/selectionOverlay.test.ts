import { describe, expect, it } from 'vitest';
import { paintSelectionOverlay, selectionAuraBorder } from './selectionOverlay';
import { statusGlyphIndex } from './statusText';
import { INHERIT_OVERLAY_OPACITY_BYTE } from './gl/overlay';

describe('ASCII selection field', () => {
  it('replaces only cell shape inside the rectangle, and yields to labels, halos and cards', () => {
    const data = new Uint8Array(10 * 10 * 4);
    data[(2 * 10 + 2) * 4] = statusGlyphIndex('A')!;
    data[(3 * 10 + 3) * 4 + 1] = 2;
    paintSelectionOverlay(data, 10, 10, 10, [], { x: 10, y: 10, w: 40, h: 40 }, [{ x: 40, y: 40, w: 10, h: 10 }]);
    expect([...data.slice(44, 48)]).toEqual([statusGlyphIndex('+'), 0, 0, INHERIT_OVERLAY_OPACITY_BYTE]);
    expect(data[0]).toBe(0);
    expect(data[88]).toBe(statusGlyphIndex('A'));
    expect(data[132]).toBe(0);
    expect(data[176]).toBe(0);
  });
  it('joins overlapping auras into one outline with no seam through the overlap', () => {
    const auras = [
      { rect: { x: 100, y: 100, w: 100, h: 100 }, radius: 60 },
      { rect: { x: 240, y: 100, w: 100, h: 100 }, radius: 60 },
    ];
    const border = selectionAuraBorder(auras, 10, 50, 40);
    expect(border.length).toBeGreaterThan(50);
    expect(border.some(({ col, row }) => col >= 19 && col <= 24 && row > 10 && row < 19)).toBe(false);
    const glyphs = new Set(border.map((part) => part.glyphIndex));
    for (const glyph of ['/', '\\', '_', '|']) expect(glyphs.has(statusGlyphIndex(glyph)!)).toBe(true);
  });
  it('keeps separate contours for distant nodes and never outlines the viewport clipping edge', () => {
    const border = selectionAuraBorder([
      { rect: { x: -90, y: 50, w: 100, h: 100 }, radius: 30 },
      { rect: { x: 300, y: 50, w: 100, h: 100 }, radius: 30 },
    ], 10, 50, 30);
    expect(border.some(({ col, row }) => col === 0 && row >= 6 && row <= 14)).toBe(false);
    expect(border.some(({ col }) => col > 10 && col < 20)).toBe(false);
    expect(border.some(({ col }) => col >= 27)).toBe(true);
  });
  it('is safe for empty selections, offscreen nodes and fractional cell pitches', () => {
    expect(selectionAuraBorder([], 9, 20, 20)).toEqual([]);
    expect(selectionAuraBorder([{ rect: { x: 1000, y: 1000, w: 50, h: 50 }, radius: 20 }], 9.3333, 20, 20)).toEqual([]);
  });
});
