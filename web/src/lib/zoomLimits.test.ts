import { describe, expect, it } from 'vitest';
import {
  MAX_CAMERA_ZOOM,
  MIN_CAMERA_ZOOM,
  clampCameraZoom,
  clampViewportZoom,
} from './zoomLimits';

describe('camera zoom limits', () => {
  it('allows zooming out to ten percent and no farther', () => {
    expect(MIN_CAMERA_ZOOM).toBe(0.1);
    expect(clampCameraZoom(0.1)).toBe(0.1);
    expect(clampCameraZoom(0.05)).toBe(0.1);
  });

  it('allows zooming in to one-hundred-fifty percent and no farther', () => {
    expect(MAX_CAMERA_ZOOM).toBe(1.5);
    expect(clampCameraZoom(1.5)).toBe(1.5);
    expect(clampCameraZoom(2)).toBe(1.5);
  });

  it('clamps a viewport without changing its other fields', () => {
    expect(clampViewportZoom({ x: 12, y: 34, zoom: 0.02 }))
      .toEqual({ x: 12, y: 34, zoom: 0.1 });
  });
});
