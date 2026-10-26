import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragHintStore } from './useDragHintStore';

describe('useDragHintStore', () => {
  beforeEach(() => useDragHintStore.setState({ hint: null }));

  it('shows one runtime drag hint and begins deleting it on clear', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(250);
    useDragHintStore.getState().show('child', 'DRAG AWAY TO PIN');
    expect(useDragHintStore.getState().hint).toMatchObject({
      nodeId: 'child', text: 'DRAG AWAY TO PIN', startedAt: 100, clearedAt: null,
    });

    useDragHintStore.getState().clear('child');
    expect(useDragHintStore.getState().hint?.clearedAt).toBe(250);
    vi.restoreAllMocks();
  });

  it('replaces the old node hint and ignores clears from another node', () => {
    useDragHintStore.getState().show('a', 'DRAG AWAY TO PIN');
    useDragHintStore.getState().show('b', 'SHAKE TO UNPIN');
    useDragHintStore.getState().clear('a');
    expect(useDragHintStore.getState().hint).toMatchObject({
      nodeId: 'b', text: 'SHAKE TO UNPIN', clearedAt: null,
    });
  });
});
