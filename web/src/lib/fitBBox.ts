/**
 * Focus-fit bbox extension: when the camera pans to a focused (single-
 * selected) node, the fit should cover the node's floating panels too —
 * the side action panel to its LEFT (NodeSidePanel) and the follow-up bar
 * BELOW it (NodeFollowUpBar) — not just the node body.
 *
 * All values are world px. Panel/bar heights are DOM-measured with
 * offsetHeight (zoom-independent layout px == world px); the fallbacks
 * cover the first frames after selection, before the elements mount —
 * computeTarget re-runs every tick, so real measurements take over as
 * soon as the DOM is there.
 */

/** Keep in sync with --node-bottom-gap in globals.css (covered by layout tests). */
export const NODE_BOTTOM_PANEL_GAP = 6;

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewportBox {
  x: number;
  y: number;
  zoom: number;
}

export interface FitViewportOptions {
  canvasWidth: number;
  canvasHeight: number;
  /** Fixed screen-space chrome occupying the left side, excluding margin. */
  leftInset: number;
  margin: number;
  minZoom: number;
  /** Largest zoom the fit may choose. Omitted means the current zoom, which
   * preserves the ordinary node-navigation rule of never zooming in. */
  maxZoom?: number;
  /** Center on this world-space x coordinate. By default, center the actual
   * vertical bounds (node plus panels); supplying y fixes that center too. */
  center?: { x: number; y?: number };
  /** `x` is used when revealing a right panel: keep the vertical position and
   * zoom (up to 100%), moving only enough to expose the horizontal bounds. */
  axis?: 'both' | 'x';
}

/** Minimum-pan fit by default, or an explicit centered fit for a node. */
export function fitBBoxInViewport(
  bbox: BBox,
  viewport: ViewportBox,
  options: FitViewportOptions,
): ViewportBox {
  // Horizontal panel reveals always preserve their existing reading position.
  const center = options.axis === 'x' ? undefined : options.center;
  const centerY = center?.y ?? (bbox.minY + bbox.maxY) / 2;
  // Keep the node horizontally centered without clipping either side panel.
  // Vertically, use the real bounds unless an explicit y was requested: the
  // bottom input panel must not create a matching empty strip above the node.
  const bboxW = center
    ? 2 * Math.max(center.x - bbox.minX, bbox.maxX - center.x)
    : bbox.maxX - bbox.minX;
  const bboxH = center
    ? 2 * Math.max(centerY - bbox.minY, bbox.maxY - centerY)
    : bbox.maxY - bbox.minY;
  const left = options.leftInset + options.margin;
  const right = options.canvasWidth - options.margin;
  const bottom = options.canvasHeight - options.margin;
  const availW = Math.max(50, right - left);
  const availH = Math.max(50, bottom - options.margin);

  let zoom = Math.min(1, viewport.zoom);
  if (options.axis !== 'x' && bboxW > 0 && bboxH > 0) {
    const fitZoom = Math.min(availW / bboxW, availH / bboxH);
    const zoomCeiling = Math.min(1, options.maxZoom ?? viewport.zoom);
    zoom = Math.max(options.minZoom, Math.min(zoomCeiling, fitZoom));
  }

  if (center) {
    return {
      x: (left + right) / 2 - center.x * zoom,
      y: (options.margin + bottom) / 2 - centerY * zoom,
      zoom,
    };
  }

  const xLow = left - bbox.minX * zoom;
  const xHigh = right - bbox.maxX * zoom;
  const yLow = options.margin - bbox.minY * zoom;
  const yHigh = bottom - bbox.maxY * zoom;
  const closest = (value: number, low: number, high: number) => (
    low > high ? (low + high) / 2 : Math.max(low, Math.min(high, value))
  );
  // A newly opened right panel is the priority when the unchanged zoom makes
  // the full horizontal box impossible to fit. Align its right edge rather
  // than centring the overflow and leaving the new chrome partly hidden.
  const fittedX = options.axis === 'x' && xLow > xHigh
    ? xHigh
    : closest(viewport.x, xLow, xHigh);
  return {
    x: fittedX,
    y: options.axis === 'x' ? viewport.y : closest(viewport.y, yLow, yHigh),
    zoom,
  };
}

export interface PanelExtras {
  /** Node is the current single selection (panels render only then). */
  hasSidePanel: boolean;
  /** Text nodes and still images have a follow-up bar; videos/GIFs do not. */
  hasFollowUpBar: boolean;
  /** NodeSidePanel.PANEL_W / PANEL_GAP. */
  panelW: number;
  panelGap: number;
  /** Measured .side-panel offsetHeight, null while unmounted. */
  panelH: number | null;
  /** Measured .node-followup-bar offsetHeight, null while unmounted. */
  barH: number | null;
  /** Gap between node bottom and the bar (--node-bottom-gap in CSS). */
  barGap: number;
  /** The focused node's rendered height (nodeRenderedH). */
  nodeH: number;
  /** Mutually exclusive Sources / Evidence / Wikimedia panel on the right. */
  hasRightPanel?: boolean;
  rightPanelW?: number;
  rightPanelGap?: number;
}

/** Typical full action stack, used until .side-panel is measurable. */
export const FALLBACK_PANEL_H = 320;
/** Compact three-line follow-up bar, used until its DOM height is measurable. */
export const FALLBACK_BAR_H = 91;

export function extendBBoxForPanels(nodeBox: BBox, x: PanelExtras): BBox {
  let { minX, minY, maxX, maxY } = nodeBox;
  if (x.hasSidePanel) {
    minX -= x.panelW + x.panelGap;
    // NodeSidePanel uses top priority: a tall action panel starts at the
    // node top and extends BELOW it, never into empty space above the node.
    const panelH = x.panelH ?? FALLBACK_PANEL_H;
    maxY += Math.max(0, panelH - x.nodeH);
  }
  if (x.hasFollowUpBar) {
    // The side panel and input bar can both extend below the card; they sit
    // beside one another, so fit their union rather than stacking heights.
    maxY = Math.max(maxY, nodeBox.maxY + x.barGap + (x.barH ?? FALLBACK_BAR_H));
  }
  if (x.hasRightPanel) {
    maxX += (x.rightPanelGap ?? x.panelGap) + (x.rightPanelW ?? x.panelW);
  }
  return { minX, minY, maxX, maxY };
}
