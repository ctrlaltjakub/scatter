import { describe, expect, it } from 'vitest';
import { pinchZoomDelta, type PinchZoomSample } from './pinchZoomDelta';

const sample = (overrides: Partial<PinchZoomSample> = {}): PinchZoomSample => ({
  deltaY: 2,
  deltaMode: 0,
  ctrlKey: true,
  metaKey: false,
  ...overrides,
});

describe('pinchZoomDelta', () => {
  it('makes small Ctrl-marked pixel input seven times stronger', () => {
    expect(pinchZoomDelta(sample())).toBe(14);
  });

  it('leaves chunky Ctrl+wheel input unchanged', () => {
    expect(pinchZoomDelta(sample({ deltaY: 100 }))).toBe(100);
  });

  it('leaves Cmd+wheel, line-mode, and unmodified input unchanged', () => {
    expect(pinchZoomDelta(sample({ ctrlKey: false, metaKey: true }))).toBe(2);
    expect(pinchZoomDelta(sample({ deltaMode: 1 }))).toBe(2);
    expect(pinchZoomDelta(sample({ ctrlKey: false }))).toBe(2);
  });
});
