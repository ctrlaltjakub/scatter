import { describe, expect, it } from 'vitest';
import { resizeTextInput, textPlacement } from './imageEditText';
import { applyOp, commitGesture, emptyDoc, initHistory, redo, undo, type TextEl } from './imageEditElements';

describe('text tool placement', () => {
  it('creates point text for a click or small pointer jitter', () => {
    expect(textPlacement({ x: 100, y: 50 }, { x: 100, y: 50 }, 1, 24)).toEqual({ x: 100, y: 50 });
    expect(textPlacement({ x: 100, y: 50 }, { x: 102, y: 52 }, 1, 24)).toEqual({ x: 100, y: 50 });
  });
  it('uses screen pixels for the drag threshold at any zoom', () => {
    const start = { x: 0, y: 0 };
    expect(textPlacement(start, { x: 10, y: 0 }, 0.25, 24).width).toBeUndefined();
    expect(textPlacement(start, { x: 2, y: 0 }, 3, 24).width).toBe(24);
  });
  it.each([
    [{ x: 100, y: 50 }, { x: 300, y: 150 }],
    [{ x: 300, y: 150 }, { x: 100, y: 50 }],
    [{ x: 100, y: 150 }, { x: 300, y: 50 }],
    [{ x: 300, y: 50 }, { x: 100, y: 150 }],
  ])('normalizes a box dragged from %j to %j', (start, end) => {
    expect(textPlacement(start, end, 1, 24)).toEqual({ x: 100, y: 50, width: 200, minHeight: 100 });
  });
  it('keeps near-horizontal/vertical drags usable', () => {
    expect(textPlacement({ x: 0, y: 0 }, { x: 200, y: 0 }, 1, 24)).toMatchObject({ width: 200, minHeight: 24 });
    expect(textPlacement({ x: 0, y: 0 }, { x: 0, y: 200 }, 1, 24)).toMatchObject({ width: 24, minHeight: 200 });
  });
  it.each([false, true])('makes placement + typing one undo entry (boxed: %s)', (boxed) => {
    const el: TextEl = { id: 'text', tool: 'text', text: '', fontSize: 24, fontFamily: 'sans-serif', color: '#000',
      rotation: 0, scaleX: 1, scaleY: 1,
      ...textPlacement({ x: 10, y: 20 }, boxed ? { x: 210, y: 120 } : { x: 10, y: 20 }, 1, 24) };
    let h = applyOp(initHistory(emptyDoc()), { kind: 'addElement', el }, { transient: true });
    h = applyOp(h, { kind: 'updateElement', id: el.id, patch: { text: 'A paragraph of text' } }, { transient: true });
    h = commitGesture(h);
    expect(h.past).toHaveLength(1);
    const undone = undo(h);
    expect(undone.present.elements).toEqual([]);
    expect(redo(undone).present).toEqual(h.present);
  });
  it('does not add an undo step when a new empty text box is abandoned', () => {
    const el: TextEl = { id: 'text', tool: 'text', text: '', fontSize: 24, fontFamily: 'sans-serif', color: '#000',
      x: 10, y: 20, width: 200, minHeight: 100, rotation: 0, scaleX: 1, scaleY: 1 };
    let h = applyOp(initHistory(emptyDoc()), { kind: 'addElement', el }, { transient: true });
    h = applyOp(h, { kind: 'removeElements', ids: [el.id] }, { transient: true });
    expect(commitGesture(h).past).toHaveLength(0);
  });
});

describe('inline text sizing', () => {
  const field = () => {
    const input = document.createElement('textarea');
    Object.defineProperties(input, { scrollWidth: { value: 300 }, scrollHeight: { value: 72 } });
    return input;
  };
  it('grows point text horizontally rather than creating a wrap width', () => {
    const input = field();
    resizeTextInput(input, false, 80, 24);
    expect(input.style.width).toBe('302px');
    expect(input.style.height).toBe('72px');
  });
  it('preserves the box width and minimum height', () => {
    const input = field();
    input.style.width = '160px';
    resizeTextInput(input, true, 160, 120);
    expect(input.style.width).toBe('160px');
    expect(input.style.height).toBe('120px');
    resizeTextInput(input, true, 160, 24);
    expect(input.style.height).toBe('72px');
  });
});
