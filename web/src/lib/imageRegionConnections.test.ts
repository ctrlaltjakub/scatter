import { describe, expect, it } from 'vitest';
import { imageRegionFrame } from './imageRegionFrame';
import { connectedImageRegions } from './imageRegionConnections';
import { closestPointOnPort, sourcePortToward } from '@/physics/sourcePort';
import type { ImageRegion } from '@/store/types';

const rect = { x: 30, y: 50, width: 600, height: 400 };
const box = (x: number, y: number): ImageRegion => ({ x, y, width: .1, height: .1 });
const lines = (path: string) => [...path.matchAll(/M([^,]+),([^L]+)L([^,]+),([^M]+)/g)].map(m => ({
  from: { x: Number(m[1]), y: Number(m[2]) }, to: { x: Number(m[3]), y: Number(m[4]) },
}));
describe('image selection chains', () => {
  it('adds no connector for one, overlapping, edge-touching or corner-touching selections', () => {
    for (const regions of [[box(.1, .1)], [box(.1, .1), box(.15, .1)], [box(.1, .1), box(.2, .1)], [box(.1, .1), box(.2, .2)]]) {
      expect(connectedImageRegions(regions)).toHaveLength(1);
      expect(imageRegionFrame(regions, rect)!.connectionPath).toBe('');
    }
  });
  it('joins two separated frames at their boundaries, using actual bitmap size and offset', () => {
    const frame = imageRegionFrame([box(.1, .1), box(.7, .1)], rect)!;
    const chain = lines(frame.connectionPath);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.from).toEqual({ x: 150, y: 110 });
    expect(chain[0]!.to).toEqual({ x: 450, y: 110 });
  });
  it('makes a geometrically ordered chain, independent of the order rectangles were selected', () => {
    const regions = [box(.1, .1), box(.7, .1), box(.4, .1), box(.7, .7)];
    const frame = imageRegionFrame(regions, rect)!;
    expect(imageRegionFrame([...regions].reverse(), rect)!.connectionPath).toBe(frame.connectionPath);
    const chain = lines(frame.connectionPath);
    expect(chain).toHaveLength(3);
    const ports = frame.port.components!;
    const degrees = ports.map(() => 0);
    for (const line of chain) {
      for (const endpoint of [line.from, line.to]) {
        const index = ports.findIndex(port => {
          const point = closestPointOnPort(port, endpoint);
          return Math.hypot(point.x - endpoint.x, point.y - endpoint.y) < 1e-6;
        });
        expect(index).toBeGreaterThanOrEqual(0);
        degrees[index]!++;
      }
    }
    expect(degrees.sort()).toEqual([1, 1, 2, 2]);
    // Aligned neighbours link horizontally; the last one connects vertically.
    expect(chain.every(({ from, to }) => Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.y - to.y) < 1e-6)).toBe(true);
  });
  it('does not mistake a hole inside a connected selection for another selected area', () => {
    const ring = [{ x: .1, y: .1, width: .5, height: .1 }, { x: .1, y: .5, width: .5, height: .1 },
      { x: .1, y: .1, width: .1, height: .5 }, { x: .5, y: .1, width: .1, height: .5 }];
    expect(imageRegionFrame(ring, rect)!.connectionPath).toBe('');
    expect(lines(imageRegionFrame([...ring, box(.8, .8)], rect)!.connectionPath)).toHaveLength(1);
  });
  it('starts the outgoing arrow on the closest selected island, not a fixed overall centre', () => {
    const frame = imageRegionFrame([box(.1, .1), box(.7, .7)], rect)!;
    const below = sourcePortToward(frame.port, { x: 100, y: 200 }, { x: 580, y: 1000 });
    expect(below.x).toBeCloseTo(580);
    expect(below.y).toBeCloseTo(570);
    const left = sourcePortToward(frame.port, { x: 100, y: 200 }, { x: -100, y: 310 });
    expect(left.x).toBeCloseTo(190);
    expect(left.y).toBeCloseTo(310);
  });
});
