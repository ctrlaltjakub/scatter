import { describe, it, expect } from 'vitest';
import {
  VerletRopeSim,
  rectBorderToward,
  type RopeConfig,
  type RopeRealNode,
} from './verletRope';

const NODE_W = 100;
const NODE_H = 100;

const baseCfg: RopeConfig = {
  maxSegmentLength: 80,
  maxAnchorCount: 32,
  margin: 30,
  arrowRepelStrength: 0.3,
  arrowRepelRange: 60,
  exemptDraggedNodes: true,
};

/** Test source rect centered at (0, 0). */
const SRC_RECT: RopeRealNode = {
  id: 'source', x: -NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H,
};
/** Test target rect centered at (1000, 0). */
const TGT_RECT: RopeRealNode = {
  id: 'target', x: 1000 - NODE_W / 2, y: -NODE_H / 2, width: NODE_W, height: NODE_H,
};

const SRC_END_X = 50;   // src right edge
const TGT_END_X = 950;  // tgt left edge

function rectCenteredAt(id: string, cx: number, cy: number = 0): RopeRealNode {
  return { id, x: cx - NODE_W / 2, y: cy - NODE_H / 2, width: NODE_W, height: NODE_H };
}

function ensure(
  sim: VerletRopeSim,
  arrowId: string,
  srcRect: RopeRealNode = SRC_RECT,
  tgtRect: RopeRealNode = TGT_RECT,
  cfg: RopeConfig = baseCfg,
) {
  sim.ensureChain(
    { arrowId, sourceId: srcRect.id, targetId: tgtRect.id },
    srcRect, tgtRect,
    0, cfg.maxSegmentLength, cfg.maxAnchorCount,
  );
}

function scene(opts: { withObstacle: boolean }) {
  const reals = new Map<string, RopeRealNode>();
  reals.set(SRC_RECT.id, SRC_RECT);
  reals.set(TGT_RECT.id, TGT_RECT);
  if (opts.withObstacle) {
    reals.set('obstacle', {
      id: 'obstacle', x: 500 - NODE_W / 2, y: -200 - NODE_H / 2, width: NODE_W, height: NODE_H,
    });
  }
  return reals;
}

describe('rectBorderToward', () => {
  it('hits the right edge when target is directly to the right', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    const p = rectBorderToward(r, { x: 200, y: 50 });
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(50, 5);
  });

  it('hits the bottom edge when target is directly below', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    const p = rectBorderToward(r, { x: 50, y: 200 });
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeCloseTo(100, 5);
  });

  it('hits the bottom-right corner for an exactly diagonal target', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    const p = rectBorderToward(r, { x: 200, y: 200 });
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeCloseTo(100, 5);
  });

  it('hits the right edge (not the corner) for a shallow-diagonal target', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    const p = rectBorderToward(r, { x: 350, y: 200 });
    expect(p.x).toBeCloseTo(100, 5);
    expect(p.y).toBeLessThan(100);
  });

  it('returns the rect center when the target equals the center', () => {
    const r = { x: 0, y: 0, width: 100, height: 100 };
    const p = rectBorderToward(r, { x: 50, y: 50 });
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeCloseTo(50, 5);
  });
});

describe('VerletRopeSim — chain lifecycle', () => {
  it('ensureChain seeds anchors at average segment length', () => {
    const sim = new VerletRopeSim();
    ensure(sim, 'a1');
    const chain = sim.getChain('a1')!;
    expect(chain.length).toBeGreaterThanOrEqual(4);
    expect(chain.length).toBeLessThanOrEqual(baseCfg.maxAnchorCount);
  });

  it('ensureChain respects the MIN_ANCHOR_COUNT floor on tiny ports', () => {
    const sim = new VerletRopeSim();
    const closeTgt = rectCenteredAt('target', 60); // ~tiny port distance
    ensure(sim, 'a1', SRC_RECT, closeTgt);
    const chain = sim.getChain('a1')!;
    expect(chain.length).toBeGreaterThanOrEqual(4);
  });

  it('ensureChain respects the maxAnchorCount ceiling', () => {
    const sim = new VerletRopeSim();
    const cfg: RopeConfig = { ...baseCfg, maxAnchorCount: 6 };
    ensure(sim, 'a1', SRC_RECT, TGT_RECT, cfg);
    const chain = sim.getChain('a1')!;
    expect(chain.length).toBeLessThanOrEqual(6);
  });

  it('ensureChain is idempotent (does not duplicate)', () => {
    const sim = new VerletRopeSim();
    ensure(sim, 'a1');
    const lenBefore = sim.getChain('a1')!.length;
    ensure(sim, 'a1');
    expect(sim.getChain('a1')!.length).toBe(lenBefore);
  });

  it('removeChain drops the chain and prune cleans up stale ones', () => {
    const sim = new VerletRopeSim();
    ensure(sim, 'a1');
    ensure(sim, 'a2');
    sim.removeChain('a1');
    expect(sim.getChain('a1')).toBeUndefined();
    expect(sim.getChain('a2')).toBeDefined();
    sim.prune(new Set<string>());
    expect(sim.getChain('a2')).toBeUndefined();
  });

  it('snapshot returns chain positions in source-to-target order', () => {
    const sim = new VerletRopeSim();
    ensure(sim, 'a1');
    const snap = sim.snapshot();
    const pts = snap['a1']!;
    expect(pts.length).toBeGreaterThanOrEqual(4);
    // First sample is on the SRC side (x ≈ 50), last on TGT side (x ≈ 950).
    expect(pts[0]!.x).toBeLessThan(100);
    expect(pts[pts.length - 1]!.x).toBeGreaterThan(900);
  });

  it('keeps a persisted route settled on its first tick', () => {
    const sim = new VerletRopeSim();
    const persisted = [
      { x: 50, y: 0 },
      { x: 300, y: -180 },
      { x: 700, y: -180 },
      { x: 950, y: 0 },
    ];
    sim.ensureChain(
      { arrowId: 'a1', sourceId: SRC_RECT.id, targetId: TGT_RECT.id },
      SRC_RECT, TGT_RECT, 0, baseCfg.maxSegmentLength,
      baseCfg.maxAnchorCount, persisted,
    );
    const restoredLength = sim.getChain('a1')!.length;
    sim.tick(scene({ withObstacle: false }), baseCfg);
    // A first-tick A* route would resample this long chain to dozens of
    // anchors. Restored projects must keep the already persisted topology.
    expect(sim.getChain('a1')).toHaveLength(restoredLength);
  });
});

describe('VerletRopeSim — tick routing', () => {
  it('keeps distant restored chains inert when one node moves', () => {
    const sim = new VerletRopeSim();
    const aSrc = { id: 'a-src', x: 0, y: 0, width: 100, height: 100 };
    const aTgt = { id: 'a-tgt', x: 900, y: 0, width: 100, height: 100 };
    const bSrc = { id: 'b-src', x: 0, y: 2000, width: 100, height: 100 };
    const bTgt = { id: 'b-tgt', x: 900, y: 2000, width: 100, height: 100 };
    const restoredA = [{ x: 100, y: 50 }, { x: 500, y: 50 }, { x: 900, y: 50 }];
    const restoredB = [{ x: 100, y: 2050 }, { x: 500, y: 2050 }, { x: 900, y: 2050 }];
    sim.ensureChain({ arrowId: 'a', sourceId: aSrc.id, targetId: aTgt.id }, aSrc, aTgt, 0, 25, 96, restoredA);
    sim.ensureChain({ arrowId: 'b', sourceId: bSrc.id, targetId: bTgt.id }, bSrc, bTgt, 0, 25, 96, restoredB);
    const reals = new Map([aSrc, aTgt, bSrc, bTgt].map((node) => [node.id, node]));
    sim.tick(reals, baseCfg); // establish the restored geometry baseline
    const before = sim.snapshot().b!;
    aSrc.x += 150;
    sim.tick(reals, baseCfg);
    expect(sim.snapshot().b).toEqual(before);
  });

  it('endpoints stay pinned on rect borders across ticks', () => {
    const sim = new VerletRopeSim();
    const reals = scene({ withObstacle: false });
    ensure(sim, 'a1');
    for (let i = 0; i < 20; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // First anchor on src right edge (x = SRC_END_X), last on tgt left edge.
    expect(chain[0]!.x).toBeCloseTo(SRC_END_X, 1);
    expect(chain[chain.length - 1]!.x).toBeCloseTo(TGT_END_X, 1);
  });

  it('rope routes around an obstacle on the source-target line', () => {
    const sim = new VerletRopeSim();
    const reals = new Map<string, RopeRealNode>();
    reals.set(SRC_RECT.id, SRC_RECT);
    reals.set(TGT_RECT.id, TGT_RECT);
    // Obstacle directly on the line from src-center to tgt-center.
    reals.set('block', { id: 'block', x: 450, y: -50, width: NODE_W, height: NODE_H });
    ensure(sim, 'a1');
    for (let i = 0; i < 5; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // Some interior anchor should have non-trivial |y| (the rope detoured).
    let maxAbsY = 0;
    for (const a of chain) maxAbsY = Math.max(maxAbsY, Math.abs(a.y));
    expect(maxAbsY).toBeGreaterThan(20);
  });

  it('rope ignores nodes flagged as dragging (no obstacle avoidance)', () => {
    const sim = new VerletRopeSim();
    const reals = new Map<string, RopeRealNode>();
    reals.set(SRC_RECT.id, SRC_RECT);
    reals.set(TGT_RECT.id, TGT_RECT);
    // An obstacle that WOULD bend the rope, marked dragging=true.
    reals.set('block', {
      id: 'block', x: 450, y: -50, width: NODE_W, height: NODE_H, dragging: true,
    });
    ensure(sim, 'a1');
    for (let i = 0; i < 5; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // No bend — chain stays roughly straight along y=0.
    for (const a of chain) expect(Math.abs(a.y)).toBeLessThan(5);
  });

  it('endpoint follows the rope: bent rope attaches to the side of target where it approaches', () => {
    const sim = new VerletRopeSim();
    const reals = new Map<string, RopeRealNode>();
    reals.set(SRC_RECT.id, SRC_RECT);
    reals.set(TGT_RECT.id, TGT_RECT);
    // Obstacle straddling the line and shifted slightly UP so the shorter
    // detour is downward (more obstacle-mass below ⇒ wait, smaller side is up).
    // Place it slightly above-of-center so the rope clearly chooses to go
    // BELOW (around the further-away bottom corner).
    reals.set('block', { id: 'block', x: 450, y: -70, width: NODE_W, height: NODE_H });
    ensure(sim, 'a1');
    for (let i = 0; i < 5; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // The interior of the chain should be below the line (y > 0).
    const bends = chain.slice(1, -1);
    let avgY = 0;
    for (const a of bends) avgY += a.y;
    avgY /= bends.length;
    expect(avgY).toBeGreaterThan(0);
  });
});

describe('VerletRopeSim — drag', () => {
  it('routes through the cursor when the arrow is being dragged', () => {
    const sim = new VerletRopeSim();
    const reals = scene({ withObstacle: false });
    ensure(sim, 'a1');
    sim.startAnchorDrag('a1', 500, 300);
    for (let i = 0; i < 3; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // Some interior anchor should be near (500, 300) — the dragged waypoint.
    let minDistToCursor = Infinity;
    for (const a of chain) {
      const d = Math.hypot(a.x - 500, a.y - 300);
      if (d < minDistToCursor) minDistToCursor = d;
    }
    expect(minDistToCursor).toBeLessThan(50);
  });

  it('endAnchorDrag releases the chain back to auto-routing', () => {
    const sim = new VerletRopeSim();
    const reals = scene({ withObstacle: false });
    ensure(sim, 'a1');
    sim.startAnchorDrag('a1', 500, 300);
    for (let i = 0; i < 3; i++) sim.tick(reals, baseCfg);
    sim.endAnchorDrag('a1');
    for (let i = 0; i < 3; i++) sim.tick(reals, baseCfg);
    const chain = sim.getChain('a1')!;
    // No obstacles, no drag: chain settles back to a straight horizontal line.
    for (const a of chain) expect(Math.abs(a.y)).toBeLessThan(5);
  });

  it('getDraggedArrowId reports the currently dragged arrow', () => {
    const sim = new VerletRopeSim();
    ensure(sim, 'a1');
    expect(sim.getDraggedArrowId()).toBeNull();
    sim.startAnchorDrag('a1', 500, 300);
    expect(sim.getDraggedArrowId()).toBe('a1');
    sim.endAnchorDrag('a1');
    expect(sim.getDraggedArrowId()).toBeNull();
  });
});
