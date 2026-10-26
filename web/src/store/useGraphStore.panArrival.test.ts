import { beforeEach, describe, expect, test } from 'vitest';
import { useGraphStore } from './useGraphStore';

beforeEach(() => {
  useGraphStore.setState({ panTo: null, panArrival: null, panRequestNonce: 0 });
});

describe('camera arrival signal', () => {
  test('successful completion emits arrival and atomically clears panTo', () => {
    useGraphStore.getState().requestPanTo('n0');
    const requestId = useGraphStore.getState().panTo!.requestId;
    useGraphStore.getState().completePanTo(requestId);
    expect(useGraphStore.getState().panArrival).toEqual({ nodeId: 'n0', requestId, nonce: 1 });
    expect(useGraphStore.getState().panTo).toBeNull();
  });

  test('plain cancellation clears panTo without emitting arrival', () => {
    useGraphStore.getState().requestPanTo('n0');
    useGraphStore.getState().requestPanTo(null);
    expect(useGraphStore.getState().panArrival).toBeNull();
  });

  test('stale completion cannot clear a newer different-target request', () => {
    useGraphStore.getState().requestPanTo('n0');
    const staleRequestId = useGraphStore.getState().panTo!.requestId;
    useGraphStore.getState().requestPanTo('n1');
    const current = useGraphStore.getState().panTo;
    useGraphStore.getState().completePanTo(staleRequestId);
    expect(useGraphStore.getState().panTo).toEqual(current);
    expect(useGraphStore.getState().panArrival).toBeNull();
  });

  test('stale completion cannot clear a newer same-target request', () => {
    useGraphStore.getState().requestPanTo('n0');
    const staleRequestId = useGraphStore.getState().panTo!.requestId;
    useGraphStore.getState().requestPanTo('n0');
    const current = useGraphStore.getState().panTo;
    useGraphStore.getState().completePanTo(staleRequestId);
    expect(useGraphStore.getState().panTo).toEqual(current);
    expect(useGraphStore.getState().panArrival).toBeNull();
  });

  test('multi-node fitting is repeatable and completes without a node-arrival signal', () => {
    useGraphStore.getState().requestFitNodes(['a', 'b', 'a']);
    const first = useGraphStore.getState().panTo!;
    expect(first).toMatchObject({ kind: 'nodes', ids: ['a', 'b'] });

    useGraphStore.getState().completePanTo(first.requestId);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useGraphStore.getState().panArrival).toBeNull();

    useGraphStore.getState().requestFitNodes(['a', 'b']);
    expect(useGraphStore.getState().panTo!.requestId).toBeGreaterThan(first.requestId);
  });

  test('an empty multi-node fit cancels the current request', () => {
    useGraphStore.getState().requestPanTo('n0');
    useGraphStore.getState().requestFitNodes([]);
    expect(useGraphStore.getState().panTo).toBeNull();
  });

  test('a panel reveal requests horizontal-only motion and emits no node arrival', () => {
    useGraphStore.getState().requestPanelReveal('n0');
    const request = useGraphStore.getState().panTo!;
    expect(request).toMatchObject({
      kind: 'node',
      id: 'n0',
      axis: 'x',
      announceArrival: false,
    });
    useGraphStore.getState().completePanTo(request.requestId);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useGraphStore.getState().panArrival).toBeNull();
  });
});
