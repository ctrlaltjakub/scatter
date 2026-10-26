import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectSyncLabelStore } from './useProjectSyncLabelStore';

beforeEach(() => {
  useProjectSyncLabelStore.setState({ entries: {} });
  vi.restoreAllMocks();
});

describe('useProjectSyncLabelStore', () => {
  it('preserves type-on timing while a hovered row moves', () => {
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValueOnce(100).mockReturnValueOnce(140);
    const store = useProjectSyncLabelStore.getState();
    store.show({ projectId: 'p', text: 'SYNCED', accent: '#123456', anchorViewportY: 40 });
    store.show({ projectId: 'p', text: 'SYNCED', accent: '#123456', anchorViewportY: 60 });
    expect(useProjectSyncLabelStore.getState().entries.p).toMatchObject({
      startedAt: 100,
      anchorViewportY: 60,
      clearedAt: null,
    });
  });

  it('backspaces the old project while the newly hovered one types on', () => {
    const clock = vi.spyOn(performance, 'now');
    clock.mockReturnValueOnce(100).mockReturnValueOnce(200).mockReturnValueOnce(300);
    const store = useProjectSyncLabelStore.getState();
    store.show({ projectId: 'one', text: 'SYNCED', accent: null, anchorViewportY: 40 });
    store.show({ projectId: 'two', text: 'SYNCING', accent: null, anchorViewportY: 80 });
    expect(useProjectSyncLabelStore.getState().entries.one?.clearedAt).toBe(200);
    expect(useProjectSyncLabelStore.getState().entries.two).toMatchObject({
      startedAt: 200,
      clearedAt: null,
    });
    store.clear('two');
    expect(useProjectSyncLabelStore.getState().entries.two?.clearedAt).toBe(300);
  });
});
