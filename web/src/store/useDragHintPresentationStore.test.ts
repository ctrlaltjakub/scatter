import { beforeEach, describe, expect, it } from 'vitest';
import { STATUS_DELETE_MS_PER_CHAR } from '@/lib/asciiAura/statusText';
import {
  useDragHintPresentationStore,
  type DesiredDragHintPresentation,
} from './useDragHintPresentationStore';

const desired = (
  nodeId = 'node',
  x = 100,
): DesiredDragHintPresentation => ({
  nodeId,
  text: 'DRAG AWAY TO PIN',
  layout: {
    rect: { x, y: 50, w: 90, h: 20 },
    cells: [{ col: 10, row: 5, glyphIndex: 17 }],
  },
});

beforeEach(() => useDragHintPresentationStore.setState({ entry: null }));

describe('useDragHintPresentationStore.reconcile', () => {
  it('types on a newly placeable hint', () => {
    useDragHintPresentationStore.getState().reconcile(desired(), 1000);
    expect(useDragHintPresentationStore.getState().entry).toMatchObject({
      nodeId: 'node', startedAt: 1000, clearedAt: null,
    });
  });

  it('reflows a continuously visible hint without restarting type-on', () => {
    const state = useDragHintPresentationStore.getState();
    state.reconcile(desired('node', 100), 1000);
    state.reconcile(desired('node', 140), 1200);
    expect(useDragHintPresentationStore.getState().entry).toMatchObject({
      startedAt: 1000,
      layout: { rect: { x: 140 } },
    });
  });

  it('keeps the last layout while reverse deletion runs', () => {
    const state = useDragHintPresentationStore.getState();
    state.reconcile(desired('node', 100), 1000);
    state.reconcile(null, 1500);
    expect(useDragHintPresentationStore.getState().entry).toMatchObject({
      clearedAt: 1500,
      layout: { rect: { x: 100 } },
    });
  });

  it('restarts type-on when placement returns during deletion', () => {
    const state = useDragHintPresentationStore.getState();
    state.reconcile(desired(), 1000);
    state.reconcile(null, 1500);
    state.reconcile(desired('node', 160), 1510);
    expect(useDragHintPresentationStore.getState().entry).toMatchObject({
      startedAt: 1510,
      clearedAt: null,
      layout: { rect: { x: 160 } },
    });
  });

  it('prunes the presentation after reverse deletion finishes', () => {
    const state = useDragHintPresentationStore.getState();
    state.reconcile(desired(), 1000);
    state.reconcile(null, 1500);
    state.reconcile(null, 1500 + 13 * STATUS_DELETE_MS_PER_CHAR + 100);
    expect(useDragHintPresentationStore.getState().entry).toBeNull();
  });

  it('restarts type-on when the logical node or message changes', () => {
    const state = useDragHintPresentationStore.getState();
    state.reconcile(desired('first'), 1000);
    state.reconcile({ ...desired('second'), text: 'SHAKE TO UNPIN' }, 1200);
    expect(useDragHintPresentationStore.getState().entry).toMatchObject({
      nodeId: 'second', text: 'SHAKE TO UNPIN', startedAt: 1200,
    });
  });
});
