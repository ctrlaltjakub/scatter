import { afterEach, expect, it, vi } from 'vitest';
import { installCanvasPinch } from './canvasPinch';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); });
function canvas() {
  const host = document.createElement('div'), node = document.createElement('button');
  host.append(node); document.body.append(host);
  host.getBoundingClientRect = () => new DOMRect(100, 50, 800, 600);
  let view = { x: 0, y: 0, zoom: 0.5 };
  const start = vi.fn(), finish = vi.fn();
  const pinch = installCanvasPinch(host, { read: () => view, write: v => { view = v; }, start, finish });
  cleanups.push(() => { pinch.dispose(); host.remove(); });
  const pointer = (type: string, id: number, x: number, y = 150) => node.dispatchEvent(new PointerEvent(type,
    { pointerType: 'touch', pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const gesture = (type: string, scale: number, target: EventTarget = node) => {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 250, clientY: 150 });
    return target.dispatchEvent(event);
  };
  return { node, host, start, finish, pinch, pointer, gesture, view: () => view };
}

it('pinches around the moving finger midpoint and never turns the release into a node click', () => {
  const c = canvas(), cancel = vi.fn(), click = vi.fn();
  c.node.addEventListener('pointercancel', cancel);
  c.node.addEventListener('click', click);
  expect(c.pointer('pointerdown', 1, 200)).toBe(true); // one touch remains a normal interaction
  c.pointer('pointerdown', 2, 300);
  c.pointer('pointermove', 2, 400); // span 100 → 200, center also moves by 50
  expect(c.view()).toEqual({ zoom: 1, x: -100, y: -100 });
  expect(cancel).toHaveBeenCalledOnce();
  c.pointer('pointerup', 2, 400);
  c.pointer('pointerup', 1, 200);
  expect(c.start).toHaveBeenCalledOnce();
  expect(c.finish).toHaveBeenCalledOnce();
  expect(c.pinch.active()).toBe(false);
  c.node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  expect(click).not.toHaveBeenCalled();
  c.pointer('pointerdown', 3, 200); c.pointer('pointerup', 3, 200);
  c.node.click();
  expect(click).toHaveBeenCalledOnce();
});

it('uses cumulative WebKit scale, both directions and app zoom limits, without capturing the rest of the page', () => {
  const c = canvas();
  const outside = document.createElement('button'); document.body.append(outside);
  try { expect(c.gesture('gesturestart', 1, outside)).toBe(true); } finally { outside.remove(); }
  expect(c.gesture('gesturestart', 1)).toBe(false);
  c.gesture('gesturechange', 1.2); c.gesture('gesturechange', 1.6);
  expect(c.view()).toEqual({ zoom: 0.8, x: -90, y: -60 });
  c.gesture('gesturechange', 0.5); expect(c.view().zoom).toBe(0.25);
  c.gesture('gesturechange', 6); expect(c.view().zoom).toBe(1.5);
  c.gesture('gestureend', 1);
  expect(c.finish).toHaveBeenCalledOnce();
});

it('does not apply WebKit scale a second time when a touchscreen also sends it', () => {
  const c = canvas();
  c.pointer('pointerdown', 1, 200);
  c.gesture('gesturestart', 1); // WebKit may start before the second touch is reported
  c.pointer('pointerdown', 2, 300); c.pointer('pointermove', 2, 350);
  c.gesture('gesturechange', 1.5); c.gesture('gestureend', 1.5);
  expect(c.view().zoom).toBe(0.75);
  c.pointer('pointercancel', 1, 200); c.pointer('pointercancel', 2, 350);
  expect(c.pinch.active()).toBe(false);
  expect(c.finish).toHaveBeenCalledOnce();
});
