import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isCharShown,
  STATUS_DELETE_MS_PER_CHAR,
  STATUS_REVEAL_MS_PER_CHAR,
} from './statusText';
import {
  reconcileDragHintPresentationFrame,
  subscribeDragHintRendererInvalidation,
} from './dragHintRuntime';
import { useDragHintPresentationStore } from '@/store/useDragHintPresentationStore';
import { useDragHintStore } from '@/store/useDragHintStore';

const desired = {
  nodeId: 'node',
  text: 'DRAG AWAY TO PIN' as const,
  layout: {
    rect: { x: 360, y: 90, w: 90, h: 20 },
    cells: Array.from({ length: 13 }, (_, index) => ({
      col: 36 + index,
      row: 9,
      glyphIndex: 20 + index,
    })),
  },
};

beforeEach(() => {
  useDragHintStore.setState({ hint: null });
  useDragHintPresentationStore.setState({ entry: null });
});

afterEach(() => vi.restoreAllMocks());

describe('drag-hint renderer lifecycle', () => {
  it('invalidates a cooled renderer on logical clear so deletion can finish and prune', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    useDragHintStore.getState().show('node', desired.text);
    reconcileDragHintPresentationFrame(desired, useDragHintStore.getState().hint, 0);

    const fullyTypedAt = desired.layout.cells.length * STATUS_REVEAL_MS_PER_CHAR + 1;
    const presented = useDragHintPresentationStore.getState().entry!;
    expect(desired.layout.cells.every((_, index) => isCharShown(
      index,
      desired.layout.cells.length,
      presented.startedAt,
      presented.clearedAt,
      fullyTypedAt,
    ))).toBe(true);

    let dirty = false;
    const geometryOrPhysicsActive = false;
    const unsubscribe = subscribeDragHintRendererInvalidation(() => { dirty = true; });
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    useDragHintStore.getState().clear('node');

    expect(geometryOrPhysicsActive).toBe(false);
    expect(dirty).toBe(true);

    const cleared = useDragHintStore.getState().hint!;
    reconcileDragHintPresentationFrame(null, cleared, 1000);
    expect(useDragHintPresentationStore.getState().entry?.clearedAt).toBe(1000);

    const fullyDeletedAt = 1000
      + desired.layout.cells.length * STATUS_DELETE_MS_PER_CHAR
      + 61;
    reconcileDragHintPresentationFrame(
      null,
      useDragHintStore.getState().hint,
      fullyDeletedAt,
    );
    expect(useDragHintPresentationStore.getState().entry).toBeNull();
    expect(useDragHintStore.getState().hint).toBeNull();

    unsubscribe();
    dirty = false;
    useDragHintStore.getState().show('node', desired.text);
    expect(dirty).toBe(false);
  });
});
