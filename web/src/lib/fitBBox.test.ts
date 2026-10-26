import { describe, it, expect } from 'vitest';
import {
  extendBBoxForPanels,
  FALLBACK_PANEL_H,
  FALLBACK_BAR_H,
  NODE_BOTTOM_PANEL_GAP,
  fitBBoxInViewport,
} from './fitBBox';
import { FIT_MARGIN_PX } from './nodeVisibility';

const nodeBox = { minX: 100, minY: 200, maxX: 500, maxY: 600 }; // 400×400 node
const base = {
  panelW: 216,
  panelGap: 12,
  barGap: 12,
  nodeH: 400,
  panelH: null,
  barH: null,
};

describe('extendBBoxForPanels', () => {
  it('passes the bbox through when no panels are present', () => {
    const out = extendBBoxForPanels(nodeBox, { ...base, hasSidePanel: false, hasFollowUpBar: false });
    expect(out).toEqual(nodeBox);
  });

  it('extends left by panelW + gap for the side panel (short panel: no top overhang)', () => {
    const out = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: true, hasFollowUpBar: false, panelH: 300,
    });
    expect(out).toEqual({ ...nodeBox, minX: 100 - 228 });
  });

  it('extends the bottom when the action panel is taller than the node', () => {
    // Match NodeSidePanel's top-priority placement: no phantom top overhang.
    const out = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: true, hasFollowUpBar: false, panelH: 550,
    });
    expect(out).toEqual({ ...nodeBox, minX: 100 - 228, maxY: 600 + 150 });
  });

  it.each([450, 700])('fits the union of the input bar and a %spx action panel without stacking them', (panelH) => {
    const out = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: true, hasFollowUpBar: true, panelH, barH: 100,
    });
    expect(out.minY).toBe(nodeBox.minY);
    expect(out.maxY).toBe(Math.max(nodeBox.minY + panelH, nodeBox.maxY + 12 + 100));
  });

  it('extends the bottom by gap + bar height for the follow-up bar', () => {
    const out = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: false, hasFollowUpBar: true, barH: 90,
    });
    expect(out).toEqual({ ...nodeBox, maxY: 600 + 12 + 90 });
  });

  it('uses fallback heights while the panels are not yet in the DOM', () => {
    const shortNode = { ...nodeBox, maxY: nodeBox.minY + 100 };
    const out = extendBBoxForPanels(shortNode, {
      ...base, hasSidePanel: true, hasFollowUpBar: true, nodeH: 100,
    });
    expect(out.minX).toBe(100 - 228);
    expect(out.minY).toBe(shortNode.minY);
    expect(out.maxY).toBe(Math.max(shortNode.minY + FALLBACK_PANEL_H, shortNode.maxY + 12 + FALLBACK_BAR_H));
  });

  it('media combo: side panel only, no follow-up bar', () => {
    const out = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: true, hasFollowUpBar: false, panelH: 200,
    });
    expect(out.maxY).toBe(600);
    expect(out.minX).toBe(100 - 228);
  });

  it('extends the right edge for whichever mutually exclusive review panel is open', () => {
    const out = extendBBoxForPanels(nodeBox, {
      ...base,
      hasSidePanel: false,
      hasFollowUpBar: false,
      hasRightPanel: true,
      rightPanelW: 372,
      rightPanelGap: 12,
    });
    expect(out).toEqual({ ...nodeBox, maxX: 500 + 12 + 372 });
  });
});

describe('fitBBoxInViewport', () => {
  it('caps all fit targets at 100%, even from a manually enlarged viewport', () => {
    for (const axis of ['both', 'x'] as const) {
      expect(fitBBoxInViewport({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, { x: 0, y: 0, zoom: 1.5 }, {
        canvasWidth: 1600, canvasHeight: 1000, leftInset: 0, margin: 10, minZoom: .1, maxZoom: 1.5, axis,
      }).zoom).toBe(1);
    }
  });
  const screen = {
    canvasWidth: 1000,
    canvasHeight: 800,
    leftInset: 240,
    margin: 20,
    minZoom: 0.2,
  };

  it.each([0, 240])('uses the reduced gap and one-third outer margin without clipping panels (sidebar: %s)', (leftInset) => {
    const bounds = extendBBoxForPanels({ minX: 0, minY: 0, maxX: 600, maxY: 900 }, {
      ...base, barGap: NODE_BOTTOM_PANEL_GAP, nodeH: 900,
      hasSidePanel: true, panelH: 500, hasFollowUpBar: true, barH: 100,
    });
    expect(bounds.maxY).toBe(1006);
    const result = fitBBoxInViewport(bounds, { x: -500, y: 700, zoom: .1 }, {
      ...screen, canvasWidth: 1600, canvasHeight: 900, leftInset,
      margin: FIT_MARGIN_PX, center: { x: 300 }, maxZoom: 2,
    });
    expect(result.y + bounds.minY * result.zoom).toBeCloseTo(FIT_MARGIN_PX);
    expect(result.y + bounds.maxY * result.zoom).toBeCloseTo(900 - FIT_MARGIN_PX);
    expect(result.x + bounds.minX * result.zoom).toBeGreaterThanOrEqual(leftInset + FIT_MARGIN_PX);
    expect(result.x + bounds.maxX * result.zoom).toBeLessThanOrEqual(1600 - FIT_MARGIN_PX);
    expect(result.x + 300 * result.zoom).toBeCloseTo((1600 + leftInset) / 2);
  });

  it('keeps the current viewport when the box is already fully visible', () => {
    expect(fitBBoxInViewport(
      { minX: 300, minY: 100, maxX: 500, maxY: 300 },
      { x: 0, y: 0, zoom: 1 },
      screen,
    )).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('zooms out only enough to fit the full box beside the sidebar', () => {
    expect(fitBBoxInViewport(
      { minX: 0, minY: 0, maxX: 1000, maxY: 400 },
      { x: 0, y: 0, zoom: 1 },
      screen,
    )).toEqual({ x: 260, y: 20, zoom: 0.72 });
  });

  it('zooms in to the largest complete fit when a higher ceiling is allowed', () => {
    expect(fitBBoxInViewport(
      { minX: 0, minY: 0, maxX: 800, maxY: 600 },
      { x: 0, y: 0, zoom: 0.5 },
      { ...screen, maxZoom: 1 },
    )).toEqual({ x: 260, y: 20, zoom: 0.9 });
  });

  it('does not exceed the supplied zoom ceiling for a small group', () => {
    expect(fitBBoxInViewport(
      { minX: 0, minY: 0, maxX: 200, maxY: 200 },
      { x: 0, y: 0, zoom: 0.5 },
      { ...screen, maxZoom: 1 },
    )).toEqual({ x: 260, y: 20, zoom: 1 });
  });

  it.each([0, 240])('centers an already-visible node with sidebar inset %s', (leftInset) => {
    const center = { x: 400, y: 200 };
    const result = fitBBoxInViewport(
      { minX: 300, minY: 100, maxX: 500, maxY: 300 },
      { x: 0, y: 0, zoom: 1 },
      { ...screen, leftInset, center, maxZoom: 1 },
    );
    expect(result.x + center.x * result.zoom).toBe((screen.canvasWidth + leftInset) / 2);
    expect(result.y + center.y * result.zoom).toBe(screen.canvasHeight / 2);
    expect(result.zoom).toBe(1);
  });

  it.each([false, true])('centers the node while fitting asymmetric panels (right panel: %s)', (hasRightPanel) => {
    const center = { x: 300, y: 400 };
    const bounds = extendBBoxForPanels(nodeBox, {
      ...base,
      hasSidePanel: true,
      hasFollowUpBar: true,
      panelH: 700,
      barH: 100,
      hasRightPanel,
      rightPanelW: 450,
    });
    const result = fitBBoxInViewport(bounds, { x: -900, y: 800, zoom: 0.1 }, {
      ...screen, center, maxZoom: 2,
    });
    expect(result.zoom).toBeGreaterThan(0.1);
    expect(result.x + center.x * result.zoom).toBeCloseTo(620);
    expect(result.y + center.y * result.zoom).toBeCloseTo(400);
    expect(result.x + bounds.minX * result.zoom).toBeGreaterThanOrEqual(260 - 1e-8);
    expect(result.x + bounds.maxX * result.zoom).toBeLessThanOrEqual(980 + 1e-8);
    expect(result.y + bounds.minY * result.zoom).toBeGreaterThanOrEqual(20 - 1e-8);
    expect(result.y + bounds.maxY * result.zoom).toBeLessThanOrEqual(780 + 1e-8);
    // A settled fit is independent of the starting viewport and repeatable.
    expect(fitBBoxInViewport(bounds, result, { ...screen, center, maxZoom: 2 })).toEqual(result);
  });

  it('keeps the node centered at minimum zoom even if the full bounds cannot fit', () => {
    const center = { x: 5000, y: 200 };
    const result = fitBBoxInViewport(
      { minX: -500, minY: 0, maxX: 10000, maxY: 400 },
      { x: 300, y: 100, zoom: 1 },
      { ...screen, center, maxZoom: 2 },
    );
    expect(result).toEqual({ x: -380, y: 360, zoom: 0.2 });
  });

  it('fits a tall chat and composer without reserving a second composer-sized gap above it', () => {
    const bounds = extendBBoxForPanels({ minX: 0, minY: 0, maxX: 600, maxY: 740 }, {
      ...base, nodeH: 740, hasSidePanel: true, panelW: 248, panelH: 300,
      hasFollowUpBar: true, barH: 128, hasRightPanel: true, rightPanelW: 320,
    });
    const result = fitBBoxInViewport(bounds, { x: 0, y: 0, zoom: 0.1 }, {
      ...screen, canvasWidth: 1280, canvasHeight: 720, maxZoom: 1.5, center: { x: 300 },
    });
    expect(result.zoom).toBeCloseTo(680 / 880);
    expect(result.y + bounds.minY * result.zoom).toBeCloseTo(20);
    expect(result.y + bounds.maxY * result.zoom).toBeCloseTo(700);
    expect(result.x + 300 * result.zoom).toBeCloseTo(760);
    expect(result.x + bounds.minX * result.zoom).toBeGreaterThanOrEqual(260);
    expect(result.x + bounds.maxX * result.zoom).toBeLessThanOrEqual(1260);
  });

  it.each([0, 240])('balances remaining vertical space for a width-limited node (sidebar: %s)', (leftInset) => {
    const bounds = extendBBoxForPanels(nodeBox, {
      ...base, hasSidePanel: true, panelH: 700, hasFollowUpBar: true, barH: 150,
    });
    const options = { ...screen, canvasWidth: 800, leftInset, maxZoom: 1.5, center: { x: 300 } };
    const result = fitBBoxInViewport(bounds, { x: 10, y: -400, zoom: 0.1 }, options);
    const topGap = result.y + bounds.minY * result.zoom;
    const bottomGap = screen.canvasHeight - (result.y + bounds.maxY * result.zoom);
    expect(topGap).toBeCloseTo(bottomGap);
    expect(topGap).toBeGreaterThanOrEqual(screen.margin);
    expect(result.x + 300 * result.zoom).toBeCloseTo((options.canvasWidth + leftInset) / 2);
    expect(fitBBoxInViewport(bounds, result, options)).toEqual(result);
  });

  it('does not let explicit centering override a horizontal-only panel reveal', () => {
    const bounds = { minX: 800, minY: -500, maxX: 1100, maxY: 2000 };
    const viewport = { x: 0, y: 137, zoom: 1 };
    expect(fitBBoxInViewport(bounds, viewport, {
      ...screen, axis: 'x', center: { x: 950, y: 750 }, maxZoom: 2,
    })).toEqual(fitBBoxInViewport(bounds, viewport, { ...screen, axis: 'x' }));
  });

  it('centres unavoidable overflow after reaching minimum zoom', () => {
    expect(fitBBoxInViewport(
      { minX: 0, minY: 0, maxX: 10000, maxY: 400 },
      { x: 0, y: 0, zoom: 1 },
      screen,
    )).toEqual({ x: -380, y: 20, zoom: 0.2 });
  });

  it('reveals horizontal chrome without changing zoom or vertical reading position', () => {
    expect(fitBBoxInViewport(
      { minX: 800, minY: -500, maxX: 1100, maxY: 2000 },
      { x: 0, y: 137, zoom: 1 },
      { ...screen, axis: 'x' },
    )).toEqual({ x: -120, y: 137, zoom: 1 });
  });

  it('prioritizes the newly opened right edge when current zoom cannot fit the full width', () => {
    expect(fitBBoxInViewport(
      { minX: 0, minY: 0, maxX: 1200, maxY: 400 },
      { x: 0, y: 91, zoom: 1 },
      { ...screen, axis: 'x' },
    )).toEqual({ x: -220, y: 91, zoom: 1 });
  });
});
