import { describe, it, expect, beforeEach } from 'vitest';
import { useActiveIdxStore } from './useActiveIdxStore';

beforeEach(() => {
  useActiveIdxStore.getState().replaceAll([]);
});

describe('useActiveIdxStore', () => {
  it('set stores an index; set(null) deletes the entry', () => {
    useActiveIdxStore.getState().set('n1', 3);
    expect(useActiveIdxStore.getState().byNodeId).toEqual({ n1: 3 });
    useActiveIdxStore.getState().set('n1', null);
    expect(useActiveIdxStore.getState().byNodeId).toEqual({});
  });

  it('replaceAll rebuilds the map wholesale — stale keys are gone', () => {
    useActiveIdxStore.getState().set('stale', 7);
    useActiveIdxStore.getState().replaceAll([['a', 0], ['b', 2]]);
    expect(useActiveIdxStore.getState().byNodeId).toEqual({ a: 0, b: 2 });
  });
});
