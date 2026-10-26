import { describe, it, expect } from 'vitest';
import { forceSimulation } from 'd3-force';
import {
  pairwiseRepel,
  rectCollide,
  arrowAvoid,
  edgeKey,
  type SimNode,
  type SimLink,
} from './forces';

describe('forces', () => {
  it('edgeKey is order-independent', () => {
    expect(edgeKey('a', 'b')).toBe(edgeKey('b', 'a'));
  });

  it('pairwiseRepel pushes two unfrozen real nodes apart', () => {
    const a: SimNode = { id: 'a', x: 0, y: 0, width: 100, height: 100 };
    const b: SimNode = { id: 'b', x: 50, y: 0, width: 100, height: 100 };
    const sim = forceSimulation([a, b])
      .force('repel', pairwiseRepel(-1000, 500, () => true))
      .alphaDecay(0)
      .stop();
    sim.alpha(1);
    for (let i = 0; i < 30; i++) sim.tick();
    const startGap = 50;
    const endGap = Math.abs((b.x ?? 0) + 50 - ((a.x ?? 0) + 50));
    expect(endGap).toBeGreaterThan(startGap);
  });

  it('rectCollide separates two overlapping real nodes', () => {
    const a: SimNode = { id: 'a', x: 0, y: 0, width: 100, height: 100 };
    const b: SimNode = { id: 'b', x: 50, y: 0, width: 100, height: 100 };
    const sim = forceSimulation([a, b])
      .force('rectCollide', rectCollide(420, 120, 0))
      .alphaDecay(0)
      .stop();
    sim.alpha(1);
    for (let i = 0; i < 5; i++) sim.tick();
    // After resolution there must be no horizontal overlap.
    const overlap = 100 - Math.abs((b.x ?? 0) - (a.x ?? 0));
    expect(overlap).toBeLessThanOrEqual(0.001);
  });

  it('arrowAvoid keeps a third node out of an arrow line', () => {
    const a: SimNode = { id: 'a', x: -50, y: -50, width: 100, height: 100, fx: -50, fy: -50 };
    const b: SimNode = { id: 'b', x: 950, y: -50, width: 100, height: 100, fx: 950, fy: -50 };
    // Sits squarely on the line.
    const inWay: SimNode = { id: 'c', x: 450, y: -50, width: 100, height: 100 };
    const link: SimLink = { source: 'a', target: 'b', kind: 'auto', gravitates: true, arrowId: 'arrow1' };
    const sim = forceSimulation([a, b, inWay])
      .force('arrowAvoid', arrowAvoid([link], 30))
      .alphaDecay(0)
      .stop();
    sim.alpha(1);
    for (let i = 0; i < 10; i++) sim.tick();
    // After resolution, the node center must sit outside the keep-out zone:
    // dist > min(W,H)/2 + padding = 50 + 30 = 80
    const cy = (inWay.y ?? 0) + 50;
    expect(Math.abs(cy)).toBeGreaterThan(79);
  });

  it('pairwiseRepel uses BORDER distance: a tiny node still feels a giant neighbor whose center is far', () => {
    // Without border-distance, a 600×400 node centered 700 px away from a
    // tiny 40×40 node would emit a center-distance ≈ 700 force, identical
    // to two 40×40 nodes 700 px apart center-to-center — even though the
    // tiny node is right against the giant's border. With border-distance
    // the tiny node feels much MORE force here (border gap ~ 100 px).
    const tiny: SimNode = { id: 't', x: 0, y: 0, width: 40, height: 40 };
    // Giant: top-left at (140, -180) → x range [140, 740], y range [-180, 220].
    // Centers: tiny (20, 20), giant (440, 20). Center distance = 420.
    // Border distance: gapX = 140 - 40 = 100, gapY = 0 → border = 100.
    const giant: SimNode = { id: 'g', x: 140, y: -180, width: 600, height: 400, fx: 140, fy: -180 };
    const sim = forceSimulation([tiny, giant])
      .force('repel', pairwiseRepel(-1000, 500, () => true))
      .alphaDecay(0)
      .stop();
    sim.alpha(1);
    for (let i = 0; i < 30; i++) sim.tick();
    // Tiny should drift LEFT (away from giant's right side) by a non-trivial
    // amount. Old center-distance form gave fewer ticks of strong push because
    // the falloff was relative to 420 px (large center distance), not the
    // 100 px gap to the giant's left edge.
    expect(tiny.x ?? 0).toBeLessThan(-20);
  });

  it('PRODUCTION: pairwiseRepel (linear) drifts two unlinked real nodes 800 px apart visibly apart', () => {
    // a is pinned so we measure b's drift in absolute coordinates.
    const a: SimNode = { id: 'a', x: 0, y: 0, width: 100, height: 100, fx: 0, fy: 0 };
    const b: SimNode = { id: 'b', x: 800, y: 0, width: 100, height: 100 };
    const sim = forceSimulation([a, b])
      .force('repel', pairwiseRepel(-200, 1500, () => true))
      .alphaDecay(0.04)
      .alphaMin(0.005)
      .velocityDecay(0.82)
      .stop();
    sim.alpha(1);
    while (sim.alpha() > sim.alphaMin()) sim.tick();
    const drift = (b.x ?? 0) - 800;
    // eslint-disable-next-line no-console
    console.log(`[PROD pairwiseRepel] b drifted ${drift.toFixed(1)} px to the right (target > 20)`);
    expect(b.x ?? 0).toBeGreaterThan(820);
  });
});
