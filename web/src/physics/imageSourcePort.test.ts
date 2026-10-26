import { describe, expect, it } from 'vitest';
import { imageRegionFrame } from '@/lib/imageRegionFrame';
import { sourcePortToward } from './sourcePort';
import { VerletRopeSim, type RopeConfig, type RopeRealNode } from './verletRope';

const rect = { x: 0, y: 0, width: 400, height: 300 };
const regions = [{ x: .1, y: .1, width: .2, height: .2 }];
const frame = imageRegionFrame(regions, rect)!;
const cfg: RopeConfig = { maxSegmentLength: 80, maxAnchorCount: 32, margin: 20, arrowRepelStrength: 0, arrowRepelRange: 60, exemptDraggedNodes: true };
const source: RopeRealNode = { id: 'source', ...rect };
const target: RopeRealNode = { id: 'target', x: 900, y: 10, width: 200, height: 100 };

describe('true image-region rope sources', () => {
  it('rounds the frame and intersects its edge, not its center or square corner', () => {
    const square = imageRegionFrame([{ x: 0, y: 0, width: 1, height: 1 }], { x: 0, y: 0, width: 100, height: 100 })!;
    const at = sourcePortToward(square.port, { x: 0, y: 0 }, { x: 200, y: 200 });
    expect(at.x).toBeGreaterThan(96);
    expect(at.x).toBeLessThan(100);
    expect(at.y).toBeCloseTo(at.x);
    expect(square.port.contours).toHaveLength(1);
  });
  it('uses the outside union boundary for overlapping rectangles and supports disconnected parts', () => {
    const merged = imageRegionFrame([{ x: .1, y: .1, width: .5, height: .5 }, { x: .4, y: .1, width: .5, height: .5 }], rect)!;
    expect(merged.port.contours).toHaveLength(1);
    expect(sourcePortToward(merged.port, { x: 0, y: 0 }, { x: 1000, y: 105 }).x).toBeCloseTo(360);
    const separate = imageRegionFrame([{ x: .1, y: .1, width: .2, height: .2 }, { x: .7, y: .7, width: .2, height: .2 }], rect)!;
    expect(separate.port.contours).toHaveLength(2);
  });
  it('routes a single straight chain through the card edge without a direction change there', () => {
    const sim = new VerletRopeSim();
    sim.ensureChain({ arrowId: 'image', sourceId: 'source', targetId: 'target', sourcePort: frame.port }, source, target, 0, 80, 32);
    const reals = new Map([[source.id, source], [target.id, target]]);
    for (let i = 0; i < 10; i++) sim.tick(reals, cfg);
    const chain = sim.snapshot().image!;
    expect(chain[0]!.x).toBeCloseTo(120);
    expect(chain[0]!.y).toBeCloseTo(60);
    expect(chain.at(-1)!.x).toBeCloseTo(900);
    for (const point of chain) expect(point.y).toBeCloseTo(60);
    expect(chain.some((p) => p.x < 400)).toBe(true);
    expect(chain.some((p) => p.x > 400)).toBe(true);
  });
  it('moves the true region endpoint with its node and routes around other obstacles', () => {
    const sim = new VerletRopeSim();
    sim.ensureChain({ arrowId: 'image', sourceId: 'source', targetId: 'target', sourcePort: frame.port }, source, target, 0, 80, 32);
    const moved = { ...source, x: 100, y: 80 };
    const obstacle = { id: 'obstacle', x: 550, y: -20, width: 100, height: 280 };
    const reals = new Map([[source.id, moved], [target.id, target], [obstacle.id, obstacle]]);
    sim.tick(reals, cfg);
    const chain = sim.snapshot().image!;
    expect(chain[0]!.x).toBeGreaterThanOrEqual(140);
    expect(chain[0]!.x).toBeLessThanOrEqual(220.01);
    expect(chain[0]!.y).toBeGreaterThanOrEqual(110);
    expect(chain[0]!.y).toBeLessThanOrEqual(170);
    expect(chain.some((p) => p.y < -20 || p.y > 260)).toBe(true);
  });
  it('updates only the image rope, preserves an unrelated saved chain exactly, and can restore normal ports', () => {
    const sim = new VerletRopeSim();
    const saved = [{ x: 400, y: 150 }, { x: 600, y: 140 }, { x: 800, y: 130 }, { x: 900, y: 60 }];
    for (const arrowId of ['image', 'ordinary']) sim.ensureChain({ arrowId, sourceId: 'source', targetId: 'target' }, source, target, 0, 80, 32, saved);
    const original = sim.snapshot().ordinary;
    sim.setSourcePort('image', frame.port);
    const reals = new Map([[source.id, source], [target.id, target]]);
    sim.tick(reals, cfg);
    expect(sim.snapshot().ordinary).toEqual(original);
    expect(sim.snapshot().image![0]!.x).toBeCloseTo(120);
    sim.setSourcePort('image');
    sim.tick(reals, cfg);
    expect(sim.snapshot().image![0]!.x).toBeCloseTo(400);
  });
  it('keeps the rope on the island nearest the child, including after the child moves', () => {
    const port = imageRegionFrame([{ x: .1, y: .1, width: .2, height: .2 }, { x: .7, y: .7, width: .2, height: .2 }], rect)!.port;
    const sim = new VerletRopeSim();
    const right = { ...target, x: 900, y: 190 };
    sim.ensureChain({ arrowId: 'image', sourceId: 'source', targetId: 'target', sourcePort: port }, source, right, 0, 80, 32);
    sim.tick(new Map([[source.id, source], [right.id, right]]), cfg);
    expect(sim.snapshot().image![0]!.x).toBeCloseTo(360);
    expect(sim.snapshot().image![0]!.y).toBeCloseTo(240);
    const left = { ...right, x: -400, y: 10 };
    for (let i = 0; i < 10; i++) sim.tick(new Map([[source.id, source], [left.id, left]]), cfg);
    expect(sim.snapshot().image![0]!.x).toBeCloseTo(40);
    expect(sim.snapshot().image![0]!.y).toBeCloseTo(60);
  });
});
