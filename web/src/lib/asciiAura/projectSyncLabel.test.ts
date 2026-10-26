import { describe, expect, it } from 'vitest';
import { layoutProjectSyncLabel } from './projectSyncLabel';

const base = {
  text: 'CHANGES PENDING',
  anchorY: 50,
  blockedRects: [],
  cellPx: 10,
  cols: 50,
  rows: 30,
  screenW: 500,
  screenH: 300,
};

describe('layoutProjectSyncLabel', () => {
  it('starts one cell inside the canvas beside the hovered project row', () => {
    const layout = layoutProjectSyncLabel(base);
    expect(layout).not.toBeNull();
    expect(layout!.rect).toEqual({ x: 10, y: 50, w: 150, h: 10 });
    expect(new Set(layout!.cells.map((cell) => cell.row))).toEqual(new Set([5]));
  });

  it('starts one cell beyond the live sidebar inset instead of underneath it', () => {
    const layout = layoutProjectSyncLabel({ ...base, leftInsetPx: 240 });
    expect(layout).not.toBeNull();
    expect(layout!.rect.x).toBe(250);
  });

  it('wraps at the sidebar edge rather than jumping to the far side of a node', () => {
    const layout = layoutProjectSyncLabel({
      ...base,
      blockedRects: [{ x: 80, y: 40, w: 120, h: 30 }],
    });
    expect(layout).not.toBeNull();
    expect(layout!.rect).toEqual({ x: 10, y: 40, w: 70, h: 20 });
  });

  it('disappears when a node blocks both the one- and two-line shapes', () => {
    expect(layoutProjectSyncLabel({
      ...base,
      blockedRects: [{ x: 0, y: 40, w: 200, h: 30 }],
    })).toBeNull();
  });

  it('uses a two-line word wrap when one line cannot fit', () => {
    const layout = layoutProjectSyncLabel({
      ...base,
      text: 'REMOTE UPDATE AVAILABLE',
      cols: 16,
      screenW: 160,
    });
    expect(layout).not.toBeNull();
    expect(layout!.rect.h).toBe(20);
    expect(new Set(layout!.cells.map((cell) => cell.row)).size).toBe(2);
  });

  it('disappears instead of clipping when no complete placement exists', () => {
    expect(layoutProjectSyncLabel({
      ...base,
      blockedRects: [{ x: 0, y: 0, w: 500, h: 300 }],
    })).toBeNull();
  });
});
