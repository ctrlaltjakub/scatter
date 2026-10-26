import { beforeEach, describe, expect, test, vi } from 'vitest';
import { useGraphStore } from './useGraphStore';

const CHIP_HIGHLIGHT = {
  parentNodeId: 'parent',
  childNodeId: 'child',
  arrowId: 'arrow',
  term: 'term',
  source: 'chip' as const,
};

beforeEach(() => {
  useGraphStore.setState({ highlight: null, highlightNonce: 0 });
});

describe('highlight event identity', () => {
  test('remains monotonic after the visible highlight is cleared', () => {
    useGraphStore.getState().flashHighlight(CHIP_HIGHLIGHT);
    const firstNonce = useGraphStore.getState().highlight!.nonce;
    useGraphStore.getState().clearHighlight();

    useGraphStore.getState().flashHighlight(CHIP_HIGHLIGHT);
    const secondNonce = useGraphStore.getState().highlight!.nonce;

    expect(secondNonce).toBeGreaterThan(firstNonce);
  });

  test('term-less relation flashes keep their nonce and clear only after 1.5 seconds', () => {
    vi.useFakeTimers();
    const relation = {
      parentNodeId: 'parent',
      childNodeId: 'child',
      arrowId: 'selected-text-arrow',
      source: 'chip' as const,
    };
    useGraphStore.getState().flashHighlight(relation);
    const first = useGraphStore.getState().highlight!;
    expect(first.term).toBeUndefined();

    vi.advanceTimersByTime(1_000);
    useGraphStore.getState().flashHighlight(relation);
    const second = useGraphStore.getState().highlight!;
    vi.advanceTimersByTime(500);
    expect(useGraphStore.getState().highlight?.nonce).toBe(second.nonce);

    vi.advanceTimersByTime(1_000);
    expect(useGraphStore.getState().highlight).toBeNull();
    expect(second.nonce).toBeGreaterThan(first.nonce);
    vi.useRealTimers();
  });
});
