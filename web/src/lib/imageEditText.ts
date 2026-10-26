import type { TextEl } from './imageEditElements';

type Point = { x: number; y: number };
export const TEXT_BOX_DRAG_THRESHOLD = 4; // screen pixels, independent of zoom

/** Clicks create unwrapped point text; drags in any direction define a box. */
export function textPlacement(
  start: Point, end: Point, screenScale: number, fontSize: number,
): Pick<TextEl, 'x' | 'y' | 'width' | 'minHeight'> {
  if (Math.hypot(end.x - start.x, end.y - start.y) * screenScale < TEXT_BOX_DRAG_THRESHOLD) {
    return { x: start.x, y: start.y };
  }
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.max(fontSize, Math.abs(end.x - start.x)),
    minHeight: Math.max(fontSize, Math.abs(end.y - start.y)),
  };
}

/** Size to content without wrapping point text or widening paragraph boxes. */
export function resizeTextInput(input: HTMLTextAreaElement, boxed: boolean, minWidth: number, minHeight: number) {
  if (!boxed) {
    input.style.width = '1px';
    input.style.width = `${Math.max(minWidth, input.scrollWidth + 2)}px`;
  }
  input.style.height = '0px';
  input.style.height = `${Math.max(minHeight, input.scrollHeight)}px`;
}
