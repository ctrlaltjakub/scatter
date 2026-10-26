/* -------------------------------------------------------------------------
 * Rope geometric-quality metrics.
 *
 * Operates on a single simulation frame (so the same code can score the
 * final/settled state OR any intermediate frame). The shape is what the
 * physics worker emits per tick — node positions plus per-arrow anchor
 * polylines.
 *
 * Each function maps to a criterion in `scripts/rope-spec.md`. Run on
 * the last frame of a settled recording to score that scene.
 * ------------------------------------------------------------------------*/

import type { Recording } from '@/lib/sandboxRecording';

export type Pt = { x: number; y: number };
export type Frame = {
  t: number;
  nodes: { id: string; x: number; y: number }[];
  arrows: Record<string, Pt[]>;
};
export type Rect = { id: string; x: number; y: number; w: number; h: number };

const DEFAULT_W = 420;
const DEFAULT_H = 120;

/** ropeMargin from defaults — what the router INFLATES every obstacle by
 *  when computing the visibility-graph path. Anchors near a non-endpoint
 *  node should sit ~this far from the node's body. */
export const ROPE_MARGIN = 40;

/** Build a sizes map from a recording's initial project. The live
 *  Canvas sends per-node set-size messages with the actual rendered
 *  height (text content makes nodes taller than the 120 px default).
 *  Without this map the harness silently uses 120 px and every rect-
 *  based metric is wrong. */
export function rectSizesFromRecording(rec: Recording): Map<string, { w: number; h: number }> {
  const out = new Map<string, { w: number; h: number }>();
  for (const n of Object.values(rec.initialProject.nodes)) {
    const v = n.versions[n.currentVersionIndex];
    out.set(n.id, {
      w: v?.width ?? DEFAULT_W,
      h: n.renderedHeight ?? v?.bodyMaxHeight ?? DEFAULT_H,
    });
  }
  return out;
}

export function rectsAtFrame(frame: Frame, sizes?: Map<string, { w: number; h: number }>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const n of frame.nodes) {
    const sz = sizes?.get(n.id);
    out.set(n.id, { id: n.id, x: n.x, y: n.y, w: sz?.w ?? DEFAULT_W, h: sz?.h ?? DEFAULT_H });
  }
  return out;
}

// ---------- P0.1 endpoint attachment --------------------------------------

/** For each arrow, distance from first/last anchor to the nearest border of
 *  its source/target rect. Should be ~0 (anchor sits on border). */
export function endpointAttachment(
  frame: Frame,
  rec: Recording,
  sizes?: Map<string, { w: number; h: number }>,
): { arrowId: string; srcGap: number; tgtGap: number }[] {
  const rects = rectsAtFrame(frame, sizes);
  const out: { arrowId: string; srcGap: number; tgtGap: number }[] = [];
  for (const [aid, anchors] of Object.entries(frame.arrows)) {
    if (anchors.length < 2) continue;
    const arrow = rec.initialProject.arrows[aid];
    if (!arrow) continue;
    const src = rects.get(arrow.fromNodeId);
    const tgt = rects.get(arrow.toNodeId);
    if (!src || !tgt) continue;
    const srcGap = distToRectBorder(anchors[0]!, src);
    const tgtGap = distToRectBorder(anchors[anchors.length - 1]!, tgt);
    if (process.env.DEBUG_P01 === aid) {
      const last = anchors[anchors.length - 1]!;
      // eslint-disable-next-line no-console
      console.log(`[P0.1 ${aid}] last anchor=(${last.x.toFixed(1)},${last.y.toFixed(1)}) tgtRect=(${tgt.x.toFixed(1)},${tgt.y.toFixed(1)},${tgt.w},${tgt.h}) tgtGap=${tgtGap.toFixed(1)}`);
    }
    out.push({ arrowId: aid, srcGap, tgtGap });
  }
  return out.sort((a, b) => Math.max(b.srcGap, b.tgtGap) - Math.max(a.srcGap, a.tgtGap));
}

// ---------- P0.2 no interior piercing ------------------------------------

/** For each arrow, count segments whose interior crosses a non-endpoint
 *  node's body. Should be 0 — the routed polyline must avoid every node
 *  except its own endpoints. */
export function interiorPiercings(
  frame: Frame,
  rec: Recording,
  sizes?: Map<string, { w: number; h: number }>,
): { arrowId: string; nodeId: string; segmentIdx: number; depth: number }[] {
  const rects = rectsAtFrame(frame, sizes);
  const out: { arrowId: string; nodeId: string; segmentIdx: number; depth: number }[] = [];
  for (const [aid, anchors] of Object.entries(frame.arrows)) {
    if (anchors.length < 2) continue;
    const arrow = rec.initialProject.arrows[aid];
    if (!arrow) continue;
    const skip = new Set([arrow.fromNodeId, arrow.toNodeId]);
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i]!, b = anchors[i + 1]!;
      for (const r of rects.values()) {
        if (skip.has(r.id)) continue;
        const d = segmentRectPenetration(a, b, r);
        if (d > 0) out.push({ arrowId: aid, nodeId: r.id, segmentIdx: i, depth: d });
      }
    }
  }
  return out.sort((a, b) => b.depth - a.depth);
}

// ---------- P0.4 endpoint stacking ---------------------------------------

/** For each node, find the minimum pairwise distance between rope-endpoint
 *  anchors attached to it. Low values (<10px) indicate overlapping
 *  attachment points (which look like stacked endpoints visually). */
export function endpointStacking(frame: Frame): { nodeId: string; minDist: number; pair: [string, string] }[] {
  const perNode = new Map<string, { aid: string; p: Pt }[]>();
  for (const [aid, anchors] of Object.entries(frame.arrows)) {
    if (anchors.length < 2) continue;
    // Use arrow info from rec.initialProject if needed but we just need
    // node IDs here; pull from frame.nodes via proximity.
    // Better approach: the source/target are encoded in the arrow ID
    // when sandbox is the project ('arrow_<from>_<to>') — fall back to
    // proximity match if not.
    const m = /^arrow_([^_]+)_(.+)$/.exec(aid);
    if (!m) continue;
    const fromId = m[1]!, toId = m[2]!;
    (perNode.get(fromId) ?? perNode.set(fromId, []).get(fromId)!).push({ aid, p: anchors[0]! });
    (perNode.get(toId)   ?? perNode.set(toId, []).get(toId)!).push({ aid, p: anchors[anchors.length - 1]! });
  }
  const out: { nodeId: string; minDist: number; pair: [string, string] }[] = [];
  for (const [nid, eps] of perNode) {
    if (eps.length < 2) continue;
    let best = Infinity, bestPair: [string, string] = [eps[0]!.aid, eps[1]!.aid];
    for (let i = 0; i < eps.length; i++) for (let j = i + 1; j < eps.length; j++) {
      const d = Math.hypot(eps[i]!.p.x - eps[j]!.p.x, eps[i]!.p.y - eps[j]!.p.y);
      if (d < best) { best = d; bestPair = [eps[i]!.aid, eps[j]!.aid]; }
    }
    out.push({ nodeId: nid, minDist: best, pair: bestPair });
  }
  return out.sort((a, b) => a.minDist - b.minDist);
}

// ---------- P1.4 non-shared-endpoint crossings ---------------------------

/** Count segment-segment intersections between every pair of arrows.
 *  Crossings between arrows that share an endpoint (e.g. B→H and B→J
 *  near B) are structural and counted separately. */
export function ropeCrossings(frame: Frame): {
  sharedEndpoint: number;
  nonShared: number;
  byPair: Map<string, { shared: boolean; count: number }>;
} {
  const arrows = Object.entries(frame.arrows).filter(([, a]) => a.length >= 2);
  const byPair = new Map<string, { shared: boolean; count: number }>();
  let sharedEndpoint = 0, nonShared = 0;
  for (let i = 0; i < arrows.length; i++) {
    for (let j = i + 1; j < arrows.length; j++) {
      const [aId, aPts] = arrows[i]!;
      const [bId, bPts] = arrows[j]!;
      const shared = sharedNodeIds(aId, bId);
      let count = 0;
      for (let p = 0; p < aPts.length - 1; p++) {
        for (let q = 0; q < bPts.length - 1; q++) {
          // Skip segments at the shared-endpoint side (the first/last
          // segment of each chain anchored to the shared node).
          if (shared && atSharedEndpoint(aId, p, aPts.length, bId, q, bPts.length, shared)) continue;
          if (segIntersect(aPts[p]!, aPts[p + 1]!, bPts[q]!, bPts[q + 1]!)) count++;
        }
      }
      if (count === 0) continue;
      const key = `${aId}↔${bId}`;
      byPair.set(key, { shared: !!shared, count });
      if (shared) sharedEndpoint += count; else nonShared += count;
    }
  }
  return { sharedEndpoint, nonShared, byPair };
}

// ---------- Corner clearance & edge parallelism (the new criterion) ------

/**
 * For each interior anchor (not first or last) of every rope, find the
 * nearest non-endpoint node and measure the gap from the anchor to that
 * node's rect border. Compare against ROPE_MARGIN (the inflation the
 * router uses). When the rope rounds a corner the anchor SHOULD sit at
 * margin-distance from the corner. If clearances vary widely on the same
 * obstacle, the rope is rounding inconsistently.
 *
 * Also measures, for each pair of consecutive anchors that share their
 * "nearest non-endpoint node", whether the segment between them is
 * parallel to that node's nearest edge (≤5° tilt = parallel).
 */
export function cornerClearance(frame: Frame, rec: Recording, sizes?: Map<string, { w: number; h: number }>): {
  perArrow: {
    arrowId: string;
    nearestNode: Map<number /* anchor idx */, { nodeId: string; gap: number }>;
    inconsistent: { nodeId: string; gaps: number[]; std: number }[];
    nonParallel: { nodeId: string; segmentIdx: number; tiltDeg: number; lengthPx: number }[];
  }[];
} {
  const rects = rectsAtFrame(frame, sizes);
  const perArrow: ReturnType<typeof cornerClearance>['perArrow'] = [];

  for (const [aid, anchors] of Object.entries(frame.arrows)) {
    if (anchors.length < 3) continue;
    const arrow = rec.initialProject.arrows[aid];
    if (!arrow) continue;
    const skip = new Set([arrow.fromNodeId, arrow.toNodeId]);

    const nearest = new Map<number, { nodeId: string; gap: number }>();
    // For each interior anchor, find the nearest non-endpoint node.
    for (let i = 1; i < anchors.length - 1; i++) {
      const a = anchors[i]!;
      let bestId: string | null = null;
      let bestGap = Infinity;
      for (const r of rects.values()) {
        if (skip.has(r.id)) continue;
        const gap = pointToRectGap(a, r);
        if (gap < bestGap) { bestGap = gap; bestId = r.id; }
      }
      if (bestId !== null) nearest.set(i, { nodeId: bestId, gap: bestGap });
    }

    // Group anchors by nearest node. Anchors near the SAME node form a
    // "rounding sequence" along that node's perimeter.
    const byNode = new Map<string, number[]>();
    for (const [idx, info] of nearest) {
      // Only count anchors that are within the rounding zone — anchors
      // far from every node aren't really "rounding" anything.
      if (info.gap > ROPE_MARGIN * 2) continue;
      const arr = byNode.get(info.nodeId) ?? [];
      arr.push(idx);
      byNode.set(info.nodeId, arr);
    }

    // Inconsistent clearances: high std-dev across a single obstacle's
    // rounding sequence indicates the rope is hugging the corner on one
    // side and drifting away on the other.
    const inconsistent: { nodeId: string; gaps: number[]; std: number }[] = [];
    for (const [nodeId, idxs] of byNode) {
      if (idxs.length < 2) continue;
      const gaps = idxs.map((i) => nearest.get(i)!.gap);
      const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
      const variance = gaps.reduce((s, v) => s + (v - mean) ** 2, 0) / gaps.length;
      const std = Math.sqrt(variance);
      if (std > 15) inconsistent.push({ nodeId, gaps, std });
    }

    // Non-parallel segments: when two consecutive anchors share their
    // nearest-node, the segment between them should run parallel to
    // that node's relevant edge. Compute tilt; flag > 5°.
    const nonParallel: { nodeId: string; segmentIdx: number; tiltDeg: number; lengthPx: number }[] = [];
    for (let i = 1; i < anchors.length - 2; i++) {
      const n1 = nearest.get(i);
      const n2 = nearest.get(i + 1);
      if (!n1 || !n2 || n1.nodeId !== n2.nodeId) continue;
      // Skip if either endpoint is too far from the node (not really rounding).
      if (n1.gap > ROPE_MARGIN * 2 || n2.gap > ROPE_MARGIN * 2) continue;
      const rect = rects.get(n1.nodeId);
      if (!rect) continue;
      const a = anchors[i]!, b = anchors[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 25) continue; // ignore short transition kinks; bezier smooths them
      const tiltDeg = parallelTiltDeg(a, b, rect);
      if (tiltDeg > 5) nonParallel.push({ nodeId: n1.nodeId, segmentIdx: i, tiltDeg, lengthPx: len });
    }

    perArrow.push({ arrowId: aid, nearestNode: nearest, inconsistent, nonParallel });
  }

  return { perArrow };
}

// ---------- helpers --------------------------------------------------------

function distToRectBorder(p: Pt, r: Rect): number {
  // For a point ON the border returns 0. Distance from interior returns
  // the (negative) signed distance — but we use a non-negative measure:
  // distance to nearest face.
  const dx = Math.max(r.x - p.x, p.x - (r.x + r.w), 0);
  const dy = Math.max(r.y - p.y, p.y - (r.y + r.h), 0);
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  // Inside the rect — return distance to nearest face (so a point at
  // border returns 0 and one inside returns a positive value).
  return Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
}

function pointToRectGap(p: Pt, r: Rect): number {
  // Gap = unsigned distance from p to nearest border of r. For points
  // strictly INSIDE the rect this returns a negative value (penetration
  // depth).
  const dx = Math.max(r.x - p.x, p.x - (r.x + r.w), 0);
  const dy = Math.max(r.y - p.y, p.y - (r.y + r.h), 0);
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return -Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
}

function segmentRectPenetration(a: Pt, b: Pt, r: Rect): number {
  // Returns the maximum depth that the segment's interior penetrates
  // the rect's interior. 0 means the segment merely grazes or stays
  // outside. We sample along the segment.
  const steps = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 8));
  let maxDepth = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const g = pointToRectGap({ x, y }, r);
    if (g < 0 && -g > maxDepth) maxDepth = -g;
  }
  return maxDepth;
}

function parallelTiltDeg(a: Pt, b: Pt, _r: Rect): number {
  // A segment running ALONG a rectangular obstacle should be parallel to
  // either the rect's x-axis (top/bottom edges) OR its y-axis
  // (left/right edges). Return the MIN tilt vs both axes, so a segment
  // that's near-horizontal scores low (parallel to top/bottom) and a
  // segment that's near-vertical scores low (parallel to left/right).
  // Diagonal segments score high regardless of which face is nearest.
  const segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (segLen === 0) return 0;
  const segAngle = Math.atan2(b.y - a.y, b.x - a.x); // -π..π
  // Tilt vs horizontal: distance from 0 or ±π.
  const tiltH = Math.min(Math.abs(segAngle), Math.abs(Math.abs(segAngle) - Math.PI));
  // Tilt vs vertical: distance from ±π/2.
  const tiltV = Math.abs(Math.abs(segAngle) - Math.PI / 2);
  const tilt = Math.min(tiltH, tiltV);
  return (tilt * 180) / Math.PI;
}

function sharedNodeIds(aId: string, bId: string): Set<string> | null {
  const aMatch = /^arrow_([^_]+)_(.+)$/.exec(aId);
  const bMatch = /^arrow_([^_]+)_(.+)$/.exec(bId);
  if (!aMatch || !bMatch) return null;
  const aNodes = new Set([aMatch[1]!, aMatch[2]!]);
  const shared = new Set<string>();
  if (aNodes.has(bMatch[1]!)) shared.add(bMatch[1]!);
  if (aNodes.has(bMatch[2]!)) shared.add(bMatch[2]!);
  return shared.size > 0 ? shared : null;
}

function atSharedEndpoint(
  aId: string, aSeg: number, aLen: number,
  bId: string, bSeg: number, bLen: number,
  shared: Set<string>,
): boolean {
  // True if both segments are anchored at the same shared endpoint
  // (first/last segment of each rope on the shared node's side).
  const aMatch = /^arrow_([^_]+)_(.+)$/.exec(aId)!;
  const bMatch = /^arrow_([^_]+)_(.+)$/.exec(bId)!;
  const aAtStart = shared.has(aMatch[1]!) && aSeg === 0;
  const aAtEnd   = shared.has(aMatch[2]!) && aSeg === aLen - 2;
  const bAtStart = shared.has(bMatch[1]!) && bSeg === 0;
  const bAtEnd   = shared.has(bMatch[2]!) && bSeg === bLen - 2;
  return (aAtStart || aAtEnd) && (bAtStart || bAtEnd);
}

function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return false;
  const sx = p3.x - p1.x, sy = p3.y - p1.y;
  const t = (sx * d2y - sy * d2x) / denom;
  const u = (sx * d1y - sy * d1x) / denom;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}
