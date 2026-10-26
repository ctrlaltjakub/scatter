import { afterEach, describe, expect, it } from 'vitest';
import { useNodeTextSelectionStore } from './useNodeTextSelectionStore';

afterEach(() => useNodeTextSelectionStore.getState().clear());

describe('useNodeTextSelectionStore', () => {
  it('stores and clears one runtime-only exact selection', () => {
    const selection = {
      nodeId: 'n1', versionIndex: 1, sourceBody: 'alpha beta',
      start: 6, end: 10, text: 'beta',
    };
    useNodeTextSelectionStore.getState().set(selection);
    expect(useNodeTextSelectionStore.getState().selection).toEqual(selection);
    useNodeTextSelectionStore.getState().clear();
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
  });
});
