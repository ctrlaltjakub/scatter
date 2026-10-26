import { describe, expect, it } from 'vitest';
import {
  applyOp,
  canRedo,
  canUndo,
  commitGesture,
  emptyDoc,
  HISTORY_LIMIT,
  initHistory,
  isDirty,
  redo,
  undo,
  type AnnotEl,
  type EditorHistory,
  type StrokeEl,
} from './imageEditElements';

function stroke(id: string, points: number[] = [0, 0, 10, 10]): StrokeEl {
  return {
    id,
    tool: 'pen',
    points,
    strokeWidth: 4,
    color: '#111111',
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
  };
}

function fresh(): EditorHistory {
  return initHistory(emptyDoc());
}

describe('imageEditElements — ops', () => {
  it('adds, updates and removes elements', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') });
    expect(h.present.elements).toHaveLength(1);

    h = applyOp(h, { kind: 'updateElement', id: 'a', patch: { x: 50, strokeWidth: 8 } });
    const el = h.present.elements[0] as StrokeEl;
    expect(el.x).toBe(50);
    expect(el.strokeWidth).toBe(8);

    h = applyOp(h, { kind: 'removeElements', ids: ['a'] });
    expect(h.present.elements).toHaveLength(0);
  });

  it('updates adjustments and crop as partial patches', () => {
    let h = applyOp(fresh(), { kind: 'setAdjustments', patch: { warmth: 40 } });
    expect(h.present.adjustments).toMatchObject({ warmth: 40, hue: 0, saturation: 0, contrast: 0 });

    h = applyOp(h, { kind: 'setCrop', patch: { quarterTurns: 1 } });
    expect(h.present.crop.quarterTurns).toBe(1);
    expect(h.present.crop.rect).toBeNull();
  });

  it('updateElement leaves other elements untouched', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') });
    h = applyOp(h, { kind: 'addElement', el: stroke('b') });
    h = applyOp(h, { kind: 'updateElement', id: 'a', patch: { rotation: 45 } });
    expect(h.present.elements[0]!.rotation).toBe(45);
    expect(h.present.elements[1]!.rotation).toBe(0);
  });
});

describe('imageEditElements — undo history', () => {
  it('undo/redo round-trips committed ops', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') });
    h = applyOp(h, { kind: 'addElement', el: stroke('b') });

    h = undo(h);
    expect(h.present.elements.map((e: AnnotEl) => e.id)).toEqual(['a']);
    h = undo(h);
    expect(h.present.elements).toHaveLength(0);
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    h = redo(h);
    expect(h.present.elements.map((e: AnnotEl) => e.id)).toEqual(['a', 'b']);
    expect(canRedo(h)).toBe(false);
  });

  it('coalesces a whole transient gesture into ONE undo entry', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a', [0, 0]) }, { transient: true });
    for (let i = 1; i <= 20; i++) {
      h = applyOp(h, { kind: 'updateElement', id: 'a', patch: { points: [0, 0, i, i] } }, { transient: true });
    }
    expect(h.past).toHaveLength(0); // nothing committed yet
    expect(canUndo(h)).toBe(true);  // but the gesture is undoable

    h = commitGesture(h);
    expect(h.past).toHaveLength(1);

    h = undo(h);
    expect(h.present.elements).toHaveLength(0);
  });

  it('drops a gesture that ends with no net change', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') });
    const before = h;
    h = applyOp(h, { kind: 'updateElement', id: 'a', patch: { x: 5 } }, { transient: true });
    h = applyOp(h, { kind: 'updateElement', id: 'a', patch: { x: 0 } }, { transient: true });
    h = commitGesture(h);
    expect(h.past).toHaveLength(before.past.length + 0 + 1 - 1); // unchanged vs before
    expect(h.past).toEqual(before.past);
    expect(h.pendingBase).toBeNull();
  });

  it('clears the redo stack on any new op', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') });
    h = undo(h);
    expect(canRedo(h)).toBe(true);

    h = applyOp(h, { kind: 'addElement', el: stroke('b') });
    expect(canRedo(h)).toBe(false);

    // …and a transient op clears it too.
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = applyOp(h, { kind: 'addElement', el: stroke('c') }, { transient: true });
    expect(canRedo(h)).toBe(false);
  });

  it('a non-transient op auto-commits a still-open gesture first', () => {
    let h = applyOp(fresh(), { kind: 'addElement', el: stroke('a') }, { transient: true });
    h = applyOp(h, { kind: 'addElement', el: stroke('b') });
    expect(h.past).toHaveLength(2); // gesture commit + the op itself
    expect(h.pendingBase).toBeNull();
  });

  it('caps the past at HISTORY_LIMIT', () => {
    let h = fresh();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      h = applyOp(h, { kind: 'setAdjustments', patch: { warmth: i } });
    }
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(h.present.adjustments.warmth).toBe(HISTORY_LIMIT + 19);
  });
});

describe('imageEditElements — isDirty', () => {
  it('fresh history is clean; ops dirty it; undo back to baseline cleans it', () => {
    const baseline = emptyDoc();
    let h = initHistory(emptyDoc());
    expect(isDirty(h, baseline)).toBe(false);

    h = applyOp(h, { kind: 'setAdjustments', patch: { hue: 12 } });
    expect(isDirty(h, baseline)).toBe(true);

    h = undo(h);
    expect(isDirty(h, baseline)).toBe(false);
  });

  it('a mid-gesture change already counts as dirty', () => {
    const baseline = emptyDoc();
    let h = initHistory(emptyDoc());
    h = applyOp(h, { kind: 'addElement', el: stroke('a') }, { transient: true });
    expect(isDirty(h, baseline)).toBe(true);
  });
});
