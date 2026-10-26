import { wheelZoomLevel } from './viewportZoom';

export const MIN_IMAGE_EDITOR_ZOOM = 1;
export const MAX_IMAGE_EDITOR_ZOOM = 8;
export const IMAGE_EDITOR_ZOOM_STEP = 1.125;
export const IMAGE_EDITOR_ZOOM_DURATION_MS = 140;

export interface ImageEditorViewGeometry {
  viewportWidth: number;
  viewportHeight: number;
  region: { x: number; y: number; width: number; height: number };
}

export interface ImageEditorViewSnapshot {
  zoom: number;
  panX: number;
  panY: number;
  spaceHeld: boolean;
  panning: boolean;
  revision: number;
}

export interface ImageEditorViewTransform {
  scale: number;
  x: number;
  y: number;
}

const EMPTY_GEOMETRY: ImageEditorViewGeometry = {
  viewportWidth: 0,
  viewportHeight: 0,
  region: { x: 0, y: 0, width: 1, height: 1 },
};

function clampZoom(zoom: number): number {
  return Math.max(MIN_IMAGE_EDITOR_ZOOM, Math.min(MAX_IMAGE_EDITOR_ZOOM, zoom));
}

function sameGeometry(a: ImageEditorViewGeometry, b: ImageEditorViewGeometry): boolean {
  return a.viewportWidth === b.viewportWidth
    && a.viewportHeight === b.viewportHeight
    && a.region.x === b.region.x
    && a.region.y === b.region.y
    && a.region.width === b.region.width
    && a.region.height === b.region.height;
}

export function imageEditorFitScale(geometry: ImageEditorViewGeometry): number {
  const { viewportWidth, viewportHeight, region } = geometry;
  if (viewportWidth <= 0 || viewportHeight <= 0 || region.width <= 0 || region.height <= 0) return 0;
  return Math.min(viewportWidth / region.width, viewportHeight / region.height);
}

export function imageEditorViewTransform(
  view: Pick<ImageEditorViewSnapshot, 'zoom' | 'panX' | 'panY'>,
  geometry: ImageEditorViewGeometry,
): ImageEditorViewTransform {
  const fit = imageEditorFitScale(geometry);
  const scale = fit * view.zoom;
  const cx = geometry.region.x + geometry.region.width / 2;
  const cy = geometry.region.y + geometry.region.height / 2;
  return {
    scale,
    x: geometry.viewportWidth / 2 + view.panX - cx * scale,
    y: geometry.viewportHeight / 2 + view.panY - cy * scale,
  };
}

export function clampImageEditorPan(
  view: Pick<ImageEditorViewSnapshot, 'zoom' | 'panX' | 'panY'>,
  geometry: ImageEditorViewGeometry,
): { panX: number; panY: number } {
  const fit = imageEditorFitScale(geometry);
  if (fit <= 0) return { panX: 0, panY: 0 };
  const scaledWidth = geometry.region.width * fit * view.zoom;
  const scaledHeight = geometry.region.height * fit * view.zoom;
  const maxX = Math.max(0, (scaledWidth - geometry.viewportWidth) / 2);
  const maxY = Math.max(0, (scaledHeight - geometry.viewportHeight) / 2);
  return {
    panX: Math.max(-maxX, Math.min(maxX, view.panX)),
    panY: Math.max(-maxY, Math.min(maxY, view.panY)),
  };
}

/** Logarithmic slider mapping: equal travel means equal zoom ratios. */
export function imageEditorZoomToSlider(zoom: number): number {
  return (Math.log(clampZoom(zoom)) / Math.log(MAX_IMAGE_EDITOR_ZOOM)) * 100;
}

export function imageEditorSliderToZoom(value: number): number {
  const position = Math.max(0, Math.min(100, value));
  return clampZoom(Math.pow(MAX_IMAGE_EDITOR_ZOOM, position / 100));
}

type Listener = () => void;

/** Runtime-only camera for the image editor. It never enters image history. */
export class ImageEditorViewportController {
  private geometry = EMPTY_GEOMETRY;
  private listeners = new Set<Listener>();
  private snapshot: ImageEditorViewSnapshot = {
    zoom: MIN_IMAGE_EDITOR_ZOOM,
    panX: 0,
    panY: 0,
    spaceHeld: false,
    panning: false,
    revision: 0,
  };
  private animationFrame: number | null = null;
  private animationTarget = MIN_IMAGE_EDITOR_ZOOM;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ImageEditorViewSnapshot => this.snapshot;

  configure(geometry: ImageEditorViewGeometry): void {
    if (sameGeometry(this.geometry, geometry)) return;
    this.geometry = geometry;
    const pan = clampImageEditorPan(this.snapshot, geometry);
    // Geometry changes affect the rendered transform even when fitted pan and
    // zoom stay numerically identical. Force one subscriber notification so a
    // newly mounted viewer paints its first image instead of waiting for an
    // unrelated state change (such as switching to the next image).
    this.publish({ panX: pan.panX, panY: pan.panY, revision: this.snapshot.revision });
  }

  fit(): void {
    this.cancelAnimation();
    this.publish({ zoom: MIN_IMAGE_EDITOR_ZOOM, panX: 0, panY: 0 });
  }

  /** Repaint after an external visual resource (such as a remote image) has
   * decoded without changing the temporary camera. */
  refresh(): void {
    this.publish({ revision: this.snapshot.revision });
  }

  setZoom(zoom: number, anchor?: { x: number; y: number }): void {
    this.cancelAnimation();
    this.setZoomInternal(zoom, anchor);
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.setZoom(this.snapshot.zoom * factor, anchor);
  }

  zoomByWheel(deltaY: number, anchor: { x: number; y: number }): void {
    this.setZoom(wheelZoomLevel(
      this.snapshot.zoom,
      deltaY,
      MIN_IMAGE_EDITOR_ZOOM,
      MAX_IMAGE_EDITOR_ZOOM,
    ), anchor);
  }

  animateZoomBy(factor: number, anchor?: { x: number; y: number }): void {
    if (typeof requestAnimationFrame === 'undefined') {
      this.zoomBy(factor, anchor);
      return;
    }
    const base = this.animationFrame === null ? this.snapshot.zoom : this.animationTarget;
    this.animationTarget = clampZoom(base * factor);
    if (this.animationTarget === this.snapshot.zoom && this.animationFrame === null) return;
    this.cancelAnimation(false);
    const startZoom = this.snapshot.zoom;
    const startTime = performance.now();
    const fixedAnchor = anchor ?? this.center();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / IMAGE_EDITOR_ZOOM_DURATION_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      this.setZoomInternal(startZoom + (this.animationTarget - startZoom) * eased, fixedAnchor);
      if (t < 1) this.animationFrame = requestAnimationFrame(step);
      else this.animationFrame = null;
    };
    this.animationFrame = requestAnimationFrame(step);
  }

  panBy(dx: number, dy: number): void {
    this.cancelAnimation();
    const desired = {
      zoom: this.snapshot.zoom,
      panX: this.snapshot.panX + dx,
      panY: this.snapshot.panY + dy,
    };
    const pan = clampImageEditorPan(desired, this.geometry);
    this.publish({ panX: pan.panX, panY: pan.panY });
  }

  setSpaceHeld(spaceHeld: boolean): void {
    this.publish({ spaceHeld });
  }

  setPanning(panning: boolean): void {
    this.publish({ panning });
  }

  destroy(): void {
    this.cancelAnimation();
    this.listeners.clear();
  }

  private center(): { x: number; y: number } {
    return { x: this.geometry.viewportWidth / 2, y: this.geometry.viewportHeight / 2 };
  }

  private setZoomInternal(zoom: number, anchor = this.center()): void {
    const nextZoom = clampZoom(zoom);
    const oldTransform = imageEditorViewTransform(this.snapshot, this.geometry);
    if (oldTransform.scale <= 0) {
      this.publish({ zoom: nextZoom, panX: 0, panY: 0 });
      return;
    }
    const worldX = (anchor.x - oldTransform.x) / oldTransform.scale;
    const worldY = (anchor.y - oldTransform.y) / oldTransform.scale;
    const nextScale = imageEditorFitScale(this.geometry) * nextZoom;
    const cx = this.geometry.region.x + this.geometry.region.width / 2;
    const cy = this.geometry.region.y + this.geometry.region.height / 2;
    const desired = {
      zoom: nextZoom,
      panX: anchor.x - this.geometry.viewportWidth / 2 - (worldX - cx) * nextScale,
      panY: anchor.y - this.geometry.viewportHeight / 2 - (worldY - cy) * nextScale,
    };
    const pan = clampImageEditorPan(desired, this.geometry);
    this.publish({ zoom: nextZoom, panX: pan.panX, panY: pan.panY });
  }

  private cancelAnimation(clearTarget = true): void {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    if (clearTarget) this.animationTarget = this.snapshot.zoom;
  }

  private publish(patch: Partial<ImageEditorViewSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (
      next.zoom === this.snapshot.zoom
      && next.panX === this.snapshot.panX
      && next.panY === this.snapshot.panY
      && next.spaceHeld === this.snapshot.spaceHeld
      && next.panning === this.snapshot.panning
      && Object.keys(patch).length > 0
      && !('revision' in patch)
    ) return;
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
}
