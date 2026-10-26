import { performance } from 'node:perf_hooks';
import { expect, test } from 'vitest';
import { VerletRopeSim, type RopeConfig, type RopeRealNode } from './verletRope';

/** Geometry-only stand-in for the supplied 75-node project. No user content is
 * committed to the fixture; it retains the node/arrow/control-point scale that
 * exposed the global rope-solver regression. */
test('a local drag in a 75-node project stays within a worker-frame budget', () => {
  const reals = new Map<string, RopeRealNode>();
  for (let i = 0; i < 75; i++) {
    reals.set(`n${i}`, {
      id: `n${i}`,
      x: (i % 15) * 780,
      y: Math.floor(i / 15) * 560,
      width: 624,
      height: 280,
    });
  }
  const cfg: RopeConfig = {
    maxSegmentLength: 25,
    maxAnchorCount: 96,
    margin: 40,
    arrowRepelStrength: 0.5,
    arrowRepelRange: 10,
    exemptDraggedNodes: false,
  };
  const sim = new VerletRopeSim();
  const links: [number, number][] = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 1; col < 15; col++) links.push([row * 15 + col - 1, row * 15 + col]);
  }
  for (let row = 1; row < 5; row++) links.push([(row - 1) * 15, row * 15]);
  for (let i = 0; i < links.length; i++) {
    const [sourceIndex, targetIndex] = links[i]!;
    const source = reals.get(`n${sourceIndex}`)!;
    const target = reals.get(`n${targetIndex}`)!;
    const anchors = Array.from({ length: 20 }, (_, point) => {
      const t = point / 19;
      return {
        x: source.x + source.width + (target.x - source.x - source.width) * t,
        y: source.y + source.height / 2
          + (target.y + target.height / 2 - source.y - source.height / 2) * t,
      };
    });
    sim.ensureChain(
      { arrowId: `a${i}`, sourceId: source.id, targetId: target.id },
      source, target, 0, cfg.maxSegmentLength, cfg.maxAnchorCount, anchors,
    );
  }
  sim.tick(reals, cfg); // establish restored geometry baseline
  const moved = reals.get('n37')!;
  moved.dragging = true;
  const samples: number[] = [];
  for (let i = 0; i < 18; i++) {
    moved.x += 3;
    const start = performance.now();
    sim.tick(reals, cfg);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  // Broad enough for slower CI machines, but comfortably rejects the former
  // 100ms+ global segment-pair scan.
  expect(median).toBeLessThan(50);
}, 15_000);
