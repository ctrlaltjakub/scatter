import { describe, expect, it } from 'vitest';
import { useGraphStore } from './useGraphStore';

describe('panel reveal camera ownership', () => {
  it('retains a full node fit when the chat outline opens during focus', () => {
    const graph = useGraphStore.getState();
    graph.requestPanTo('chat');
    const fit = useGraphStore.getState().panTo;
    graph.requestPanelReveal('chat');
    expect(useGraphStore.getState().panTo).toBe(fit);
  });
  it('retains a branch fit containing the panel owner', () => {
    const graph = useGraphStore.getState();
    graph.requestFitNodes(['parent', 'chat']);
    const fit = useGraphStore.getState().panTo;
    graph.requestPanelReveal('chat');
    expect(useGraphStore.getState().panTo).toBe(fit);
  });
  it('uses horizontal-only movement for a panel opened after focus settles', () => {
    const graph = useGraphStore.getState();
    graph.requestPanTo(null);
    graph.requestPanelReveal('chat');
    expect(useGraphStore.getState().panTo).toMatchObject({ id: 'chat', axis: 'x', announceArrival: false });
    graph.requestPanTo(null);
  });
});
