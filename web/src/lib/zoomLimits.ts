export const MIN_CAMERA_ZOOM = 0.1;
export const MAX_CAMERA_ZOOM = 1.5;

export function clampCameraZoom(zoom: number): number {
  return Math.max(MIN_CAMERA_ZOOM, Math.min(MAX_CAMERA_ZOOM, zoom));
}

export function clampViewportZoom<T extends { zoom: number }>(viewport: T): T {
  const zoom = clampCameraZoom(viewport.zoom);
  return zoom === viewport.zoom ? viewport : { ...viewport, zoom };
}
