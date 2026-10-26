/** Shared camera-gesture constants and zoom-around-point math. */

export const WHEEL_ZOOM_RATE = 0.001;

export function wheelZoomLevel(
  current: number,
  deltaY: number,
  min: number,
  max: number,
): number {
  return Math.max(min, Math.min(max, current * (1 - deltaY * WHEEL_ZOOM_RATE)));
}

/** Keep the world point beneath `anchor` fixed while changing zoom. */
export function zoomViewportAroundPoint(
  current: { x: number; y: number; zoom: number },
  anchor: { x: number; y: number },
  nextZoom: number,
): { x: number; y: number; zoom: number } {
  const worldX = (anchor.x - current.x) / current.zoom;
  const worldY = (anchor.y - current.y) / current.zoom;
  return {
    x: anchor.x - worldX * nextZoom,
    y: anchor.y - worldY * nextZoom,
    zoom: nextZoom,
  };
}
