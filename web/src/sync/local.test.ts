import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJSON, writeJSON } from '@/opfs/storage';
import { defaultSyncLedger, flushSyncPersistence, loadSyncLedger, saveSyncLedger } from './local';

vi.mock('@/opfs/storage', () => ({ readJSON: vi.fn(), writeJSON: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => vi.clearAllMocks());

describe('sync metadata persistence', () => {
  it('retains cached history titles across reloads', async () => {
    const historyTitles = { p: { name: 'Therapy', snapshotName: 'snapshot' } };
    vi.mocked(readJSON).mockResolvedValueOnce({ ...defaultSyncLedger(), historyTitles });
    expect((await loadSyncLedger()).historyTitles).toEqual(historyTitles);
  });
  it('keeps restoration labels after restarting and rejects invalid timestamps', async () => {
    vi.mocked(readJSON).mockResolvedValueOnce({ ...defaultSyncLedger(), restoredSnapshots: { snapshot: 123, invalid: 'yesterday', negative: -1 } });
    expect((await loadSyncLedger()).restoredSnapshots).toEqual({ snapshot: 123 });
  });
  it('serializes writes and waits for the final close before import can reload', async () => {
    let finish!: () => void;
    vi.mocked(writeJSON).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = saveSyncLedger({ ...defaultSyncLedger(), settingsEditedAt: 1 });
    const last = saveSyncLedger({ ...defaultSyncLedger(), settingsEditedAt: 2 });
    let drained = false;
    const drain = flushSyncPersistence().then(() => { drained = true; });
    await vi.waitFor(() => expect(writeJSON).toHaveBeenCalledTimes(1));
    expect(drained).toBe(false);
    finish();
    await Promise.all([first, last, drain]);
    expect(writeJSON).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeJSON).mock.calls[1]?.[1]).toMatchObject({ settingsEditedAt: 2 });
    expect(drained).toBe(true);
  });
});
