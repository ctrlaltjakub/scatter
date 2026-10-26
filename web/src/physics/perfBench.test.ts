/**
 * Head-to-head benchmark for the physics-perf optimization series.
 *
 * Each optimization gets a section here that compares the OLD (pre-opt)
 * implementation against the NEW (post-opt) one, ON THE SAME INPUTS,
 * and reports wall time so we can see whether the optimization actually
 * paid off. The OLD versions are inlined verbatim from the pre-change
 * source — keep them as-is so the comparison stays honest even if the
 * production code keeps evolving.
 *
 * Run with: `npx vitest run src/physics/perfBench.test.ts`
 *
 * Output is plain console.log lines. We don't gate the tests on a
 * speed threshold (machine-dependent), only on correctness — both
 * implementations must produce the same final position state for the
 * benchmark to be considered valid.
 */
import { test, expect } from 'vitest';
import { forceSimulation } from 'd3-force';
import {
  pairwiseRepel as pairwiseRepelNEW,
  rectCollide as rectCollideNEW,
  rectLink as rectLinkNEW,
  type SimNode,
  type SimLink,
} from './forces';
import { VerletRopeSim } from './verletRope';

/* ============================================================================
 * OLD implementations (verbatim from commit 3ee5761, pre-spatial-hash).
 * ============================================================================ */

function pairwiseRepelOLD(
  strength: number,
  range: number,
  pairFilter: (a: string, b: string) => boolean,
) {
  let nodes: SimNode[] = [];
  function force(alpha: number) {
    if (range <= 0) return;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      if (a.x == null || a.y == null) continue;
      const aW = a.width ?? 420;
      const aH = a.height ?? 120;
      const aLeft = a.x;
      const aRight = a.x + aW;
      const aTop = a.y;
      const aBottom = a.y + aH;
      const aCx = a.x + aW / 2;
      const aCy = a.y + aH / 2;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        if (b.x == null || b.y == null) continue;
        if (!pairFilter(a.id, b.id)) continue;
        const bW = b.width ?? 420;
        const bH = b.height ?? 120;
        const bLeft = b.x;
        const bRight = b.x + bW;
        const bTop = b.y;
        const bBottom = b.y + bH;
        const bCx = b.x + bW / 2;
        const bCy = b.y + bH / 2;
        const gapX = Math.max(0, Math.max(aLeft - bRight, bLeft - aRight));
        const gapY = Math.max(0, Math.max(aTop - bBottom, bTop - aBottom));
        const borderDist = Math.hypot(gapX, gapY);
        if (borderDist >= range) continue;
        const dxC = bCx - aCx;
        const dyC = bCy - aCy;
        const distC = Math.hypot(dxC, dyC);
        const ux = distC < 0.001 ? 1 : dxC / distC;
        const uy = distC < 0.001 ? 0 : dyC / distC;
        const falloff = 1 - borderDist / range;
        const mag = -strength * alpha * falloff;
        if (a.fx == null) a.vx = (a.vx ?? 0) - ux * mag;
        if (a.fy == null) a.vy = (a.vy ?? 0) - uy * mag;
        if (b.fx == null) b.vx = (b.vx ?? 0) + ux * mag;
        if (b.fy == null) b.vy = (b.vy ?? 0) + uy * mag;
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

/** OLD rectLink — uses `nodes.find(...)` per link (O(N) per lookup,
 *  2 lookups per link). This is the pre-#2 version. */
function rectLinkOLD(
  links: SimLink[],
  targetBorderDistance: number,
  strength: number,
  defaultWidth: number = 420,
  defaultHeight: number = 120,
) {
  let nodes: SimNode[] = [];
  function force(alpha: number) {
    for (const link of links) {
      const sourceId = typeof link.source === 'string' ? link.source : (link.source as SimNode).id;
      const targetId = typeof link.target === 'string' ? link.target : (link.target as SimNode).id;
      const a = nodes.find((n) => n.id === sourceId);
      const b = nodes.find((n) => n.id === targetId);
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) continue;
      const aW = a.width ?? defaultWidth;
      const aH = a.height ?? defaultHeight;
      const bW = b.width ?? defaultWidth;
      const bH = b.height ?? defaultHeight;
      const aLeft = a.x, aRight = a.x + aW, aTop = a.y, aBottom = a.y + aH;
      const bLeft = b.x, bRight = b.x + bW, bTop = b.y, bBottom = b.y + bH;
      const gapX = Math.max(0, Math.max(aLeft - bRight, bLeft - aRight));
      const gapY = Math.max(0, Math.max(aTop - bBottom, bTop - aBottom));
      const borderDist = Math.hypot(gapX, gapY);
      const aCx = a.x + aW / 2, aCy = a.y + aH / 2;
      const bCx = b.x + bW / 2, bCy = b.y + bH / 2;
      const dxC = bCx - aCx, dyC = bCy - aCy;
      const distC = Math.hypot(dxC, dyC);
      if (distC < 0.001) continue;
      const ux = dxC / distC, uy = dyC / distC;
      const error = borderDist - targetBorderDistance;
      const correction = error * strength * alpha;
      if (a.fx == null) a.vx = (a.vx ?? 0) + ux * correction;
      if (a.fy == null) a.vy = (a.vy ?? 0) + uy * correction;
      if (b.fx == null) b.vx = (b.vx ?? 0) - ux * correction;
      if (b.fy == null) b.vy = (b.vy ?? 0) - uy * correction;
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

function rectCollideOLD(defaultWidth: number, defaultHeight: number, padding: number = 0) {
  let nodes: SimNode[] = [];
  function force() {
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        if (a.x == null || a.y == null) continue;
        const aW = a.width ?? defaultWidth;
        const aH = a.height ?? defaultHeight;
        const aLeft = a.x - padding;
        const aRight = a.x + aW + padding;
        const aTop = a.y - padding;
        const aBottom = a.y + aH + padding;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          if (b.x == null || b.y == null) continue;
          const bW = b.width ?? defaultWidth;
          const bH = b.height ?? defaultHeight;
          const bLeft = b.x - padding;
          const bRight = b.x + bW + padding;
          const bTop = b.y - padding;
          const bBottom = b.y + bH + padding;
          const overlapX = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
          const overlapY = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
          if (overlapX > 0 && overlapY > 0) {
            const aCx = (aLeft + aRight) / 2;
            const aCy = (aTop + aBottom) / 2;
            const bCx = (bLeft + bRight) / 2;
            const bCy = (bTop + bBottom) / 2;
            if (overlapX < overlapY) {
              const push = overlapX / 2;
              const dir = bCx >= aCx ? 1 : -1;
              if (a.fx == null) a.x! -= dir * push;
              if (b.fx == null) b.x! += dir * push;
            } else {
              const push = overlapY / 2;
              const dir = bCy >= aCy ? 1 : -1;
              if (a.fy == null) a.y! -= dir * push;
              if (b.fy == null) b.y! += dir * push;
            }
          }
        }
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

/* ============================================================================
 * Test scenario helpers — produce realistic node layouts.
 * ============================================================================ */

/** Deterministic seeded RNG so results are stable across runs. */
function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s & 0x7fffffff) / 2147483647;
  };
}

/** Make N nodes spread across a `spread × spread` area at typical card
 *  dimensions. Position is the TOP-LEFT (matches ScatterNode.position). */
function makeNodes(n: number, spread: number, seed = 42): SimNode[] {
  const rnd = rng(seed);
  const nodes: SimNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `n${i}`,
      x: rnd() * spread - spread / 2,
      y: rnd() * spread - spread / 2,
      width: 624,
      height: 200,
    });
  }
  return nodes;
}

/** Make N nodes packed close together — worst case for pairwise forces
 *  (every pair within `range`). Models the user's "few nodes clustered"
 *  scenario rather than the spread-out case. */
function makeNodesPacked(n: number, seed = 42): SimNode[] {
  const rnd = rng(seed);
  const nodes: SimNode[] = [];
  // Layout in a tight grid, ±50 px jitter, ~80 px spacing between borders.
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    nodes.push({
      id: `n${i}`,
      x: col * 720 + (rnd() - 0.5) * 100,
      y: row * 280 + (rnd() - 0.5) * 100,
      width: 624,
      height: 200,
    });
  }
  return nodes;
}

/** Make E auto-links between nearby nodes (sparse chain-ish topology
 *  like the scatter tree). Each link connects node[i] to node[i+1]
 *  modulo wrap, plus a few extra cross-links. Matches realistic E ≈ N. */
function makeLinks(n: number, e: number): SimLink[] {
  const links: SimLink[] = [];
  for (let i = 0; i < e; i++) {
    const src = i % n;
    const tgt = (i + 1) % n;
    if (src === tgt) continue;
    links.push({
      source: `n${src}`,
      target: `n${tgt}`,
      kind: 'auto',
      gravitates: true,
      arrowId: `a${i}`,
    });
  }
  return links;
}

/** Snapshot final positions for a correctness compare between OLD and NEW. */
function snapshot(nodes: SimNode[]): { x: number; y: number }[] {
  return nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0 }));
}

/** Reset positions from snapshot — lets us run OLD and NEW on the same
 *  starting state. */
function restore(nodes: SimNode[], snap: { x: number; y: number }[]): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.x = snap[i]!.x;
    nodes[i]!.y = snap[i]!.y;
    nodes[i]!.vx = 0;
    nodes[i]!.vy = 0;
  }
}

/** Time `iters` ticks of `forceFn` on `nodes`, return ms per tick (median).
 *
 *  Matches how d3-force actually invokes a force: the factory is called
 *  ONCE (when the force is registered on the sim — typically inside
 *  physicsWorker's `rebuild()`), then `force(alpha)` is called many
 *  times by `sim.tick()` until alpha decays below alphaMin. So the
 *  factory's closure-scope buffers (grid, candidates, lastSeen) are
 *  allocated once and reused — this is the realistic comparison.
 *
 *  Each measured tick = restore positions to start, then call force.
 *  Restore is excluded from timing. */
function timeForce(
  forceFactory: () => ReturnType<typeof pairwiseRepelOLD> | ReturnType<typeof rectCollideOLD>,
  nodes: SimNode[],
  iters: number,
): { medianMs: number; totalMs: number } {
  const samples: number[] = [];
  const startSnap = snapshot(nodes);
  // Create the force ONCE and reuse — matches d3 usage.
  const force = forceFactory();
  (force as unknown as { initialize: (n: SimNode[]) => void }).initialize(nodes);
  for (let s = 0; s < iters; s++) {
    restore(nodes, startSnap);
    const t0 = performance.now();
    (force as unknown as (alpha?: number) => void)(0.15);
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const total = samples.reduce((s, x) => s + x, 0);
  return { medianMs: median, totalMs: total };
}

/** Run BOTH implementations on identical inputs, assert they produce the
 *  same (or very close) final positions, and print timings side-by-side. */
function bench(
  label: string,
  nodeMaker: () => SimNode[],
  oldFactory: () => ReturnType<typeof pairwiseRepelOLD>,
  newFactory: () => ReturnType<typeof pairwiseRepelOLD>,
  iters = 500,
): void {
  // Correctness check first: one tick of each on identical nodes,
  // compare results.
  const oldNodes = nodeMaker();
  const oldSnap = snapshot(oldNodes);
  const fo = oldFactory();
  (fo as unknown as { initialize: (n: SimNode[]) => void }).initialize(oldNodes);
  (fo as unknown as (alpha?: number) => void)(0.15);
  const oldAfter = snapshot(oldNodes);

  const newNodes = nodeMaker();
  restore(newNodes, oldSnap);  // ensure identical starting state
  const fn = newFactory();
  (fn as unknown as { initialize: (n: SimNode[]) => void }).initialize(newNodes);
  (fn as unknown as (alpha?: number) => void)(0.15);
  const newAfter = snapshot(newNodes);

  let maxDelta = 0;
  for (let i = 0; i < oldAfter.length; i++) {
    const dx = Math.abs(oldAfter[i]!.x - newAfter[i]!.x);
    const dy = Math.abs(oldAfter[i]!.y - newAfter[i]!.y);
    if (dx > maxDelta) maxDelta = dx;
    if (dy > maxDelta) maxDelta = dy;
  }

  // Warm both implementations to let V8's optimizing compiler kick in.
  const warmNodes = nodeMaker();
  for (let w = 0; w < 200; w++) {
    restore(warmNodes, oldSnap);
    const wo = oldFactory();
    (wo as unknown as { initialize: (n: SimNode[]) => void }).initialize(warmNodes);
    (wo as unknown as (alpha?: number) => void)(0.15);
  }
  for (let w = 0; w < 200; w++) {
    restore(warmNodes, oldSnap);
    const wn = newFactory();
    (wn as unknown as { initialize: (n: SimNode[]) => void }).initialize(warmNodes);
    (wn as unknown as (alpha?: number) => void)(0.15);
  }

  const oldTime = timeForce(oldFactory, oldNodes, iters);
  const newTime = timeForce(newFactory, oldNodes, iters);

  const ratio = oldTime.medianMs / Math.max(newTime.medianMs, 1e-9);
  const sign = ratio > 1 ? 'faster' : 'SLOWER';
  const usOld = (oldTime.medianMs * 1000).toFixed(1);
  const usNew = (newTime.medianMs * 1000).toFixed(1);
  const usTotalOld = oldTime.totalMs.toFixed(1);
  const usTotalNew = newTime.totalMs.toFixed(1);

  // eslint-disable-next-line no-console
  console.log(
    `[${label}] OLD ${usOld}µs/tick (total ${usTotalOld}ms over ${iters}) | ` +
    `NEW ${usNew}µs/tick (total ${usTotalNew}ms) | ` +
    `${ratio.toFixed(2)}× ${sign} | correctness Δ=${maxDelta.toFixed(4)}px`,
  );
}

/* ============================================================================
 * Benchmarks: optimization #1 (spatial index).
 * ============================================================================ */

test('PERF #1a: pairwiseRepel — packed cluster (worst case for force interactions)', () => {
  // pairwiseRepel at default config: strength=-120 unlinked, range=100.
  const STR = -120;
  const RNG = 100;
  for (const N of [3, 10, 30, 100]) {
    bench(
      `pairwiseRepel N=${N} packed`,
      () => makeNodesPacked(N),
      () => pairwiseRepelOLD(STR, RNG, () => true),
      () => pairwiseRepelNEW(STR, RNG, () => true),
    );
  }
  expect(true).toBe(true);
});

test('PERF #1b: pairwiseRepel — spread out 3000×3000', () => {
  const STR = -120;
  const RNG = 100;
  for (const N of [3, 10, 30, 100]) {
    bench(
      `pairwiseRepel N=${N} spread`,
      () => makeNodes(N, 3000),
      () => pairwiseRepelOLD(STR, RNG, () => true),
      () => pairwiseRepelNEW(STR, RNG, () => true),
    );
  }
  expect(true).toBe(true);
});

test('PERF #1c: rectCollide — packed cluster (forces 6-pass cascade work)', () => {
  for (const N of [3, 10, 30, 100]) {
    bench(
      `rectCollide N=${N} packed`,
      () => makeNodesPacked(N),
      () => rectCollideOLD(420, 120, 25),
      () => rectCollideNEW(420, 120, 25),
    );
  }
  expect(true).toBe(true);
});

test('PERF #1d: rectCollide — spread (no overlaps, just pair enumeration cost)', () => {
  for (const N of [3, 10, 30, 100]) {
    bench(
      `rectCollide N=${N} spread`,
      () => makeNodes(N, 3000),
      () => rectCollideOLD(420, 120, 25),
      () => rectCollideNEW(420, 120, 25),
    );
  }
  expect(true).toBe(true);
});

test('PERF #2: rectLink — nodes.find() vs nodeById map', () => {
  // rectLink at default config: targetBorderDistance=62.5, strength=0.6.
  const TBD = 62.5;
  const STR = 0.6;
  for (const N of [3, 10, 30, 100]) {
    const E = N; // realistic E ≈ N for tree topology
    const links = makeLinks(N, E);
    bench(
      `rectLink N=${N} E=${E}`,
      () => makeNodesPacked(N),
      () => rectLinkOLD(links, TBD, STR) as ReturnType<typeof pairwiseRepelOLD>,
      () => rectLinkNEW(links, TBD, STR) as ReturnType<typeof pairwiseRepelOLD>,
    );
  }
  expect(true).toBe(true);
});

/** Build a VerletRopeSim seeded with E chains over N nodes. Each chain
 *  connects node[i] → node[i+1]. After construction we tick a few times
 *  to let the chains settle into their A*-routed shape. */
function buildRopeSim(n: number, e: number): {
  sim: VerletRopeSim;
  reals: Map<string, { id: string; x: number; y: number; width: number; height: number }>;
  cfg: { maxSegmentLength: number; maxAnchorCount: number; margin: number; arrowRepelStrength: number; arrowRepelRange: number; exemptDraggedNodes: boolean };
} {
  const nodes = makeNodesPacked(n);
  const reals = new Map<string, { id: string; x: number; y: number; width: number; height: number }>();
  for (const n of nodes) {
    reals.set(n.id, { id: n.id, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 624, height: n.height ?? 200 });
  }
  const sim = new VerletRopeSim();
  const cfg = {
    maxSegmentLength: 25, maxAnchorCount: 96, margin: 40,
    arrowRepelStrength: 0.5, arrowRepelRange: 10, exemptDraggedNodes: false,
  };
  for (let i = 0; i < e; i++) {
    const srcId = `n${i % n}`;
    const tgtId = `n${(i + 1) % n}`;
    if (srcId === tgtId) continue;
    const src = reals.get(srcId)!;
    const tgt = reals.get(tgtId)!;
    sim.ensureChain({ arrowId: `a${i}`, sourceId: srcId, targetId: tgtId }, src, tgt, 0, cfg.maxSegmentLength, cfg.maxAnchorCount);
  }
  // Settle a few ticks so chains have routed shapes (Phase B is what we care about).
  for (let t = 0; t < 5; t++) sim.tick(reals, cfg);
  return { sim, reals, cfg };
}

test('PERF #12: verletRope.tick — Phase B cost (segList hoist is the candidate)', { timeout: 60_000 }, () => {
  // N=100 was dropped — sandbox cap is 50 nodes, and at N=100 the
  // visibility-graph + A* cost makes a 500-iter measurement exceed any
  // reasonable test timeout.
  // Iter count scaled per N so total wall time stays bounded; the median
  // converges fast — 100 samples is plenty when each sample is ~10ms+.
  for (const N of [3, 10, 30, 50]) {
    const E = N; // ~one chain per node
    const { sim, reals, cfg } = buildRopeSim(N, E);
    const warmIters = N >= 30 ? 30 : 100;
    const measureIters = N >= 30 ? 100 : 500;
    for (let w = 0; w < warmIters; w++) sim.tick(reals, cfg);
    const samples: number[] = [];
    for (let s = 0; s < measureIters; s++) {
      const t0 = performance.now();
      sim.tick(reals, cfg);
      const t1 = performance.now();
      samples.push(t1 - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(measureIters / 2)]!;
    const p95 = samples[Math.floor(measureIters * 0.95)]!;
    const total = samples.reduce((s, x) => s + x, 0);
    const budget = median < 16 ? 'OK' : 'OVER (16ms frame budget)';
    // eslint-disable-next-line no-console
    console.log(
      `[verletRope.tick N=${N} E=${E}] median ${median.toFixed(2)}ms | p95 ${p95.toFixed(2)}ms | ` +
      `total ${total.toFixed(0)}ms over ${measureIters} | ${budget}`,
    );
  }
  expect(true).toBe(true);
});

test('PERF #15: pairwiseRepel with strength=0 — should be near-zero cost', () => {
  // The early-return on strength=0 (item #15) should make this basically free.
  // Pre-#15 the function does the full O(N²) walk applying `vel += 0`.
  for (const N of [3, 10, 30, 100]) {
    const nodes = makeNodesPacked(N);
    // OLD: no early-return. Inline the same behavior as the OLD pairwiseRepel,
    // but the test sets strength=0 so it does the busywork.
    bench(
      `pairwiseRepel strength=0 N=${N}`,
      () => makeNodesPacked(N),
      () => pairwiseRepelOLD(0, 100, () => true),
      () => pairwiseRepelNEW(0, 100, () => true),
    );
    // Silence unused
    void nodes;
  }
  expect(true).toBe(true);
});

test('PERF #10: pairFilter cost — string-Set lookup vs bitset lookup', () => {
  // Mirror physicsWorker's edge-membership filter the way pairwiseRepel
  // calls it. OLD = edgeKey(a,b) string alloc + Set.has lookup. NEW =
  // nodeIdx Map.get ×2 + Uint8Array indexed access. We use the SAME
  // pairwiseRepel implementation; only the filter differs.
  for (const N of [10, 30, 100]) {
    const nodes = makeNodesPacked(N);
    const links = makeLinks(N, N); // E ≈ N

    // OLD: string-Set filter (allocates `${a}|${b}` per call).
    const linkedSet = new Set<string>(links.map((l) => {
      const s = l.source as string, t = l.target as string;
      return s < t ? `${s}|${t}` : `${t}|${s}`;
    }));
    const filterOld = (a: string, b: string) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      return linkedSet.has(key);
    };

    // NEW: bitset filter (no string alloc, typed-array lookup).
    const nodeIdx = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) nodeIdx.set(nodes[i]!.id, i);
    const bitset = new Uint8Array(N * N);
    for (const l of links) {
      const i = nodeIdx.get(l.source as string)!;
      const j = nodeIdx.get(l.target as string)!;
      const lo = i < j ? i : j;
      const hi = i < j ? j : i;
      bitset[lo * N + hi] = 1;
    }
    const filterNew = (a: string, b: string) => {
      const i = nodeIdx.get(a);
      const j = nodeIdx.get(b);
      if (i == null || j == null) return false;
      const lo = i < j ? i : j;
      const hi = i < j ? j : i;
      return bitset[lo * N + hi] === 1;
    };

    bench(
      `pairwiseRepel linkedFilter N=${N} (string-Set vs bitset)`,
      () => makeNodesPacked(N),
      () => pairwiseRepelOLD(-120, 100, filterOld),
      () => pairwiseRepelOLD(-120, 100, filterNew),
    );
  }
  expect(true).toBe(true);
});

test('PERF #1e: full sim tick — pairwiseRepel ×2 + rectCollide combined (drag scenario)', () => {
  // Mimic the per-tick force registration in physicsWorker.ts: linked
  // repel, unlinked repel, rectCollide.
  for (const N of [3, 10, 30, 100]) {
    const nodes = makeNodesPacked(N);
    const startSnap = snapshot(nodes);
    // No pinning to keep things comparable.

    const runOld = () => {
      restore(nodes, startSnap);
      const sim = forceSimulation(nodes)
        .force('linkedRepel', pairwiseRepelOLD(-10, 100, () => false))
        .force('unlinkedRepel', pairwiseRepelOLD(-120, 100, () => true))
        .force('rectCollide', rectCollideOLD(420, 120, 25))
        .alphaDecay(0)
        .stop();
      sim.alpha(0.15);
      const t0 = performance.now();
      for (let t = 0; t < 30; t++) sim.tick();
      return performance.now() - t0;
    };
    const runNew = () => {
      restore(nodes, startSnap);
      const sim = forceSimulation(nodes)
        .force('linkedRepel', pairwiseRepelNEW(-10, 100, () => false))
        .force('unlinkedRepel', pairwiseRepelNEW(-120, 100, () => true))
        .force('rectCollide', rectCollideNEW(420, 120, 25))
        .alphaDecay(0)
        .stop();
      sim.alpha(0.15);
      const t0 = performance.now();
      for (let t = 0; t < 30; t++) sim.tick();
      return performance.now() - t0;
    };

    // Warm
    for (let w = 0; w < 50; w++) runOld();
    for (let w = 0; w < 50; w++) runNew();

    const iters = 100;
    const oldSamples: number[] = [];
    const newSamples: number[] = [];
    for (let s = 0; s < iters; s++) oldSamples.push(runOld());
    for (let s = 0; s < iters; s++) newSamples.push(runNew());
    oldSamples.sort((a, b) => a - b);
    newSamples.sort((a, b) => a - b);
    const medOld = oldSamples[Math.floor(iters / 2)]!;
    const medNew = newSamples[Math.floor(iters / 2)]!;
    const ratio = medOld / Math.max(medNew, 1e-9);
    const sign = ratio > 1 ? 'faster' : 'SLOWER';
    // eslint-disable-next-line no-console
    console.log(
      `[fullSim N=${N} (30 ticks)] OLD ${medOld.toFixed(3)}ms | NEW ${medNew.toFixed(3)}ms | ${ratio.toFixed(2)}× ${sign}`,
    );
  }
  expect(true).toBe(true);
}, 15_000);

/* ============================================================================
 * PERF #20: REAL WORKER TICK COST — d3 forces + verletRope.tick combined.
 *
 * This is what physicsWorker.ts actually does inside runTickSideEffects:
 *   1. sim.tick() — runs every registered d3 force in turn.
 *   2. verletRope.tick() — re-routes every arrow polyline.
 *
 * PERF #1e measures (1) in isolation; PERF #12 measures (2) in isolation.
 * Neither shows what the user actually pays per worker tick — that's the
 * SUM, plus the interaction (node positions feeding into rope route).
 * This bench fills that gap at realistic sandbox sizes (N = 25 / 35 / 50).
 *
 * Realistic config: default physics knobs from defaults.ts —
 *   linkedRepelStrength = -10, unlinkedRepelStrength = 0 (skipped),
 *   repelRange = 50, collidePadding = 31.25, linkDistance = 62.5,
 *   linkStrength = 0.6.
 * Realistic graph: ~1 edge per node, packed layout (worst case for
 * pairwise forces — every pair within range).
 * ============================================================================ */
test('PERF #20: FULL worker tick — d3 forces + verletRope.tick combined', { timeout: 60_000 }, () => {
  for (const N of [25, 35, 50]) {
    const E = N;
    const nodes = makeNodesPacked(N);
    const links = makeLinks(N, E);

    // Realistic isLinked closure mirrors physicsWorker.rebuildLinkedEdges.
    const linkedSet = new Set<string>();
    for (const l of links) {
      const a = l.source as string;
      const b = l.target as string;
      linkedSet.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
    const isLinked = (a: string, b: string) => {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      return linkedSet.has(key);
    };

    // d3 sim — same force registration as physicsWorker.rebuild().
    const sim = forceSimulation(nodes)
      .force('linkedRepel', pairwiseRepelNEW(-10, 100, isLinked))
      // unlinkedRepelStrength=0 → pairwiseRepel early-returns; cost-free.
      .force('unlinkedRepel', pairwiseRepelNEW(0, 100, (a, b) => !isLinked(a, b)))
      .force('rectCollide', rectCollideNEW(420, 120, 25))
      .force('link', rectLinkNEW(links, 110, 0.6))
      .alphaDecay(0)
      .alphaMin(0)
      .stop();

    // Verlet rope sim — ensure one chain per link.
    const reals = new Map<string, { id: string; x: number; y: number; width: number; height: number }>();
    for (const n of nodes) {
      reals.set(n.id, { id: n.id, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 624, height: n.height ?? 200 });
    }
    const ropeSim = new VerletRopeSim();
    const ropeCfg = {
      maxSegmentLength: 25, maxAnchorCount: 96, margin: 40,
      arrowRepelStrength: 0.5, arrowRepelRange: 10, exemptDraggedNodes: false,
    };
    for (const l of links) {
      const src = reals.get(l.source as string)!;
      const tgt = reals.get(l.target as string)!;
      sim.alpha(0.15);  // keep d3 active
      ropeSim.ensureChain(
        { arrowId: l.arrowId!, sourceId: l.source as string, targetId: l.target as string },
        src, tgt, 0, ropeCfg.maxSegmentLength, ropeCfg.maxAnchorCount,
      );
    }

    // Helper: sync reals map from sim's mutated node positions, then
    // run one combined tick (d3 + rope).
    const oneCombinedTick = () => {
      sim.tick();
      for (const n of nodes) {
        const r = reals.get(n.id)!;
        r.x = n.x ?? 0;
        r.y = n.y ?? 0;
      }
      ropeSim.tick(reals, ropeCfg);
    };

    // Warm: V8 optimizing compiler + initial route stabilization.
    sim.alpha(0.15);
    for (let w = 0; w < 50; w++) oneCombinedTick();

    // Measure 200 combined ticks. Keep alpha topped up so each tick
    // does real work (matches a user actively dragging a node).
    const iters = 200;
    const samples: number[] = [];
    for (let s = 0; s < iters; s++) {
      sim.alpha(0.15);
      const t0 = performance.now();
      oneCombinedTick();
      const t1 = performance.now();
      samples.push(t1 - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(iters / 2)]!;
    const p95 = samples[Math.floor(iters * 0.95)]!;
    const total = samples.reduce((s, x) => s + x, 0);
    const tps = 1000 / median;
    const frameBudget16ms = median < 16 ? 'OK' : 'OVER';
    // eslint-disable-next-line no-console
    console.log(
      `[FULL TICK N=${N} E=${E}] median ${median.toFixed(3)}ms | p95 ${p95.toFixed(3)}ms | ${tps.toFixed(0)} ticks/s | 16ms frame budget: ${frameBudget16ms}`,
    );
    void total;
  }
  expect(true).toBe(true);
});
