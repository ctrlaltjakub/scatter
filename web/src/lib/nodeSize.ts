import type { ScatterNode, NodeVersion } from '@/store/types';
import { interactiveDisplaySize } from './interactiveDocument';

/** A node-shaped value we can resolve the current version from. */
type Versioned = Pick<ScatterNode, 'versions' | 'currentVersionIndex'>;

/** The currently-displayed version of a node (size fields live here). */
export function currentVersion(n: Versioned): NodeVersion | undefined {
  return n.versions[n.currentVersionIndex];
}

/**
 * Node sizing constants.
 *
 * Width is CONTINUOUS — the resize handle drags freely between
 * MIN_NODE_W and whatever the chain-clamp permits. The earlier
 * 3-preset width system was reverted now that the underlying bugs are
 * understood and fixed (the big one being zoom-normalized
 * measurements in AdaptiveBullets — `getBoundingClientRect()` returns
 * post-transform pixels, so all the layout math has to divide by the
 * current canvas zoom to stay in CSS pixel space).
 *
 * - DEFAULT_NODE_W (624) is the default width for spawned children.
 * - ROOT_NODE_W (640) is slightly bigger because the root reads first.
 * - MIN_NODE_W (624) is the floor the resize handle clamps against.
 *   It also drives MEASURE_WIDTH in AdaptiveBullets, so the hidden
 *   measurement lab is sized for the worst case the resize handle
 *   ever allows.
 */
export const DEFAULT_NODE_W = 624;
export const ROOT_NODE_W = 640;
export const MIN_NODE_W = 624;
/** Default interactive card width before a manual resize. */
export const INTERACTIVE_NODE_W = 764;

/**
 * Horizontal pixels the `.node` border consumes. Was 2 (1px each side);
 * the card border was dropped in the Scatter polish pass — the glyph
 * aura field is the new background, so cards render as borderless
 * white panels. Kept exported so MEASURE_WIDTH stays self-documenting.
 * MUST match the `border` width on `.node` in globals.css (currently 0).
 */
export const NODE_BORDER_PX = 0;
/**
 * Horizontal pixels the `.node-body` padding consumes (left + right).
 * MUST match the horizontal padding on `.node-body` in globals.css
 * (`padding: 4px 22px 12px 22px` → 22 + 22 = 44). Guarded against drift
 * by measureWidth.test.ts, which parses the CSS and compares.
 */
export const NODE_BODY_H_PADDING = 44;
/**
 * Content width (CSS px) of a node body at the NARROWEST allowed node
 * width (MIN_NODE_W). AdaptiveBullets renders its hidden measurement
 * labs at exactly this width so the computed `minBodyHeight` is a
 * worst-case floor: text wraps to the most lines at the narrowest
 * width, so measuring here is conservatively safe for any wider current
 * width.
 *
 * CRITICAL: this must equal the REAL content width at MIN_NODE_W
 * (MIN_NODE_W − border − body padding). If it's even slightly WIDER
 * than reality, the labs let text wrap to fewer lines than it actually
 * will, the per-bullet heights come out too short, `minBodyHeight` is
 * undersized, and tall bullets overflow the body — which is precisely
 * what happened when the body padding was widened (12→22 per side) but
 * this constant wasn't updated.
 */
export const MEASURE_WIDTH = MIN_NODE_W - NODE_BORDER_PX - NODE_BODY_H_PADDING;

// ─── 3:2 aspect-ratio cap (recomputed on any text change) ────────────
/** Max allowed height:width proportion for a node's MINIMAL box (3:2). */
export const ASPECT_MAX_RATIO = 1.5;
/** Each rung on the candidate minimum-width ladder is this much wider. */
export const ASPECT_WIDTH_STEP = 1.2;
/** Hard ceiling on the widened minimum width (≈ 2× the normal floor). */
export const ASPECT_MAX_WIDTH = Math.round(MIN_NODE_W * 2);
/** Approximate non-body chrome (header + footer + body padding) added to
 *  the measured body height when judging the node's visible proportion.
 *  A constant (header wraps 1–3 lines) — good enough for the ratio test. */
export const APPROX_HEADER_CHROME = 90;

/**
 * Pick the smallest card width (from the ladder MIN_NODE_W·1.2^k, capped at
 * ASPECT_MAX_WIDTH) whose ESTIMATED minimal height satisfies the 3:2 ratio.
 *
 * `minBodyH` is the body floor measured at `measuredContentW` content px;
 * `fixedPx` is the part of it that does NOT reflow with width (freetext +
 * overhead + safety); `headerPx` accounts for non-body chrome. The reflowing
 * remainder is extrapolated to each candidate width as inversely proportional
 * to the content width (wider ⇒ fewer wrapped lines ⇒ shorter).
 *
 * BIDIRECTIONAL: it always scans up from MIN_NODE_W, so when content shrinks
 * it returns a smaller width (the node narrows back) and when content grows it
 * returns a larger one — yet it never returns a width whose ESTIMATED height
 * (taller at narrower widths) would break 3:2, so it can't undershoot.
 */
export function widthForAspectCap(args: {
  minBodyH: number;
  measuredContentW: number;
  fixedPx: number;
  headerPx?: number;
  ratio?: number;
}): number {
  const ratio = args.ratio ?? ASPECT_MAX_RATIO;
  const headerPx = args.headerPx ?? APPROX_HEADER_CHROME;
  const reflow0 = Math.max(0, args.minBodyH - args.fixedPx);
  const PAD = NODE_BORDER_PX + NODE_BODY_H_PADDING;
  let cardW = MIN_NODE_W;
  for (let i = 0; i < 12; i++) {
    const contentW = Math.max(1, cardW - PAD);
    const estBody = args.fixedPx + reflow0 * (args.measuredContentW / contentW);
    if ((estBody + headerPx) / cardW <= ratio) return cardW;
    const nextW = Math.min(ASPECT_MAX_WIDTH, Math.round(MIN_NODE_W * Math.pow(ASPECT_WIDTH_STEP, i + 1)));
    if (nextW <= cardW) return cardW; // hit the cap
    cardW = nextW;
  }
  return cardW;
}

/**
 * Body content width to MEASURE a node's height floor at, given its
 * optional raised minimum width. Ordinary nodes (no `minWidth`) measure at
 * MEASURE_WIDTH — the content width at the global MIN_NODE_W, the narrowest
 * they can ever be. Aspect-capped nodes have a larger `minWidth`, so they
 * measure their floor at that wider width (where text wraps less and the
 * floor is shorter), and the resize handle won't let them go narrower —
 * keeping the floor conservative and valid.
 */
export function measureWidthFor(minWidth?: number): number {
  if (minWidth == null) return MEASURE_WIDTH;
  return Math.max(MEASURE_WIDTH, minWidth - NODE_BORDER_PX - NODE_BODY_H_PADDING);
}

/** Effective minimum card width for a node (its current version's raised
 *  `minWidth`, else the global floor). Used by the resize clamp. */
export function nodeMinWidth(n: Versioned): number {
  return currentVersion(n)?.minWidth ?? MIN_NODE_W;
}

export const DEFAULT_BODY_MAX_H = 550;
export const ROOT_BODY_MAX_H = 720;

/** Used by physics + ArrowLayer when a node hasn't yet reported its
 *  rendered height via ResizeObserver. */
export const FALLBACK_NODE_H = 120;

/** Minimum body height the resize handle is allowed to shrink to —
 *  AdaptiveBullets will normally have stored a more accurate per-node
 *  floor (node.minBodyHeight) by the time the user can interact. */
export const MIN_BODY_MAX_H = 80;

/** Resolve the effective card width for a node (current version's width). */
export function nodeWidth(n: Versioned): number {
  const version = currentVersion(n);
  if (version?.contentType === 'interactive') {
    return interactiveDisplaySize(version.interactive, false, version.interactiveCanvasWidth).width;
  }
  return version?.width ?? DEFAULT_NODE_W;
}

/** Resolve the effective body max-height for a node (current version). */
export function nodeBodyMaxH(n: Versioned): number {
  const version = currentVersion(n);
  if (version?.contentType === 'interactive') {
    return interactiveDisplaySize(version.interactive, false, version.interactiveCanvasWidth).height;
  }
  return version?.bodyMaxHeight ?? DEFAULT_BODY_MAX_H;
}

/** Resolve the rendered card height for physics / arrow endpoint math.
 *  Falls back to FALLBACK_NODE_H before ResizeObserver has reported. */
export function nodeRenderedH(n: Pick<ScatterNode, 'renderedHeight'>): number {
  return n.renderedHeight && n.renderedHeight > 0 ? n.renderedHeight : FALLBACK_NODE_H;
}
