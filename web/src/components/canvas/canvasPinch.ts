import { clampCameraZoom } from '@/lib/zoomLimits';
import { zoomViewportAroundPoint } from '@/lib/viewportZoom';

type Point = { x: number; y: number };
type View = Point & { zoom: number };
type Finger = Point & { target: Element };
type ScaleEvent = Event & { scale?: number; clientX?: number; clientY?: number };
type Origin = { view: View; at: Point; span: number };
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
const claim = (event: Event) => { if (event.cancelable) event.preventDefault(); event.stopPropagation(); };

/** Pointer events for direct touch; WebKit's cumulative scale events for
 * trackpads. Leave single touches, ordinary scrolling and browser UI alone. */
export function installCanvasPinch(host: HTMLElement, camera: {
  read(): View; write(view: View): void; start(): void; finish(): void;
  /** A presentation embedding the canvas may own direct touch itself. */
  externalTouch?: () => boolean;
}) {
  const listeners = new AbortController();
  const capture = { capture: true, passive: false, signal: listeners.signal };
  const fingers = new Map<number, Finger>();
  let touch: Origin | null = null, safari: Origin | null = null;
  let pointer: Point | null = null, ownFingers = false, blockClick = false;
  let syntheticCancel: Event | null = null;
  let directContacts = 0;
  const local = (x: number, y: number): Point => {
    const rect = host.getBoundingClientRect();
    return { x: x - rect.left, y: y - rect.top };
  };
  const scaleTo = (from: Origin, at: Point, span: number) => {
    if (!Number.isFinite(span) || span <= 0) return;
    const v = zoomViewportAroundPoint(from.view, from.at, clampCameraZoom(from.view.zoom * span / from.span));
    camera.write({ x: v.x + at.x - from.at.x, y: v.y + at.y - from.at.y, zoom: v.zoom });
  };
  const rebase = () => {
    const [a, b] = fingers.values();
    touch = a && b ? { view: camera.read(), at: midpoint(a, b), span: distance(a, b) } : null;
  };
  host.addEventListener('pointerdown', e => {
    if (!fingers.size) blockClick = false;
    if (e.pointerType !== 'touch' || camera.externalTouch?.() || !(e.target instanceof Element)) return;
    fingers.set(e.pointerId, { ...local(e.clientX, e.clientY), target: e.target });
    if (fingers.size < 2) return;
    claim(e);
    if (!ownFingers) {
      ownFingers = blockClick = true;
      safari = null;
      // Release whatever the first touch began (node drag, resize or press).
      const [id, first] = fingers.entries().next().value!;
      syntheticCancel = new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch', pointerId: id });
      first.target.dispatchEvent(syntheticCancel);
      syntheticCancel = null;
      camera.start();
    }
    for (const id of fingers.keys()) {
      try { host.setPointerCapture(id); } catch { /* pointer already released */ }
    }
    rebase();
  }, capture);
  host.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse') { pointer = { x: e.clientX, y: e.clientY }; return; }
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    Object.assign(finger, local(e.clientX, e.clientY));
    if (!ownFingers) return;
    claim(e);
    const [a, b] = fingers.values();
    if (touch && a && b) scaleTo(touch, midpoint(a, b), distance(a, b));
  }, capture);
  const release = (e: PointerEvent) => {
    if (e === syntheticCancel || !fingers.delete(e.pointerId) || !ownFingers) return;
    claim(e);
    if (!fingers.size) { ownFingers = false; camera.finish(); }
    rebase();
  };
  host.addEventListener('pointerup', release, capture);
  host.addEventListener('pointercancel', release, capture);
  host.addEventListener('click', e => { if (blockClick && e.detail !== 0) claim(e); }, capture);

  // iPadOS also emits gesture events for a *screen* pinch. Observe the
  // touch stream even if an embed handles the pointer events before us.
  const countTouches = (e: TouchEvent) => { directContacts = e.touches.length; };
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) {
    host.addEventListener(type, countTouches, { capture: true, passive: true, signal: listeners.signal });
  }
  const location = (e: ScaleEvent) => {
    const rect = host.getBoundingClientRect();
    // Some WebKit versions omit coordinates or give (0,0). Prefer the
    // trackpad pointer in that case, or the canvas center if it hasn't moved.
    if (e.clientX != null && e.clientY != null && (e.clientX || e.clientY)
      && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom)
      return local(e.clientX, e.clientY);
    return pointer ? local(pointer.x, pointer.y) : { x: rect.width / 2, y: rect.height / 2 };
  };
  // Some WebKit ports target the document rather than the element under the
  // trackpad. Only take that gesture if the hit-tested point is on this canvas.
  const targetsCanvas = (e: ScaleEvent) => {
    if (e.target instanceof Node && host.contains(e.target)) return true;
    if (e.target !== document && e.target !== document.body && e.target !== document.documentElement) return false;
    const point = e.clientX != null && e.clientY != null && (e.clientX || e.clientY)
      ? { x: e.clientX, y: e.clientY } : pointer;
    return !!point && host.contains(document.elementFromPoint(point.x, point.y));
  };
  document.addEventListener('gesturestart', (e: ScaleEvent) => {
    if (!targetsCanvas(e)) return;
    claim(e);
    if (directContacts || fingers.size) return;
    camera.start();
    safari = { view: camera.read(), at: location(e), span: e.scale && e.scale > 0 ? e.scale : 1 };
  }, capture);
  document.addEventListener('gesturechange', (e: ScaleEvent) => {
    if (!safari && !targetsCanvas(e)) return;
    claim(e);
    if (safari && !directContacts && !fingers.size) scaleTo(safari, location(e), e.scale ?? 1);
  }, capture);
  document.addEventListener('gestureend', e => {
    if (!safari && !targetsCanvas(e)) return;
    claim(e);
    if (safari) { safari = null; camera.finish(); }
  }, capture);
  window.addEventListener('blur', () => {
    if (ownFingers || safari) camera.finish();
    fingers.clear(); directContacts = 0; ownFingers = blockClick = false; touch = safari = null; pointer = null;
  }, { signal: listeners.signal });
  return {
    active: () => ownFingers || safari !== null || directContacts >= 2,
    dispose: () => listeners.abort(),
  };
}
