/**
 * Arrow header-labels for the ASCII aura field.
 *
 * Each arrow can carry a short pixel-font label naming the node at one end —
 * by default the CHILD (the node the arrow points at), so a parent's outgoing
 * arrows tell you what's downstream before you travel there. When the child is
 * fully on screen but the parent has scrolled off, the label flips to the
 * parent's name instead (label the unseen end).
 *
 * This module is the pure brain — exactly like statusText.ts, it knows nothing
 * about WebGL or canvas. It decides, in SCREEN space, which arrows get a label,
 * where the label box sits (orientation-aware, collision-avoiding), which glyph
 * cells it occupies, and what colour each cell takes (the parent group's accent
 * by default, or another node's aura accent where the label overlaps it). The
 * renderers feed it geometry each frame and draw the cells it returns, animating
 * appearance/disappearance through statusText's shared reveal/delete gate.
 */
import type { GroupColor, ScatterNode } from '@/store/types';
import { IMAGE_TITLE_PLACEHOLDER, isImageTitlePending } from '@/lib/imageQuestionTitle';
import { distanceToRectBorder } from './geometry';
import { statusGlyphIndex, wrapStatus } from './statusText';
import {
  AURA_RADIUS_UNFOCUSED,
  AURA_RADIUS_FOCUSED,
  FOCUS_BOOST,
  type Rect,
} from './sceneState';
import { resolveArrowLabelEnd } from '@/lib/arrowNav';

/** Hard cap on a label's on-screen width (CSS px). Measured on the SCREEN, so
 *  it's constant regardless of zoom (the glyphs are screen-locked). */
export const LABEL_MAX_W_PX = 300;
/** A label that needs more than this many wrapped lines is not displayed. */
export const LABEL_MAX_LINES = 5;

/** Diagonal-label centring eases from "centre the facing edge" (near an axis) to
 *  "centre the nearest corner" (diagonal) over this angle band, measured in
 *  degrees from the nearest axis. Below LO it's pure edge-centring (so a near-
 *  horizontal arrow never jumps); above HI it's pure corner-centring; between,
 *  smoothstep. See the slide note in layoutLabelBox. */
export const LABEL_SLIDE_BLEND_LO_DEG = 15;
export const LABEL_SLIDE_BLEND_HI_DEG = 30;

/** Aura radii / focus boost the colour sampler uses — same field the aura
 *  itself paints with, so a label's colour matches the glyphs it sits among. */
export const LABEL_AURA_RADII = {
  unfocused: AURA_RADIUS_UNFOCUSED,
  focused: AURA_RADIUS_FOCUSED,
  focusBoost: FOCUS_BOOST,
} as const;

export interface Pt { x: number; y: number; }

export interface LabelCell {
  /** Screen grid cell (col*cellPx, row*cellPx). */
  col: number;
  row: number;
  /** Absolute atlas glyph index (≥ RAMP_FLAT.length). */
  glyphIndex: number;
  /** World position of the cell centre — used to sample the aura colour. */
  worldX: number;
  worldY: number;
}

/** A node whose aura can recolour a label cell that falls inside it. Rect is in
 *  WORLD coordinates (the same space the aura field measures distance in). */
export interface AuraOwner {
  nodeId: string;
  rect: Rect;
  accent: GroupColor | null;
  focused: boolean;
}

// ── Text selection ──────────────────────────────────────────────────

/** Shared by label placement and its cache key so title-only updates reflow.
 * Chat titles already hold the first-prompt fallback until AI names the chat;
 * an active answer's header must never replace the conversation's title. */
export function nodeArrowLabelHeader(node: ScatterNode | undefined): string {
  if (!node) return '';
  if (isImageTitlePending(node)) return `${IMAGE_TITLE_PLACEHOLDER}...`;
  if (node.chat) {
    const title = node.chat.title.trim();
    if (title) return title;
    const first = node.chat.turns[0];
    const answer = first && node.versions.find((version) =>
      version.createdAt === first.selectedVersionCreatedAt && version.chat?.turnId === first.id);
    return answer?.chat?.question || 'Chat';
  }
  return node.versions[node.currentVersionIndex]?.header ?? '';
}

/** Uppercase + collapse runs of whitespace to single spaces + trim. */
export function sanitizeHeader(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Pick which end's header to show, then sanitize it. Default: the child's
 * header. Special case: when the child is fully visible AND the parent isn't
 * even partly on screen, show the parent's header instead. Returns null when
 * the chosen header is empty (→ no label).
 */
export function chooseHeader(opts: {
  childHeader: string;
  parentHeader: string;
  childFullyVisible: boolean;
  parentPartiallyVisible: boolean;
}): string | null {
  const useParent = resolveArrowLabelEnd(opts) === 'parent';
  const text = sanitizeHeader(useParent ? opts.parentHeader : opts.childHeader);
  return text.length > 0 ? text : null;
}

// ── Geometry ────────────────────────────────────────────────────────

/** Arc-length midpoint of a world-space polyline plus the unit direction of the
 *  segment that contains it. Returns null for an empty polyline. */
export function midpointAndDir(
  points: readonly Pt[],
): { x: number; y: number; dirX: number; dirY: number } | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  if (points.length === 1) return { x: first.x, y: first.y, dirX: 1, dirY: 0 };

  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    segLen.push(l);
    total += l;
  }
  if (total === 0) return { x: first.x, y: first.y, dirX: 1, dirY: 0 };

  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < segLen.length; i++) {
    const l = segLen[i]!;
    if (acc + l >= half) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const t = l > 0 ? (half - acc) / l : 0;
      let dirX = b.x - a.x;
      let dirY = b.y - a.y;
      const dl = Math.hypot(dirX, dirY) || 1;
      dirX /= dl;
      dirY /= dl;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dirX, dirY };
    }
    acc += l;
  }
  // Unreachable in practice (the loop always crosses `half`); fall back to the
  // last segment for total safety.
  const a = points[points.length - 2]!;
  const b = points[points.length - 1]!;
  let dirX = b.x - a.x;
  let dirY = b.y - a.y;
  const dl = Math.hypot(dirX, dirY) || 1;
  return { x: b.x, y: b.y, dirX: dirX / dl, dirY: dirY / dl };
}

/** "Mostly sideways" (label goes above/below) vs "mostly up-down" (label goes
 *  to the side). Ties count as horizontal. */
export function classifyOrientation(dirX: number, dirY: number): 'horizontal' | 'vertical' {
  return Math.abs(dirX) >= Math.abs(dirY) ? 'horizontal' : 'vertical';
}

// ── Visible span ────────────────────────────────────────────────────
// The label should mark the middle of the arrow the user SEES — the piece
// between the two card borders (arrow ends are painted under the cards when
// the polyline is a raw centre-to-centre fallback) and within the viewport.

function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Liang–Barsky boundary clip step: constraint p·t ≤ q on the window [t0,t1]. */
function clipT(p: number, q: number, t: { t0: number; t1: number }): boolean {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > t.t1) return false;
    if (r > t.t0) t.t0 = r;
  } else {
    if (r < t.t0) return false;
    if (r < t.t1) t.t1 = r;
  }
  return true;
}

/** The parameter window [t0,t1] of segment a→b that lies inside `rect`, or
 *  null when the segment misses it entirely. */
function segRectParams(a: Pt, b: Pt, rect: Rect): { t0: number; t1: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = { t0: 0, t1: 1 };
  if (!clipT(-dx, a.x - rect.x, t)) return null;
  if (!clipT(dx, rect.x + rect.w - a.x, t)) return null;
  if (!clipT(-dy, a.y - rect.y, t)) return null;
  if (!clipT(dy, rect.y + rect.h - a.y, t)) return null;
  return t.t0 <= t.t1 ? t : null;
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function polylineLen(points: readonly Pt[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
  }
  return total;
}

/** Drop the leading run of points inside `rect`, replacing it with the exact
 *  border-crossing point of the segment that leaves the rect. Unchanged when
 *  the polyline already starts outside; null when it never leaves. */
function trimStartAtRect(points: readonly Pt[], rect: Rect): Pt[] | null {
  let i = 0;
  while (i < points.length && pointInRect(points[i]!, rect)) i++;
  if (i === 0) return points.slice();
  if (i === points.length) return null;
  const a = points[i - 1]!;
  const b = points[i]!;
  const t = segRectParams(a, b, rect);
  const exit = t ? lerpPt(a, b, t.t1) : a;
  return [exit, ...points.slice(i)];
}

/**
 * The part of an arrow polyline actually visible between its two cards: both
 * ends trimmed to the exact border-crossing of their endpoint card rect. For
 * the 2-point centre-to-centre fallback this is precisely the border-to-border
 * segment the SVG shaft draws. Null when nothing remains (cards touching or
 * overlapping — the arrow is fully hidden, so no label should show).
 */
export function clipVisibleSpan(points: readonly Pt[], fromRect: Rect, toRect: Rect): Pt[] | null {
  if (points.length < 2) return null;
  const startTrimmed = trimStartAtRect(points, fromRect);
  if (!startTrimmed) return null;
  const endTrimmed = trimStartAtRect(startTrimmed.reverse(), toRect);
  if (!endTrimmed) return null;
  const span = endTrimmed.reverse();
  if (span.length < 2 || polylineLen(span) < 1e-6) return null;
  return span;
}

/**
 * The longest contiguous piece of a polyline inside `view` (the viewport in
 * world coordinates). Fully-visible polylines come back unchanged; a polyline
 * that exits and re-enters the screen yields its longest on-screen run, with
 * exact crossing points at the screen border. Null when nothing is on screen.
 */
export function longestOnScreenRun(points: readonly Pt[], view: Rect): Pt[] | null {
  const runs: Pt[][] = [];
  let cur: Pt[] | null = null;
  const close = () => {
    if (cur && cur.length >= 2) runs.push(cur);
    cur = null;
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const t = segRectParams(a, b, view);
    if (!t || t.t0 >= t.t1) { close(); continue; }
    const pa = t.t0 <= 0 ? a : lerpPt(a, b, t.t0);
    const pb = t.t1 >= 1 ? b : lerpPt(a, b, t.t1);
    if (!cur || t.t0 > 0) { close(); cur = [pa, pb]; }
    else cur.push(pb);
    if (t.t1 < 1) close(); // leaves the view mid-segment
  }
  close();
  let best: Pt[] | null = null;
  let bestLen = 1e-6; // ignore zero-length touches
  for (const run of runs) {
    const len = polylineLen(run);
    if (len > bestLen) { best = run; bestLen = len; }
  }
  return best;
}

// ── Placement ───────────────────────────────────────────────────────

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectInsideScreen(r: Rect, w: number, h: number, margin: number): boolean {
  return r.x >= margin && r.y >= margin && r.x + r.w <= w - margin && r.y + r.h <= h - margin;
}

/** A straight arrow segment in screen pixels (one piece of an arrow polyline). */
export interface Segment { x1: number; y1: number; x2: number; y2: number; }

function ccw(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (cy - ay) * (bx - ax) - (by - ay) * (cx - ax);
}

/** Do segments p1p2 and p3p4 cross (proper intersection)? Collinear touching is
 *  treated as no-cross — fine for the label-vs-arrow test. */
function segmentsCross(
  p1x: number, p1y: number, p2x: number, p2y: number,
  p3x: number, p3y: number, p4x: number, p4y: number,
): boolean {
  const d1 = ccw(p3x, p3y, p4x, p4y, p1x, p1y);
  const d2 = ccw(p3x, p3y, p4x, p4y, p2x, p2y);
  const d3 = ccw(p1x, p1y, p2x, p2y, p3x, p3y);
  const d4 = ccw(p1x, p1y, p2x, p2y, p4x, p4y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Does a segment touch a rect inflated by `clearance` on every side? True if an
 * endpoint lands inside, or the segment crosses any of the four edges. Used to
 * keep a label box off the arrow lines (which paint on top of the ASCII field
 * and would otherwise cut through the letters).
 */
export function segIntersectsRect(seg: Segment, rect: Rect, clearance: number): boolean {
  const x0 = rect.x - clearance;
  const y0 = rect.y - clearance;
  const x1 = rect.x + rect.w + clearance;
  const y1 = rect.y + rect.h + clearance;
  // Cheap reject: segment bbox vs rect bbox.
  if (Math.max(seg.x1, seg.x2) < x0 || Math.min(seg.x1, seg.x2) > x1) return false;
  if (Math.max(seg.y1, seg.y2) < y0 || Math.min(seg.y1, seg.y2) > y1) return false;
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(seg.x1, seg.y1) || inside(seg.x2, seg.y2)) return true;
  const { x1: ax, y1: ay, x2: bx, y2: by } = seg;
  return (
    segmentsCross(ax, ay, bx, by, x0, y0, x1, y0) || // top
    segmentsCross(ax, ay, bx, by, x1, y0, x1, y1) || // right
    segmentsCross(ax, ay, bx, by, x1, y1, x0, y1) || // bottom
    segmentsCross(ax, ay, bx, by, x0, y1, x0, y0)    // left
  );
}

export type LabelSide = 'above' | 'below' | 'left' | 'right';

/**
 * Choose where a label box of `boxW`×`boxH` goes relative to its `anchor` (the
 * on-screen arrow midpoint), given the arrow's local direction `(dirX,dirY)`.
 *
 * The box is offset PERPENDICULAR to the arrow line — not straight up/down — so
 * a diagonal arrow doesn't slice through it (a straight-up box on a 45° arrow
 * gets cut, because the line rises across the box's width). The primary side is
 * "above" for mostly-horizontal arrows (else "below"), "right" for mostly-
 * vertical arrows (else "left"). The offset distance fully clears the axis-
 * aligned box off the line: `gap` + the box's half-extent measured along the
 * normal. A candidate is rejected if it clips the screen edge, overlaps a
 * `reserved` rect (nodes / statuses / other labels), or is crossed by an arrow
 * `segment`. Returns null when neither side is free.
 */
export function layoutLabelBox(opts: {
  anchor: { x: number; y: number };
  dirX: number;
  dirY: number;
  boxW: number;
  boxH: number;
  screenW: number;
  screenH: number;
  reserved: readonly Rect[];
  gapPx: number;
  marginPx?: number;
  /** Arrow segments (screen px) the box must not cross — arrows paint over the
   *  ASCII field, so a line through the box makes the label unreadable. */
  segments?: readonly Segment[];
  segClearancePx?: number;
}): { x: number; y: number; side: LabelSide } | null {
  const margin = opts.marginPx ?? 4;
  const segClearance = opts.segClearancePx ?? 4;
  const { anchor, boxW, boxH, gapPx } = opts;
  const horizontal = Math.abs(opts.dirX) >= Math.abs(opts.dirY);

  // Unit normal to the arrow; orient the PRIMARY normal up (horizontal arrows)
  // or right (vertical arrows). The two candidates are ±normal.
  let nx = -opts.dirY;
  let ny = opts.dirX;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen;
  ny /= nlen;
  if (horizontal) { if (ny > 0) { nx = -nx; ny = -ny; } } // point up
  else { if (nx < 0) { nx = -nx; ny = -ny; } }            // point right

  const dist = gapPx + (boxW * Math.abs(nx) + boxH * Math.abs(ny)) / 2;

  // Slide the box ALONG the arrow so it reads as centred on the line. Two terms,
  // each cancelling one corner offset of the box: `edgeTerm` centres the edge
  // FACING the arrow (box bottom/top for a horizontal-ish arrow, left/right for a
  // vertical-ish one); `cornerTerm` is the extra shift that instead centres the
  // nearest CORNER. The edge term is always applied — it stays small and never
  // flips sign near its axis. The corner term is faded in by the arrow's angle
  // from that axis (LO→HI degrees, smoothstep): off near the axis (so a slight
  // slope can't fling the label ~half a box-width — its sign() flips at 0°), full
  // for a diagonal (the corner is where the label visually attaches). The two
  // meet at 45° (full corner-centring on both sides), so nothing jumps as the
  // arrow rotates. Sliding parallel to the line preserves the perpendicular gap,
  // so the box stays clear of the arrow.
  const dl = Math.hypot(opts.dirX, opts.dirY) || 1;
  const dux = opts.dirX / dl;
  const duy = opts.dirY / dl;
  const edgeTerm = horizontal ? Math.sign(ny) * (boxH / 2) * duy : Math.sign(nx) * (boxW / 2) * dux;
  const cornerTerm = horizontal ? Math.sign(nx) * (boxW / 2) * dux : Math.sign(ny) * (boxH / 2) * duy;
  const axisAngleDeg = (horizontal
    ? Math.atan2(Math.abs(duy), Math.abs(dux))
    : Math.atan2(Math.abs(dux), Math.abs(duy))) * (180 / Math.PI);
  const tBlend = Math.min(1, Math.max(0,
    (axisAngleDeg - LABEL_SLIDE_BLEND_LO_DEG) / (LABEL_SLIDE_BLEND_HI_DEG - LABEL_SLIDE_BLEND_LO_DEG)));
  const slide = edgeTerm + tBlend * tBlend * (3 - 2 * tBlend) * cornerTerm; // smoothstep ease

  const sideA: LabelSide = horizontal ? 'above' : 'right';
  const sideB: LabelSide = horizontal ? 'below' : 'left';
  const candidates: { x: number; y: number; side: LabelSide }[] = [
    { side: sideA, x: anchor.x + nx * dist + slide * dux - boxW / 2, y: anchor.y + ny * dist + slide * duy - boxH / 2 },
    { side: sideB, x: anchor.x - nx * dist - slide * dux - boxW / 2, y: anchor.y - ny * dist - slide * duy - boxH / 2 },
  ];
  for (const c of candidates) {
    const r: Rect = { x: c.x, y: c.y, w: boxW, h: boxH };
    if (!rectInsideScreen(r, opts.screenW, opts.screenH, margin)) continue;
    if (opts.reserved.some((rr) => rectsOverlap(r, rr))) continue;
    if (opts.segments && opts.segments.some((seg) => segIntersectsRect(seg, r, segClearance))) continue;
    return c;
  }
  return null;
}

// ── Cell building + colour ──────────────────────────────────────────

/** Lay wrapped lines into screen-grid cells (centred per line under the widest
 *  line), skipping spaces, and record each cell's world position for colouring. */
export function buildLabelCells(opts: {
  lines: readonly string[];
  boxX: number;
  boxY: number;
  cellPx: number;
  viewport: { x: number; y: number; zoom: number };
}): LabelCell[] {
  const { lines, cellPx, viewport } = opts;
  if (lines.length === 0) return [];
  const baseCol = Math.round(opts.boxX / cellPx);
  const baseRow = Math.round(opts.boxY / cellPx);
  let maxLen = 0;
  for (const l of lines) if (l.length > maxLen) maxLen = l.length;

  const out: LabelCell[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const row = baseRow + li;
    const lineStart = baseCol + Math.floor((maxLen - line.length) / 2);
    for (let ci = 0; ci < line.length; ci++) {
      const gi = statusGlyphIndex(line[ci]!);
      if (gi == null) continue; // space → gap, the aura field shows through
      const col = lineStart + ci;
      const cxScreen = (col + 0.5) * cellPx;
      const cyScreen = (row + 0.5) * cellPx;
      out.push({
        col,
        row,
        glyphIndex: gi,
        worldX: (cxScreen - viewport.x) / viewport.zoom,
        worldY: (cyScreen - viewport.y) / viewport.zoom,
      });
    }
  }
  return out;
}

/**
 * Colour for a single label cell. Default is the parent node's group accent;
 * if the cell falls inside another node's aura, that aura's accent wins. When
 * several auras overlap, the strongest (closest-to-border / focus-boosted)
 * takes the cell — picking the dominant owner rather than a per-cell lottery so
 * the letters in a region read as one solid colour.
 */
export function cellAccent(
  worldX: number,
  worldY: number,
  parentAccent: GroupColor | null,
  owners: readonly AuraOwner[],
  radii: { unfocused: number; focused: number; focusBoost: number },
): GroupColor | null {
  let bestW = 0;
  let best: AuraOwner | null = null;
  for (const o of owners) {
    const radius = o.focused ? radii.focused : radii.unfocused;
    const d = distanceToRectBorder(worldX, worldY, o.rect.x, o.rect.y, o.rect.w, o.rect.h);
    if (d >= radius) continue;
    const w = (1 - d / radius) * (o.focused ? radii.focusBoost : 1);
    if (w > bestW) {
      bestW = w;
      best = o;
    }
  }
  return best ? best.accent : parentAccent;
}

// ── Wrapping ────────────────────────────────────────────────────────

/** Smallest line width (cols) in [loCols, hiCols] whose greedy wrap of `text`
 *  fits in ≤ maxLines lines, or null if even hiCols can't. Monotonic (wider →
 *  fewer lines), so a binary search finds the narrowest that still fits. */
function minColsForLines(text: string, maxLines: number, loCols: number, hiCols: number): number | null {
  if (loCols > hiCols) return null;
  if (wrapStatus(text, hiCols).length > maxLines) return null;
  let lo = loCols;
  let hi = hiCols;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (wrapStatus(text, mid).length <= maxLines) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Wrapping candidates for a label, **widest (fewest lines) first**. For each
 * line budget 1..maxLines it produces the narrowest balanced wrap that fits in
 * that many lines (never narrower than the longest word — no mid-word splits),
 * skipping budgets that don't add a new line count. This lets a label squeezed
 * for horizontal room fall back to a taller, narrower shape (using the full
 * 3-line budget) instead of vanishing. Returns [] when the text can't fit in
 * maxLines lines at maxCols.
 */
export function labelWrapCandidates(text: string, maxCols: number, maxLines: number): string[][] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  let longest = 1;
  for (const w of words) if (w.length > longest) longest = w.length;
  const lo = Math.min(maxCols, longest);

  const out: string[][] = [];
  let lastCount = 0;
  for (let n = 1; n <= maxLines; n++) {
    const cols = minColsForLines(text, n, lo, maxCols);
    if (cols == null) continue;
    const lines = wrapStatus(text, cols);
    if (lines.length === 0 || lines.length > maxLines) continue;
    if (lines.length <= lastCount) continue; // a wider budget already produced this many lines
    lastCount = lines.length;
    out.push(lines);
  }
  return out;
}

// ── Orchestrator ────────────────────────────────────────────────────

export interface ArrowLabelInput {
  /** Arrows with their world-space polyline (index 0 = parent port, last =
   *  child port) — already resolved from anchors / fallback by the renderer —
   *  plus the two endpoint card rects (world) the polyline gets clipped to. */
  arrows: { id: string; fromNodeId: string; toNodeId: string; points: Pt[]; fromRect: Rect; toRect: Rect }[];
  /** Current header text for a node id. */
  headerOf: (nodeId: string) => string;
  fullyVisible: (nodeId: string) => boolean;
  partiallyVisible: (nodeId: string) => boolean;
  /** Group accent of a node (null = ungrouped). */
  parentAccentOf: (nodeId: string) => GroupColor | null;
  viewport: { x: number; y: number; zoom: number };
  screenW: number;
  screenH: number;
  cellPx: number;
  /** Screen rects to avoid (node cards + status boxes). Labels are appended as
   *  they're placed, so later labels avoid earlier ones too. */
  reserved: Rect[];
  /** Live aura owners (world rects + accents) for per-cell colouring. */
  owners: AuraOwner[];
  /** Gap between the arrow midpoint and the label box (default cellPx*1.5). */
  gapPx?: number;
  /** How far a label must stay clear of any arrow line (default cellPx*0.5). */
  segClearancePx?: number;
  /** Dev-only: a counters object the function fills with the drop breakdown. */
  debug?: ArrowLabelDebug;
}

export interface ArrowLabelPlacement {
  arrowId: string;
  /** The sanitized header being shown (the label's identity for animation). */
  text: string;
  /** Node named by this label — clicking either the label or shaft goes here. */
  targetNodeId: string;
  /** Grid-aligned screen rectangle covering the full wrapped label, spaces too. */
  hitRect: Rect;
  cells: LabelCell[];
  /** Per-cell accent, parallel to `cells`. */
  accents: (GroupColor | null)[];
}

/** Dev-only drop breakdown — pass an instance in `input.debug` and read the
 *  filled counts after to see WHY arrows didn't get a label this frame. */
export interface ArrowLabelDebug {
  arrows: number;            // total arrows fed in
  noVisibleSpan: number;     // arrow fully hidden under its two cards
  tooShort: number;          // card-clipped world rope is under 200px
  midpointOffscreen: number; // no part of the visible span is on screen
  emptyHeader: number;       // chosen header empty
  tooManyLines: number;      // header wrapped past 300px / 5 lines
  noPlacement: number;       // no side clear of edges / nodes / statuses / arrows
  placed: number;            // got a label
  maxCols: number;           // 300px ÷ cellPx
  cellPx: number;
  screenW: number;
  screenH: number;
}

export function computeArrowLabels(input: ArrowLabelInput): ArrowLabelPlacement[] {
  const { viewport, screenW, screenH, cellPx } = input;
  const gap = input.gapPx ?? cellPx * 1.5;
  const segClearance = input.segClearancePx ?? cellPx * 0.5;
  const maxCols = Math.max(1, Math.floor(LABEL_MAX_W_PX / cellPx));
  const reserved: Rect[] = input.reserved.slice();
  const dbg = input.debug;
  if (dbg) {
    dbg.arrows = input.arrows.length;
    dbg.maxCols = maxCols;
    dbg.cellPx = cellPx;
    dbg.screenW = screenW;
    dbg.screenH = screenH;
  }

  // Each arrow's VISIBLE span: polyline clipped to its two card rects (the
  // parts under the cards aren't painted, so they mustn't pull the midpoint).
  const spans = new Map<string, Pt[]>();
  for (const a of input.arrows) {
    const span = clipVisibleSpan(a.points, a.fromRect, a.toRect);
    if (span) spans.set(a.id, span);
    else if (dbg) dbg.noVisibleSpan++;
  }

  // Every visible span, projected to screen segments. Labels must clear ALL
  // of them (its own arrow and any other) so no line paints through the letters.
  const segments: Segment[] = [];
  for (const pts of spans.values()) {
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      segments.push({
        x1: p.x * viewport.zoom + viewport.x,
        y1: p.y * viewport.zoom + viewport.y,
        x2: q.x * viewport.zoom + viewport.x,
        y2: q.y * viewport.zoom + viewport.y,
      });
    }
  }

  // Anchor each label at the arc-length midpoint of the LONGEST ON-SCREEN run
  // of the visible span — the middle of the arrow the user actually sees, so a
  // half-scrolled-off arrow keeps its label on the on-screen part instead of
  // losing it. Sort longest-on-screen-arrow first so prominent arrows win the
  // slot.
  const viewWorld: Rect = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    w: screenW / viewport.zoom,
    h: screenH / viewport.zoom,
  };
  type Cand = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    midScreen: { x: number; y: number };
    dirX: number;
    dirY: number;
    screenLen: number;
  };
  const cands: Cand[] = [];
  for (const a of input.arrows) {
    const span = spans.get(a.id);
    if (!span) continue;
    // Eligibility is based on the complete card-clipped rope in WORLD units,
    // so 200 canvas pixels means the same thing at every camera zoom. Short
    // arrows still remain in `segments` above and can block another label.
    if (polylineLen(span) < 200) { if (dbg) dbg.tooShort++; continue; }
    const run = longestOnScreenRun(span, viewWorld);
    if (!run) { if (dbg) dbg.midpointOffscreen++; continue; }
    const mid = midpointAndDir(run);
    if (!mid) continue;
    const sx = mid.x * viewport.zoom + viewport.x;
    const sy = mid.y * viewport.zoom + viewport.y;
    // Safety net — the run is on-screen by construction.
    if (sx < 0 || sx > screenW || sy < 0 || sy > screenH) { if (dbg) dbg.midpointOffscreen++; continue; }
    const p0 = run[0]!;
    const p1 = run[run.length - 1]!;
    const screenLen = Math.hypot((p1.x - p0.x) * viewport.zoom, (p1.y - p0.y) * viewport.zoom);
    cands.push({
      id: a.id,
      fromNodeId: a.fromNodeId,
      toNodeId: a.toNodeId,
      midScreen: { x: sx, y: sy },
      dirX: mid.dirX,
      dirY: mid.dirY,
      screenLen,
    });
  }
  cands.sort((a, b) => b.screenLen - a.screenLen);

  const out: ArrowLabelPlacement[] = [];
  for (const c of cands) {
    const childFullyVisible = input.fullyVisible(c.toNodeId);
    const parentPartiallyVisible = input.partiallyVisible(c.fromNodeId);
    const end = resolveArrowLabelEnd({
      childFullyVisible,
      parentPartiallyVisible,
    });
    const text = chooseHeader({
      childHeader: input.headerOf(c.toNodeId),
      parentHeader: input.headerOf(c.fromNodeId),
      childFullyVisible,
      parentPartiallyVisible,
    });
    if (!text) { if (dbg) dbg.emptyHeader++; continue; }

    const candidates = labelWrapCandidates(text, maxCols, LABEL_MAX_LINES);
    if (candidates.length === 0) { if (dbg) dbg.tooManyLines++; continue; }

    // Try candidates widest-first (fewest lines). If the wide form doesn't fit,
    // fall back to a narrower/taller wrap so the label re-shapes rather than
    // vanishing. First one that places wins.
    let chosen: { lines: string[]; x: number; y: number; boxW: number; boxH: number } | null = null;
    for (const lines of candidates) {
      let maxLen = 0;
      for (const l of lines) if (l.length > maxLen) maxLen = l.length;
      const boxW = maxLen * cellPx;
      const boxH = lines.length * cellPx;
      const placed = layoutLabelBox({
        anchor: c.midScreen,
        dirX: c.dirX,
        dirY: c.dirY,
        boxW,
        boxH,
        screenW,
        screenH,
        reserved,
        gapPx: gap,
        segments,
        segClearancePx: segClearance,
      });
      if (placed) { chosen = { lines, x: placed.x, y: placed.y, boxW, boxH }; break; }
    }
    if (!chosen) { if (dbg) dbg.noPlacement++; continue; }

    const cells = buildLabelCells({ lines: chosen.lines, boxX: chosen.x, boxY: chosen.y, cellPx, viewport });
    const parentAccent = input.parentAccentOf(c.fromNodeId);
    const accents = cells.map((cell) =>
      cellAccent(cell.worldX, cell.worldY, parentAccent, input.owners, LABEL_AURA_RADII),
    );
    reserved.push({ x: chosen.x, y: chosen.y, w: chosen.boxW, h: chosen.boxH });
    const maxLineLength = chosen.lines.reduce((max, line) => Math.max(max, line.length), 0);
    const hitRect = {
      x: Math.round(chosen.x / cellPx) * cellPx,
      y: Math.round(chosen.y / cellPx) * cellPx,
      w: maxLineLength * cellPx,
      h: chosen.lines.length * cellPx,
    };
    out.push({
      arrowId: c.id,
      text,
      targetNodeId: end === 'parent' ? c.fromNodeId : c.toNodeId,
      hitRect,
      cells,
      accents,
    });
    if (dbg) dbg.placed++;
  }
  return out;
}
