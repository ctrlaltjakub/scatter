// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeAnchoredPanelPos, isClickAwayFromRow } from './anchoredPanel';

const anchor = { left: 12, top: 300, bottom: 328, width: 216 };

describe('computeAnchoredPanelPos', () => {
  it('opens right below the anchor row, matching its width', () => {
    const pos = computeAnchoredPanelPos({ anchor, panelH: 120, viewportH: 900 });
    expect(pos).toEqual({ left: 12, top: 332, width: 216, visible: true }); // 328 + gap 4
  });

  it('clamps up when the panel would overflow the viewport bottom', () => {
    const pos = computeAnchoredPanelPos({ anchor, panelH: 600, viewportH: 900 });
    expect(pos.top).toBe(900 - 8 - 600); // viewportH - margin - panelH
  });

  it('never goes above the top margin, even for an oversized panel', () => {
    const pos = computeAnchoredPanelPos({ anchor, panelH: 2000, viewportH: 900 });
    expect(pos.top).toBe(8);
  });

  it('stays visible while the anchor intersects the clip band', () => {
    const pos = computeAnchoredPanelPos({
      anchor, panelH: 120, viewportH: 900, clip: { top: 320, bottom: 500 },
    });
    expect(pos.visible).toBe(true); // row bottom (328) dips into the band
  });

  it('hides when the anchor row is scrolled fully above the clip band', () => {
    const pos = computeAnchoredPanelPos({
      anchor, panelH: 120, viewportH: 900, clip: { top: 400, bottom: 600 },
    });
    expect(pos.visible).toBe(false);
  });

  it('hides when the anchor row is scrolled fully below the clip band', () => {
    const pos = computeAnchoredPanelPos({
      anchor, panelH: 120, viewportH: 900, clip: { top: 100, bottom: 250 },
    });
    expect(pos.visible).toBe(false);
  });
});

describe('isClickAwayFromRow', () => {
  const build = () => {
    const row = document.createElement('div');
    const inside = document.createElement('button');
    row.appendChild(inside);
    const panel = document.createElement('div');
    panel.className = 'group-color-editor';
    const swatch = document.createElement('button');
    panel.appendChild(swatch);
    const outside = document.createElement('div');
    document.body.append(row, panel, outside);
    return { row, inside, swatch, outside };
  };

  it('is not a click-away for targets inside the row', () => {
    const { row, inside } = build();
    expect(isClickAwayFromRow(row, inside)).toBe(false);
  });

  it('is not a click-away for targets inside the portaled color panel', () => {
    // The panel is portaled to document.body — DOM-outside the row — but
    // clicking a swatch must NOT commit/close the rename.
    const { row, swatch } = build();
    expect(isClickAwayFromRow(row, swatch)).toBe(false);
  });

  it('is a click-away for anything else', () => {
    const { row, outside } = build();
    expect(isClickAwayFromRow(row, outside)).toBe(true);
  });

  it('never fires without a row element', () => {
    const { outside } = build();
    expect(isClickAwayFromRow(null, outside)).toBe(false);
  });
});
