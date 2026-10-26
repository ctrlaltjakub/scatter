export interface PinchZoomSample {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

const PINCH_ZOOM_MULTIPLIER = 7;
const PINCH_PIXEL_DELTA_LIMIT = 50;

/** Strengthen Mac-style pinch wheel events without changing normal wheel zoom. */
export function pinchZoomDelta(sample: PinchZoomSample): number {
  const isPinchLike =
    sample.ctrlKey
    && !sample.metaKey
    && sample.deltaMode === 0
    && Math.abs(sample.deltaY) < PINCH_PIXEL_DELTA_LIMIT;
  return isPinchLike ? sample.deltaY * PINCH_ZOOM_MULTIPLIER : sample.deltaY;
}
