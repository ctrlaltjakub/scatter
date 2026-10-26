import { describe, it, expect, beforeEach } from 'vitest';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';

describe('useArrowAnchorsStore', () => {
  beforeEach(() => useArrowAnchorsStore.getState().clear());

  it('starts empty', () => {
    expect(useArrowAnchorsStore.getState().anchors).toEqual({});
  });
  it('setAnchors replaces the map (chain arrays per arrow)', () => {
    useArrowAnchorsStore.getState().setAnchors({
      'arrow-1': [{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }],
    });
    expect(useArrowAnchorsStore.getState().anchors).toEqual({
      'arrow-1': [{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }],
    });
    useArrowAnchorsStore.getState().setAnchors({
      'arrow-2': [{ x: 30, y: 40 }, { x: 60, y: 80 }],
    });
    expect(useArrowAnchorsStore.getState().anchors).toEqual({
      'arrow-2': [{ x: 30, y: 40 }, { x: 60, y: 80 }],
    });
  });
  it('clear empties the map', () => {
    useArrowAnchorsStore.getState().setAnchors({ a: [{ x: 1, y: 2 }] });
    useArrowAnchorsStore.getState().clear();
    expect(useArrowAnchorsStore.getState().anchors).toEqual({});
  });
});
