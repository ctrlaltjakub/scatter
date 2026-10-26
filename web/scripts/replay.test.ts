/* -------------------------------------------------------------------------
 * Headless replay harness for sandbox recordings.
 *
 * Loads a recording from `recs/`, drives the SAME physicsWorker logic the
 * browser uses (via dispatchMessage / tickOnce — not a real Worker), feeds
 * the recorded input stream back in at the recorded timestamps, and
 * prints an analysis comparing the live re-simulation against what the
 * user originally saw.
 *
 * Run: `npx vitest run scripts/replay` from the `web/` directory.
 * Override input path with REC env var:
 *   `REC=path/to/recording.json npx vitest run scripts/replay`
 * ------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'vitest';
import {
  dispatchMessage,
  setEmit,
  tickOnce,
  stopAutoTimer,
  inspectNode,
  setForceEmitEveryTick,
} from '@/physics/physicsWorker';
import type { Recording } from '@/lib/sandboxRecording';
import {
  endpointAttachment, interiorPiercings, endpointStacking, ropeCrossings,
  cornerClearance, ROPE_MARGIN, rectSizesFromRecording,
} from './ropeMetrics';

// ----- recording loader ----------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECS_DIR = path.join(REPO_ROOT, 'recs');

function findRecording(): { rec: Recording; path: string } {
  if (process.env.REC) {
    const p = path.resolve(process.env.REC);
    return { rec: JSON.parse(fs.readFileSync(p, 'utf8')) as Recording, path: p };
  }
  const files = fs.readdirSync(RECS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(RECS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`No recordings in ${RECS_DIR}`);
  const p = path.join(RECS_DIR, files[0]!.f);
  return { rec: JSON.parse(fs.readFileSync(p, 'utf8')) as Recording, path: p };
}

// ----- simulation runner ---------------------------------------------------

interface SimFrame {
  t: number;
  nodes: { id: string; x: number; y: number }[];
  arrows: Record<string, { x: number; y: number }[]>;
  /** Diagnostic: for dragged nodes, what their fx/fy was at the moment
   *  this frame was emitted. Helps distinguish "pinning wasn't applied"
   *  from "fx/fy was set to the wrong value". */
  draggedFxFy?: Record<string, { fx: number | null; fy: number | null; x: number | null; y: number | null }>;
}

/** Step the worker logic through the recording in simulated time. Returns
 *  the captured tick stream. */
function runHeadless(rec: Recording, opts: { dt: number; settleMs: number }): SimFrame[] {
  const frames: SimFrame[] = [];
  let simT = 0;
  // Track which nodes are currently being dragged so we can capture their
  // fx/fy alongside x/y. Updated in the input-dispatch loop below.
  const draggingNow = new Set<string>();
  setForceEmitEveryTick(true);
  setEmit((msg) => {
    if (msg.type !== 'tick') return;
    const draggedFxFy: Record<string, { fx: number | null; fy: number | null; x: number | null; y: number | null }> = {};
    for (const id of draggingNow) {
      const s = inspectNode(id);
      if (s) draggedFxFy[id] = { fx: s.fx ?? null, fy: s.fy ?? null, x: s.x, y: s.y };
    }
    frames.push({
      t: simT,
      nodes: msg.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
      arrows: JSON.parse(JSON.stringify(msg.arrowAnchors)),
      draggedFxFy,
    });
  });

  // init: feed the saved initial project state.
  const proj = rec.initialProject;
  // Optionally override frozen flags via env (UNFREEZE=A,G to test
  // hypotheses about specific pinning state).
  const unfreeze = new Set((process.env.UNFREEZE ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const frozenIds = Object.values(proj.nodes).filter((n) => n.frozen).map((n) => n.id);
  if (frozenIds.length > 0) {
    console.log(`(initial project has frozen nodes: ${frozenIds.join(',')}${unfreeze.size > 0 ? ` — unfreezing ${[...unfreeze].join(',')} for this run` : ''})`);
  }
  dispatchMessage({
    type: 'init',
    nodes: Object.values(proj.nodes).map((n) => ({
      id: n.id, x: n.position.x, y: n.position.y,
      frozen: unfreeze.has(n.id) ? false : n.frozen,
    })),
    links: Object.values(proj.arrows).map((a) => ({
      source: a.fromNodeId, target: a.toNodeId,
      kind: a.kind, gravitates: !!a.gravitates,
      arrowId: a.id, anchors: a.anchors,
    })),
  });
  // Match the live system: use the recorded physics config so this is a
  // true re-simulation of what the user was running.
  dispatchMessage({ type: 'set-physics-config', config: rec.physicsConfig });
  // CRITICAL: replay the per-node renderedHeight that the live Canvas
  // sends via set-size messages. Without this the worker uses the
  // default 120 px height, but real sandbox nodes are ~248 px tall.
  // Every rect-based check (obstacle repel, re-projection, P0.2
  // pierce, corner clearance) is silently wrong until this is sent.
  const DEFAULT_W = 420;
  const DEFAULT_H = 120;
  for (const n of Object.values(proj.nodes)) {
    const ver = n.versions[n.currentVersionIndex];
    const w = ver?.width ?? DEFAULT_W;
    const h = n.renderedHeight ?? ver?.bodyMaxHeight ?? DEFAULT_H;
    if (w !== DEFAULT_W || h !== DEFAULT_H) {
      dispatchMessage({ type: 'set-size', id: n.id, width: w, height: h });
    }
  }
  stopAutoTimer();

  const inputs = rec.inputs ?? [];
  let nextInput = 0;
  const totalMs = rec.durationMs + opts.settleMs;

  while (simT <= totalMs) {
    // Deliver any inputs whose recorded timestamp has now passed.
    while (nextInput < inputs.length && inputs[nextInput]!.t <= simT) {
      const ev = inputs[nextInput]!.event;
      if (ev.type === 'drag-start') draggingNow.add(ev.id);
      else if (ev.type === 'drag-end') draggingNow.delete(ev.id);
      else if (ev.type === 'drag-end-many') for (const id of ev.ids) draggingNow.delete(id);
      dispatchMessage(toInputMessage(ev));
      nextInput++;
    }
    stopAutoTimer();   // any .alpha().restart() in dispatch starts the
                       // d3-timer; kill it so we step manually.
    tickOnce();
    simT += opts.dt;
  }

  return frames;
}

function toInputMessage(ev: Recording['inputs'] extends (infer T)[] | undefined ? T extends { event: infer E } ? E : never : never) {
  // Narrowing helper — events are 1:1 with the worker's drag-* message
  // shapes, so just pass through (worker discriminator matches input
  // discriminator).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ev as any;
}

// ----- analysis ------------------------------------------------------------

type PosLookup = Map<string, { x: number; y: number }>;

function posAt(frames: SimFrame[], t: number): PosLookup {
  // Binary-search the frame at or just before t.
  let lo = 0, hi = frames.length - 1;
  if (hi < 0) return new Map();
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.t <= t) lo = mid; else hi = mid - 1;
  }
  const f = frames[lo]!;
  const m: PosLookup = new Map();
  for (const n of f.nodes) m.set(n.id, { x: n.x, y: n.y });
  return m;
}

interface DragLagStats {
  draggedId: string;
  count: number;
  mean: number;
  max: number;
  p90: number;
}

function dragLagStats(rec: Recording, frames: SimFrame[]): DragLagStats[] {
  // For each FRAME, find the most-recent cursor target per dragged node
  // (cursor input with t <= frame.t) and compute |frame_pos - cursor|.
  // This is the right shape: B's position at frame_t should match the
  // cursor we most recently pinned it to.
  const byNode = new Map<string, { lags: number[] }>();
  const lastCursor = new Map<string, { x: number; y: number; t: number }>();
  const inputs = rec.inputs ?? [];
  let nextIn = 0;
  for (const f of frames) {
    while (nextIn < inputs.length && inputs[nextIn]!.t <= f.t) {
      const ev = inputs[nextIn]!.event;
      if (ev.type === 'drag-start' || ev.type === 'drag-move') {
        lastCursor.set(ev.id, { x: ev.x, y: ev.y, t: inputs[nextIn]!.t });
      } else if (ev.type === 'drag-end') {
        lastCursor.delete(ev.id);
      } else if (ev.type === 'drag-end-many') {
        for (const id of ev.ids) lastCursor.delete(id);
      }
      nextIn++;
    }
    for (const [id, c] of lastCursor) {
      const p = f.nodes.find((n) => n.id === id);
      if (!p) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (!byNode.has(id)) byNode.set(id, { lags: [] });
      byNode.get(id)!.lags.push(d);
    }
  }
  const out: DragLagStats[] = [];
  for (const [id, { lags }] of byNode) {
    if (lags.length === 0) continue;
    lags.sort((a, b) => a - b);
    out.push({
      draggedId: id,
      count: lags.length,
      mean: lags.reduce((s, v) => s + v, 0) / lags.length,
      max: lags[lags.length - 1]!,
      p90: lags[Math.floor(lags.length * 0.9)]!,
    });
  }
  return out;
}

function finalCursorVsNode(rec: Recording, frames: SimFrame[]): { id: string; dist: number; cursor: {x:number;y:number}; node: {x:number;y:number} }[] {
  // For each node that was dragged, find the LAST cursor position from
  // the input stream, and compare to that node's final position. After
  // settling, B should be exactly at the last cursor.
  const lastCursorById = new Map<string, { x: number; y: number }>();
  for (const inp of rec.inputs ?? []) {
    const ev = inp.event;
    if (ev.type === 'drag-move') lastCursorById.set(ev.id, { x: ev.x, y: ev.y });
  }
  const finalFrame = frames[frames.length - 1];
  const out: { id: string; dist: number; cursor: {x:number;y:number}; node: {x:number;y:number} }[] = [];
  if (!finalFrame) return out;
  for (const [id, c] of lastCursorById) {
    const p = finalFrame.nodes.find((n) => n.id === id);
    if (!p) continue;
    out.push({ id, dist: Math.hypot(p.x - c.x, p.y - c.y), cursor: c, node: { x: p.x, y: p.y } });
  }
  return out;
}

function jumpStats(frames: SimFrame[], id: string, threshold: number): { total: number; over: number; maxJump: number } {
  let prev: { x: number; y: number } | null = null;
  let over = 0, total = 0, maxJump = 0;
  for (const f of frames) {
    const p = f.nodes.find((n) => n.id === id);
    if (!p) continue;
    if (prev) {
      const d = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (d > maxJump) maxJump = d;
      if (d > threshold) over++;
      total++;
    }
    prev = { x: p.x, y: p.y };
  }
  return { total, over, maxJump };
}

function nodeDisplacement(rec: Recording, frames: SimFrame[]): { id: string; dist: number }[] {
  const initial = new Map<string, { x: number; y: number }>();
  for (const [id, n] of Object.entries(rec.initialProject.nodes)) {
    initial.set(id, { x: n.position.x, y: n.position.y });
  }
  const last = frames[frames.length - 1];
  if (!last) return [];
  const out: { id: string; dist: number }[] = [];
  for (const n of last.nodes) {
    const i = initial.get(n.id);
    if (!i) continue;
    out.push({ id: n.id, dist: Math.hypot(n.x - i.x, n.y - i.y) });
  }
  out.sort((a, b) => b.dist - a.dist);
  return out;
}

type Pt = { x: number; y: number };
function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  // Proper segment-segment intersection (excluding endpoint touches).
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return false;
  const sx = p3.x - p1.x, sy = p3.y - p1.y;
  const t = (sx * d2y - sy * d2x) / denom;
  const u = (sx * d1y - sy * d1x) / denom;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

function anchorCountStats(frames: SimFrame[]): { id: string; max: number; final: number }[] {
  const max = new Map<string, number>();
  const finalCounts = new Map<string, number>();
  for (const f of frames) {
    for (const [aid, anchors] of Object.entries(f.arrows)) {
      const n = anchors.length;
      if (!max.has(aid) || n > max.get(aid)!) max.set(aid, n);
      finalCounts.set(aid, n);
    }
  }
  return [...max.entries()]
    .map(([id, m]) => ({ id, max: m, final: finalCounts.get(id) ?? 0 }))
    .sort((a, b) => b.max - a.max);
}

// ----- vitest entry -------------------------------------------------------

// Private recordings are deliberately not distributed. This diagnostic runs
// only when a developer explicitly supplies their own local recording.
describe.skipIf(!process.env.REC)('sandbox replay', () => {
  test('headless re-simulation', { timeout: 120_000 }, () => {
    const { rec, path: recPath } = findRecording();
    const DT = 16.67;        // ~60fps virtual timestep
    const SETTLE = 2000;     // extra ms after last input for settling
    // Build the sizes map ONCE up front. Every rect-based metric uses
    // it so we measure against real-rendered ~248-tall rects, not the
    // 120 px default. Without this the harness silently underestimates
    // every clearance / piercing check.
    const sizes = rectSizesFromRecording(rec);

    console.log('\n=== Replay analysis ===');
    console.log(`Recording: ${recPath}`);
    console.log(`Duration: ${rec.durationMs.toFixed(0)}ms`);
    console.log(`Recorded frames: ${rec.frames.length}, inputs: ${rec.inputs?.length ?? 0}`);
    console.log(`Sim dt: ${DT}ms, settle: ${SETTLE}ms`);

    const t0 = Date.now();
    const simFrames = runHeadless(rec, { dt: DT, settleMs: SETTLE });
    console.log(`Sim produced ${simFrames.length} frames in ${Date.now() - t0}ms wall time`);

    // --- Drag lag (per-frame, vs latest cursor) ---
    console.log('\n--- Per-frame drag lag (|node - latest cursor while dragging|) ---');
    for (const s of dragLagStats(rec, simFrames)) {
      console.log(
        `  ${s.draggedId}: frames=${s.count}  mean=${s.mean.toFixed(1)}px  ` +
        `p90=${s.p90.toFixed(1)}px  max=${s.max.toFixed(1)}px`,
      );
    }

    // --- Final position vs last cursor ---
    console.log('\n--- Final node position vs last cursor (post-settling) ---');
    for (const f of finalCursorVsNode(rec, simFrames)) {
      console.log(
        `  ${f.id}: dist=${f.dist.toFixed(1)}px  ` +
        `final=(${f.node.x.toFixed(0)}, ${f.node.y.toFixed(0)})  ` +
        `lastCursor=(${f.cursor.x.toFixed(0)}, ${f.cursor.y.toFixed(0)})`,
      );
    }

    // --- DURING-drag pin verification ---
    // For each tick while a drag is active, compare B's reported position
    // against the most-recent drag-move target. fx/fy is supposed to be a
    // hard pin in d3-force, so |B - cursor| should be ~0 with no forces
    // able to override. If it's not zero, the drag pinning isn't working
    // the way we think.
    {
      const lastCursorById = new Map<string, { x: number; y: number }>();
      const activeDrag = new Set<string>();
      const inputsArr = rec.inputs ?? [];
      let nextIn = 0;
      let nWithin1px = 0, nWithin10px = 0, nWithin50px = 0, nTotal = 0;
      let worst: { id: string; t: number; nodePos: Pt; cursor: Pt; d: number } | null = null;
      for (const f of simFrames) {
        while (nextIn < inputsArr.length && inputsArr[nextIn]!.t <= f.t) {
          const ev = inputsArr[nextIn]!.event;
          if (ev.type === 'drag-start') {
            activeDrag.add(ev.id);
            lastCursorById.set(ev.id, { x: ev.x, y: ev.y });
          } else if (ev.type === 'drag-move') {
            lastCursorById.set(ev.id, { x: ev.x, y: ev.y });
          } else if (ev.type === 'drag-end') {
            activeDrag.delete(ev.id);
            lastCursorById.delete(ev.id);
          } else if (ev.type === 'drag-end-many') {
            for (const id of ev.ids) { activeDrag.delete(id); lastCursorById.delete(id); }
          }
          nextIn++;
        }
        for (const id of activeDrag) {
          const cursor = lastCursorById.get(id);
          if (!cursor) continue;
          const p = f.nodes.find((n) => n.id === id);
          if (!p) continue;
          const d = Math.hypot(p.x - cursor.x, p.y - cursor.y);
          nTotal++;
          if (d < 1) nWithin1px++;
          if (d < 10) nWithin10px++;
          if (d < 50) nWithin50px++;
          if (!worst || d > worst.d) worst = { id, t: f.t, nodePos: { x: p.x, y: p.y }, cursor: { x: cursor.x, y: cursor.y }, d };
        }
      }
      console.log('\n--- DURING-drag pin verification (B should equal cursor) ---');
      console.log(`  ticks with drag active: ${nTotal}`);
      console.log(`  within 1px:  ${nWithin1px} (${(100*nWithin1px/nTotal).toFixed(1)}%)`);
      console.log(`  within 10px: ${nWithin10px} (${(100*nWithin10px/nTotal).toFixed(1)}%)`);
      console.log(`  within 50px: ${nWithin50px} (${(100*nWithin50px/nTotal).toFixed(1)}%)`);
      if (worst) {
        // Find the matching frame to also dump fx/fy
        const worstFrame = simFrames.find((f) => f.t === worst!.t);
        const fxFy = worstFrame?.draggedFxFy?.[worst.id];
        console.log(
          `  worst: ${worst.id} at t=${worst.t.toFixed(0)}ms  ` +
          `d=${worst.d.toFixed(1)}px  ` +
          `node=(${worst.nodePos.x.toFixed(1)}, ${worst.nodePos.y.toFixed(1)})  ` +
          `cursor=(${worst.cursor.x.toFixed(1)}, ${worst.cursor.y.toFixed(1)})`,
        );
        if (fxFy) {
          console.log(
            `         fx=${fxFy.fx?.toFixed(1)}  fy=${fxFy.fy?.toFixed(1)}  ` +
            `inspect.x=${fxFy.x?.toFixed(1)}  inspect.y=${fxFy.y?.toFixed(1)}`,
          );
        }
      }
    }

    // --- B-jump distribution (compare against recorded if B was dragged) ---
    const draggedIds = new Set<string>();
    for (const inp of rec.inputs ?? []) {
      if (inp.event.type === 'drag-move') draggedIds.add(inp.event.id);
    }
    console.log('\n--- Per-tick position jumps for dragged nodes ---');
    for (const id of draggedIds) {
      const j = jumpStats(simFrames, id, 30);
      console.log(`  ${id}: maxJump=${j.maxJump.toFixed(1)}px  ticks>30px: ${j.over}/${j.total}`);
    }

    // --- Final node displacement (did B push others?) ---
    console.log('\n--- Final displacement from initial (top 10) ---');
    for (const d of nodeDisplacement(rec, simFrames).slice(0, 10)) {
      console.log(`  ${d.id}: ${d.dist.toFixed(1)}px`);
    }

    // --- Anchor counts (rope tangling proxy) ---
    console.log('\n--- Max anchor count per arrow (top 10) ---');
    for (const a of anchorCountStats(simFrames).slice(0, 10)) {
      console.log(`  ${a.id}: max=${a.max}  final=${a.final}`);
    }

    // --- Path-length sanity for the worst-tangle arrow ---
    // For the arrow that hits the highest anchor count, find the frame
    // where it peaks and compute total polyline length / straight-line
    // distance. Ratio >> 1.5 implies the chain is winding back on itself.
    const worstAnchor = anchorCountStats(simFrames)[0];
    if (worstAnchor) {
      let peakFrame: SimFrame | null = null;
      let peakLen = 0;
      for (const f of simFrames) {
        const a = f.arrows[worstAnchor.id];
        if (!a) continue;
        if (a.length > peakLen) { peakLen = a.length; peakFrame = f; }
      }
      if (peakFrame) {
        const anchors = peakFrame.arrows[worstAnchor.id]!;
        let polyLen = 0;
        for (let i = 1; i < anchors.length; i++) {
          polyLen += Math.hypot(anchors[i]!.x - anchors[i - 1]!.x, anchors[i]!.y - anchors[i - 1]!.y);
        }
        const straightLen = Math.hypot(
          anchors[anchors.length - 1]!.x - anchors[0]!.x,
          anchors[anchors.length - 1]!.y - anchors[0]!.y,
        );
        console.log(
          `\n--- Worst tangle: ${worstAnchor.id} at frame t=${peakFrame.t.toFixed(0)}ms ---\n` +
          `  anchors=${anchors.length}  polylineLen=${polyLen.toFixed(0)}px  ` +
          `straightLen=${straightLen.toFixed(0)}px  ratio=${(polyLen / Math.max(straightLen, 1)).toFixed(2)}`,
        );
        // Show first/last few anchors so we can spot foldbacks
        const dump = (idx: number) => {
          const p = anchors[idx]!;
          return `[${idx}] (${p.x.toFixed(0)},${p.y.toFixed(0)})`;
        };
        console.log(`  endpoints: ${dump(0)} ... ${dump(anchors.length - 1)}`);
        // Check for foldbacks: angle changes between consecutive segments
        let foldbacks = 0;
        for (let i = 1; i < anchors.length - 1; i++) {
          const a = anchors[i - 1]!, b = anchors[i]!, c = anchors[i + 1]!;
          const v1x = b.x - a.x, v1y = b.y - a.y;
          const v2x = c.x - b.x, v2y = c.y - b.y;
          const dot = v1x * v2x + v1y * v2y;
          const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
          if (m1 === 0 || m2 === 0) continue;
          const cos = dot / (m1 * m2);
          if (cos < -0.5) foldbacks++; // angle > 120° = sharp reversal
        }
        console.log(`  sharp-reversal segments (>120°): ${foldbacks} / ${anchors.length - 2}`);
      }
    }

    // --- Node-vs-node overlap (rectCollide should prevent this) ---
    // Walks every frame, finds pairs of nodes whose rects overlap. For
    // each offending pair, records peak overlap area + when it happened.
    {
      type OverlapStat = { pair: string; peakArea: number; peakT: number; framesOverlap: number; finalOverlap: number };
      const stats = new Map<string, OverlapStat>();
      const sz = (id: string) => sizes.get(id) ?? { w: 420, h: 120 };
      for (const f of simFrames) {
        for (let i = 0; i < f.nodes.length; i++) {
          const a = f.nodes[i]!;
          const aS = sz(a.id);
          for (let j = i + 1; j < f.nodes.length; j++) {
            const b = f.nodes[j]!;
            const bS = sz(b.id);
            const oX = Math.min(a.x + aS.w, b.x + bS.w) - Math.max(a.x, b.x);
            const oY = Math.min(a.y + aS.h, b.y + bS.h) - Math.max(a.y, b.y);
            if (oX <= 0 || oY <= 0) continue;
            const area = oX * oY;
            const key = a.id < b.id ? `${a.id}↔${b.id}` : `${b.id}↔${a.id}`;
            const cur = stats.get(key);
            if (!cur) {
              stats.set(key, { pair: key, peakArea: area, peakT: f.t, framesOverlap: 1, finalOverlap: area });
            } else {
              cur.framesOverlap++;
              cur.finalOverlap = area;
              if (area > cur.peakArea) { cur.peakArea = area; cur.peakT = f.t; }
            }
          }
        }
      }
      const list = [...stats.values()].sort((a, b) => b.peakArea - a.peakArea);
      console.log('\n--- Node-vs-node overlap (should be empty — rectCollide should resolve) ---');
      if (list.length === 0) console.log('  (no overlaps)');
      else for (const s of list.slice(0, 10)) {
        console.log(
          `  ${s.pair}: peak ${s.peakArea.toFixed(0)}px² at t=${s.peakT.toFixed(0)}ms  ` +
          `frames=${s.framesOverlap}  final=${s.finalOverlap.toFixed(0)}px²`,
        );
      }
      // For the top offending pair, dump positions of BOTH nodes around the peak
      // so we can see how they got into the overlapping configuration.
      if (list.length > 0 && process.env.DUMP_OVERLAP) {
        const [a, b] = list[0]!.pair.split('↔');
        const peakT = list[0]!.peakT;
        console.log(`\n--- ${a} & ${b} positions around peak (t=${peakT}) ---`);
        const aS = sz(a!);
        const bS = sz(b!);
        for (const f of simFrames) {
          if (f.t < peakT - 400 || f.t > peakT + 200) continue;
          const aP = f.nodes.find((n) => n.id === a);
          const bP = f.nodes.find((n) => n.id === b);
          if (!aP || !bP) continue;
          const oX = Math.min(aP.x + aS.w, bP.x + bS.w) - Math.max(aP.x, bP.x);
          const oY = Math.min(aP.y + aS.h, bP.y + bS.h) - Math.max(aP.y, bP.y);
          console.log(`  t=${f.t.toFixed(0)}  ${a}=(${aP.x.toFixed(0)},${aP.y.toFixed(0)})  ${b}=(${bP.x.toFixed(0)},${bP.y.toFixed(0)})  oX=${oX.toFixed(0)} oY=${oY.toFixed(0)}`);
        }
      }
    }

    // --- Self-foldback scan: count frames per arrow where chain has sharp reversal ---
    console.log('\n--- Self-foldback frames per arrow (segments with >120° reversal) ---');
    const foldbackFrames: Record<string, { framesWithFold: number; maxFolds: number }> = {};
    for (const f of simFrames) {
      for (const [aid, anchors] of Object.entries(f.arrows)) {
        if (anchors.length < 3) continue;
        let folds = 0;
        for (let i = 1; i < anchors.length - 1; i++) {
          const a = anchors[i - 1]!, b = anchors[i]!, c = anchors[i + 1]!;
          const v1x = b.x - a.x, v1y = b.y - a.y;
          const v2x = c.x - b.x, v2y = c.y - b.y;
          const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
          if (m1 === 0 || m2 === 0) continue;
          const cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
          if (cos < -0.5) folds++;
        }
        if (folds > 0) {
          if (!foldbackFrames[aid]) foldbackFrames[aid] = { framesWithFold: 0, maxFolds: 0 };
          foldbackFrames[aid]!.framesWithFold++;
          if (folds > foldbackFrames[aid]!.maxFolds) foldbackFrames[aid]!.maxFolds = folds;
        }
      }
    }
    const foldEntries = Object.entries(foldbackFrames).sort((a, b) => b[1].framesWithFold - a[1].framesWithFold);
    if (foldEntries.length === 0) console.log('  (no self-foldbacks detected)');
    else for (const [aid, s] of foldEntries.slice(0, 10)) {
      console.log(`  ${aid}: ${s.framesWithFold} frames with foldback, max ${s.maxFolds} folds in one frame`);
    }

    // --- Rope-vs-rope crossings (segment intersection count, peak frame) ---
    console.log('\n--- Rope-vs-rope crossings (peak count) ---');
    let peakCrossT = 0, peakCrossCount = 0;
    let peakCrossDetail: string[] = [];
    for (const f of simFrames) {
      const arrows = Object.entries(f.arrows).filter(([, a]) => a.length >= 2);
      let count = 0;
      const detail: Record<string, number> = {};
      for (let i = 0; i < arrows.length; i++) {
        for (let j = i + 1; j < arrows.length; j++) {
          const [aId, aPts] = arrows[i]!;
          const [bId, bPts] = arrows[j]!;
          for (let p = 0; p < aPts.length - 1; p++) {
            for (let q = 0; q < bPts.length - 1; q++) {
              if (segIntersect(aPts[p]!, aPts[p + 1]!, bPts[q]!, bPts[q + 1]!)) {
                count++;
                const k = `${aId}↔${bId}`;
                detail[k] = (detail[k] ?? 0) + 1;
              }
            }
          }
        }
      }
      if (count > peakCrossCount) {
        peakCrossCount = count;
        peakCrossT = f.t;
        peakCrossDetail = Object.entries(detail).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}: ${v}`);
      }
    }
    console.log(`  peak crossings: ${peakCrossCount} at t=${peakCrossT.toFixed(0)}ms`);
    for (const d of peakCrossDetail) console.log(`    ${d}`);

    // --- Worst-frame piercings (scans every frame) ---
    {
      type PierceRecord = { arrowId: string; nodeId: string; frameIdx: number; depth: number; t: number };
      const worstPerArrow = new Map<string, PierceRecord>();
      for (let fi = 0; fi < simFrames.length; fi++) {
        const f = simFrames[fi]!;
        const fmt = { t: f.t, nodes: f.nodes, arrows: f.arrows };
        const pierces = interiorPiercings(fmt, rec, sizes);
        for (const p of pierces) {
          const cur = worstPerArrow.get(p.arrowId);
          if (!cur || p.depth > cur.depth) {
            worstPerArrow.set(p.arrowId, { arrowId: p.arrowId, nodeId: p.nodeId, frameIdx: fi, depth: p.depth, t: f.t });
          }
        }
      }
      console.log('\n--- Worst-frame interior piercings (scans every frame) ---');
      if (worstPerArrow.size === 0) console.log('  (no piercings detected in any frame)');
      else {
        const list = [...worstPerArrow.values()].sort((a, b) => b.depth - a.depth);
        for (const p of list.slice(0, 8)) {
          console.log(`  ${p.arrowId} → ${p.nodeId}: peak depth ${p.depth.toFixed(1)}px at t=${p.t.toFixed(0)}ms`);
        }
      }
    }

    // --- Rope-quality scorecard against rope-spec.md (final frame) ---
    {
      const final = simFrames[simFrames.length - 1];
      if (final) {
        const fmtFrame = { t: final.t, nodes: final.nodes, arrows: final.arrows };
        console.log('\n=== Rope-quality scorecard (final/settled frame) ===');

        // P0.1
        const att = endpointAttachment(fmtFrame, rec, sizes);
        const worstAtt = att[0];
        const allAttOk = att.every((a) => a.srcGap < 1 && a.tgtGap < 1);
        console.log(`P0.1 endpoint attachment: ${allAttOk ? 'PASS' : 'FAIL'}` +
          (worstAtt ? `  (worst ${worstAtt.arrowId}: srcGap=${worstAtt.srcGap.toFixed(1)}px tgtGap=${worstAtt.tgtGap.toFixed(1)}px)` : ''));

        // P0.2
        const pierce = interiorPiercings(fmtFrame, rec, sizes);
        console.log(`P0.2 no interior piercing: ${pierce.length === 0 ? 'PASS' : 'FAIL (' + pierce.length + ' violations)'}`);
        for (const v of pierce.slice(0, 5)) {
          console.log(`  ${v.arrowId} seg ${v.segmentIdx} pierces ${v.nodeId}, depth=${v.depth.toFixed(1)}px`);
        }

        // P0.4
        const stack = endpointStacking(fmtFrame);
        const worstStack = stack[0];
        const stackOk = stack.every((s) => s.minDist >= 10);
        console.log(`P0.4 no endpoint stacking: ${stackOk ? 'PASS' : 'FAIL'}` +
          (worstStack ? `  (worst on ${worstStack.nodeId}: ${worstStack.minDist.toFixed(1)}px between ${worstStack.pair[0]} and ${worstStack.pair[1]})` : ''));

        // P1.4 (refined)
        const cross = ropeCrossings(fmtFrame);
        console.log(`P1.4 non-shared-endpoint crossings: ${cross.nonShared === 0 ? 'PASS' : 'FAIL (' + cross.nonShared + ' crossings)'}` +
          `  [shared-endpoint crossings: ${cross.sharedEndpoint}]`);
        const nonSharedPairs = [...cross.byPair.entries()].filter(([, v]) => !v.shared).sort((a, b) => b[1].count - a[1].count);
        for (const [pair, info] of nonSharedPairs.slice(0, 5)) {
          console.log(`  ${pair}: ${info.count} crossings`);
        }

        // SHAKE METRIC: for each arrow, score how much of the
        // per-tick motion is back-and-forth oscillation vs net drift.
        //
        //   shake = 1 - |net displacement| / |total motion|
        //
        //   - net = sum of all per-tick delta vectors (geometric end
        //     position minus start position, magnitude)
        //   - total = sum of per-tick |delta| magnitudes
        //   - shake ∈ [0, 1]: 0 = pure smooth drift, 1 = perfect
        //     back-and-forth (returns to start). A node smoothly
        //     dragged from A to B has shake ≈ 0; a chain anchor
        //     oscillating in place has shake ≈ 1.
        //
        // Reported alongside the per-arrow average anchor motion so we
        // can distinguish "moving smoothly because endpoint dragged"
        // (low shake) from "wiggling in a tight squeeze" (high shake).
        {
          interface ShakeStat { id: string; shake: number; totalMotion: number; netDisplacement: number }
          const stats: ShakeStat[] = [];
          for (const aid of Object.keys(simFrames[0]?.arrows ?? {})) {
            // For each anchor index in this chain, accumulate motion.
            let bestAnchorShake = 0;
            let bestTotal = 0;
            let bestNet = 0;
            // Find consistent anchor count across frames (skip if topology changes).
            const stableLength = simFrames.every((f) => (f.arrows[aid]?.length ?? 0) === (simFrames[0]?.arrows[aid]?.length ?? 0))
              ? simFrames[0]!.arrows[aid]!.length : 0;
            if (stableLength === 0) continue;
            for (let ai = 0; ai < stableLength; ai++) {
              let totalMotion = 0;
              let netX = 0, netY = 0;
              for (let f = 1; f < simFrames.length; f++) {
                const prev = simFrames[f - 1]!.arrows[aid]?.[ai];
                const cur = simFrames[f]!.arrows[aid]?.[ai];
                if (!prev || !cur) continue;
                const dx = cur.x - prev.x, dy = cur.y - prev.y;
                const d = Math.hypot(dx, dy);
                totalMotion += d;
                netX += dx;
                netY += dy;
              }
              const net = Math.hypot(netX, netY);
              if (totalMotion < 1) continue; // anchor didn't move; skip
              const shake = 1 - (net / totalMotion);
              if (shake * totalMotion > bestAnchorShake * bestTotal) {
                bestAnchorShake = shake; bestTotal = totalMotion; bestNet = net;
              }
            }
            if (bestTotal > 0) stats.push({ id: aid, shake: bestAnchorShake, totalMotion: bestTotal, netDisplacement: bestNet });
          }
          stats.sort((a, b) => (b.shake * b.totalMotion) - (a.shake * a.totalMotion));
          console.log('\n--- Shake metric (worst-anchor per arrow; high shake × high motion = visible wobble) ---');
          for (const s of stats.slice(0, 10)) {
            const badge = s.shake > 0.7 && s.totalMotion > 50 ? '  ⚠️' : '';
            console.log(`  ${s.id}: shake=${s.shake.toFixed(2)}  totalMotion=${s.totalMotion.toFixed(0)}px  netDisplacement=${s.netDisplacement.toFixed(0)}px${badge}`);
          }
        }

        // P1.3 Frame-to-frame stability: per-arrow average max anchor
        // displacement between consecutive frames. A "stable" rope has
        // small per-tick deltas. A rope whose A* topology flips between
        // ticks has large deltas spikes.
        {
          const perArrowMaxDeltas: Record<string, number[]> = {};
          for (let f = 1; f < simFrames.length; f++) {
            const prev = simFrames[f - 1]!;
            const cur = simFrames[f]!;
            for (const aid of Object.keys(cur.arrows)) {
              const pAnchors = prev.arrows[aid];
              const cAnchors = cur.arrows[aid];
              if (!pAnchors || !cAnchors) continue;
              // Compare by index (chain length may vary; pad shorter side).
              const n = Math.min(pAnchors.length, cAnchors.length);
              let maxD = 0;
              for (let i = 0; i < n; i++) {
                const d = Math.hypot(cAnchors[i]!.x - pAnchors[i]!.x, cAnchors[i]!.y - pAnchors[i]!.y);
                if (d > maxD) maxD = d;
              }
              if (Math.abs(pAnchors.length - cAnchors.length) > 0) {
                // Length changed — strong signal of topology flip
                maxD = Math.max(maxD, 100);
              }
              if (!perArrowMaxDeltas[aid]) perArrowMaxDeltas[aid] = [];
              perArrowMaxDeltas[aid]!.push(maxD);
            }
          }
          const stats: { id: string; mean: number; max: number; p90: number }[] = [];
          for (const [id, deltas] of Object.entries(perArrowMaxDeltas)) {
            if (deltas.length === 0) continue;
            deltas.sort((a, b) => a - b);
            const mean = deltas.reduce((s, v) => s + v, 0) / deltas.length;
            stats.push({
              id,
              mean,
              max: deltas[deltas.length - 1]!,
              p90: deltas[Math.floor(deltas.length * 0.9)]!,
            });
          }
          stats.sort((a, b) => b.mean - a.mean);
          console.log('\n--- Per-tick anchor stability (max-anchor-delta between consecutive frames) ---');
          for (const s of stats.slice(0, 10)) {
            console.log(`  ${s.id}: mean=${s.mean.toFixed(1)}px  p90=${s.p90.toFixed(1)}px  max=${s.max.toFixed(1)}px`);
          }
        }

        // TRACE one anchor over time to diagnose shake.
        // Set TRACE=arrow_F_T:5 to dump anchor 5 of arrow_F_T per tick.
        if (process.env.TRACE) {
          const [aid, idxStr] = process.env.TRACE.split(':');
          const idx = parseInt(idxStr ?? '0', 10);
          console.log(`\n--- Trace ${aid}[${idx}] over time ---`);
          let prevX = 0, prevY = 0, prevDx = 0, prevDy = 0;
          let revCount = 0, totalMoves = 0;
          for (let i = 0; i < simFrames.length; i++) {
            const f = simFrames[i]!;
            const a = f.arrows[aid!]?.[idx];
            if (!a) continue;
            const dx = i > 0 ? a.x - prevX : 0;
            const dy = i > 0 ? a.y - prevY : 0;
            const mag = Math.hypot(dx, dy);
            const dot = i > 1 ? dx * prevDx + dy * prevDy : 0;
            const reversed = i > 1 && mag > 0.3 && Math.hypot(prevDx, prevDy) > 0.3 && dot < 0;
            if (i > 1 && mag > 0.3 && Math.hypot(prevDx, prevDy) > 0.3) {
              if (reversed) revCount++;
              totalMoves++;
            }
            if (mag > 0.3 || i % 30 === 0) {
              console.log(`  t=${f.t.toFixed(0)}ms  pos=(${a.x.toFixed(1)},${a.y.toFixed(1)})  delta=(${dx.toFixed(2)},${dy.toFixed(2)})${reversed ? ' ← REVERSED' : ''}`);
            }
            prevX = a.x; prevY = a.y;
            if (mag > 0.3) { prevDx = dx; prevDy = dy; }
          }
          console.log(`  Reversals: ${revCount}/${totalMoves} (${(100 * revCount / Math.max(1, totalMoves)).toFixed(0)}%)`);
        }

        // Detailed dump for user-flagged ropes
        if (process.env.DUMP_ROPES) {
          const ids = process.env.DUMP_ROPES.split(',').map((s) => s.trim());
          for (const aid of ids) {
            const anchors = fmtFrame.arrows[aid];
            if (!anchors) { console.log(`(no rope ${aid})`); continue; }
            console.log(`\n--- ${aid} polyline (${anchors.length} anchors) ---`);
            for (let i = 0; i < anchors.length; i++) {
              const a = anchors[i]!;
              console.log(`  [${i}] (${a.x.toFixed(0)}, ${a.y.toFixed(0)})`);
            }
          }
        }

        // NEW: corner clearance + edge parallelism
        const corner = cornerClearance(fmtFrame, rec, sizes);
        const inconsistentArrows = corner.perArrow.filter((a) => a.inconsistent.length > 0);
        const nonParallelArrows = corner.perArrow.filter((a) => a.nonParallel.length > 0);
        console.log(`Corner clearance consistency (target margin=${ROPE_MARGIN}px): ` +
          `${inconsistentArrows.length === 0 ? 'PASS' : 'FAIL (' + inconsistentArrows.length + ' arrows inconsistent)'}`);
        for (const a of inconsistentArrows.slice(0, 5)) {
          for (const inc of a.inconsistent.slice(0, 3)) {
            console.log(`  ${a.arrowId} rounding ${inc.nodeId}: gaps=[${inc.gaps.map((g) => g.toFixed(0)).join(',')}]px  std=${inc.std.toFixed(1)}`);
          }
        }
        console.log(`Edge-parallel runs (tilt ≤ 5°): ` +
          `${nonParallelArrows.length === 0 ? 'PASS' : 'FAIL (' + nonParallelArrows.length + ' arrows have non-parallel rounding segments)'}`);
        for (const a of nonParallelArrows.slice(0, 5)) {
          for (const np of a.nonParallel.slice(0, 3)) {
            console.log(`  ${a.arrowId} near ${np.nodeId} seg ${np.segmentIdx}: tilt=${np.tiltDeg.toFixed(1)}°  len=${np.lengthPx.toFixed(0)}px`);
          }
        }
      }
    }

    // --- Compare against recorded final state (drift check) ---
    const recordedFinal = rec.frames[rec.frames.length - 1];
    const simFinal = simFrames[simFrames.length - 1];
    if (recordedFinal && simFinal) {
      const recPos = new Map(recordedFinal.nodes.map((n) => [n.id, n]));
      const drifts: { id: string; d: number }[] = [];
      for (const n of simFinal.nodes) {
        const r = recPos.get(n.id);
        if (!r) continue;
        drifts.push({ id: n.id, d: Math.hypot(n.x - r.x, n.y - r.y) });
      }
      drifts.sort((a, b) => b.d - a.d);
      console.log('\n--- Sim-vs-recorded final position drift (top 10) ---');
      for (const d of drifts.slice(0, 10)) {
        console.log(`  ${d.id}: ${d.d.toFixed(1)}px`);
      }
    }
    console.log('\n=== End ===\n');
  });
});
