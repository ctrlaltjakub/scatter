import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJSON, writeJSON } from '@/opfs/storage';
import { assetObjectName, preferencesSnapshotName } from './codec';
import { openChangeIndex, SYNC_INDEX_MAX_BYTES, SYNC_INDEX_MAX_OBJECTS } from './changeIndex';
import type { RemoteChanges, RemoteObject, SyncProvider } from './types';

vi.mock('@/opfs/storage', () => ({ readJSON: vi.fn(), writeJSON: vi.fn() }));
let saved: unknown;
const object = (id: string): RemoteObject => ({ id, name: assetObjectName('p', id) });
function provider() {
  return {
    kind: 'webdav', indexScope: vi.fn(async () => 'account-1'), test: vi.fn(),
    list: vi.fn(async () => [] as RemoteObject[]), read: vi.fn(),
    write: vi.fn(async (name: string) => ({ id: name, name })), remove: vi.fn(),
    changes: vi.fn(async (_cursor?: string): Promise<RemoteChanges> => ({
      reset: true, cursor: '1', objects: [object('a')], removedIds: [],
    })),
  } satisfies SyncProvider;
}
beforeEach(() => {
  vi.clearAllMocks(); saved = null;
  vi.mocked(readJSON).mockImplementation(async () => structuredClone(saved) as never);
  vi.mocked(writeJSON).mockImplementation(async (_path, value) => { saved = structuredClone(value); });
});

describe('bounded sync change index', () => {
  it('replaces changed metadata and drops deleted files instead of appending a log', async () => {
    const source = provider();
    await (await openChangeIndex(source)).commit();
    source.changes.mockResolvedValue({ reset: false, cursor: '2', objects: [object('b')], removedIds: ['a'] });
    const next = await openChangeIndex(source);
    expect(source.changes).toHaveBeenLastCalledWith('1');
    expect(next.objects).toEqual([object('b')]);
    await next.commit();
    source.changes.mockResolvedValue({ reset: false, cursor: '3', objects: [{ ...object('b'), size: 12 }], removedIds: [] });
    const third = await openChangeIndex(source);
    expect(third.objects).toEqual([{ ...object('b'), size: 12 }]);
    expect(source.read).not.toHaveBeenCalled();
    expect(source.list).not.toHaveBeenCalled();
  });

  it('commits successful writes/removals with the cursor and prunes obsolete checkpoints', async () => {
    const source = provider();
    const name = preferencesSnapshotName(1, 1, 'device', 'hash');
    const first = await openChangeIndex(source);
    await first.provider.write(name, new Blob(['data']));
    first.remember('preferences', 'local-1', name);
    first.remember('project:gone', 'local', 'remote');
    await first.commit();
    expect(saved).toMatchObject({ checks: { preferences: { local: 'local-1', remote: name } } });
    expect((saved as { checks: object }).checks).not.toHaveProperty('project:gone');
    source.changes.mockResolvedValue({ reset: false, cursor: '2', objects: [], removedIds: [] });
    const next = await openChangeIndex(source);
    expect(next.matches('preferences', 'local-1', name)).toBe(true);
    await next.provider.remove({ id: name, name });
    await next.commit();
    expect((saved as { checks: object }).checks).toEqual({});
  });

  it('does not advance the cursor for an interrupted pass, so changes can be replayed', async () => {
    const source = provider();
    await (await openChangeIndex(source)).commit();
    source.changes.mockResolvedValue({ reset: false, cursor: '2', objects: [object('b')], removedIds: [] });
    const interrupted = await openChangeIndex(source);
    await interrupted.provider.write(assetObjectName('p', 'partial'), new Blob());
    // No commit: a later operation failed or the browser closed.
    const retry = await openChangeIndex(source);
    expect(source.changes).toHaveBeenLastCalledWith('1');
    expect(retry.objects.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it.each(['corrupt', 'other-account', 'rejected-cursor'])('rebuilds safely for %s', async (scenario) => {
    const source = provider();
    await (await openChangeIndex(source)).commit();
    if (scenario === 'corrupt') saved = { schemaVersion: 1, objects: 'bad' };
    if (scenario === 'other-account') source.indexScope.mockResolvedValue('account-2');
    if (scenario === 'rejected-cursor') source.changes.mockResolvedValue({
      reset: true, cursor: 'fresh', objects: [object('new')], removedIds: [],
    });
    const next = await openChangeIndex(source);
    expect(source.changes).toHaveBeenLastCalledWith(scenario === 'rejected-cursor' ? '1' : undefined);
    if (scenario === 'rejected-cursor') expect(next.objects).toEqual([object('new')]);
  });

  it.each(['count', 'bytes'])('drops an oversized %s cache including its cursor, never truncates it', async (limit) => {
    const source = provider();
    const objects = limit === 'count'
      ? Array.from({ length: SYNC_INDEX_MAX_OBJECTS + 1 }, (_, i) => object(String(i)))
      : [{ ...object('large'), etag: 'x'.repeat(SYNC_INDEX_MAX_BYTES) }];
    source.changes.mockResolvedValue({ reset: true, cursor: 'large', objects, removedIds: [] });
    const index = await openChangeIndex(source);
    expect(index.objects).toHaveLength(objects.length);
    await index.commit();
    expect(saved).toBeNull();
    await openChangeIndex(source);
    expect(source.changes).toHaveBeenLastCalledWith(undefined);
  });

  it('retains local checkpoints for full-listing servers and validates against fresh remote names', async () => {
    const source = provider();
    const name = preferencesSnapshotName(1, 1, 'device', 'hash');
    source.changes.mockResolvedValue({ reset: true, cursor: 'listing', objects: [{ id: name, name }], removedIds: [] });
    const first = await openChangeIndex(source);
    first.remember('preferences', 'local', name);
    await first.commit();
    const next = await openChangeIndex(source);
    expect(next.matches('preferences', 'local', name)).toBe(true);
    expect(next.matches('preferences', 'local', 'new-version')).toBe(false);
  });

  it('rejects a delta without a complete baseline', async () => {
    const source = provider();
    source.changes.mockResolvedValue({ reset: false, cursor: '2', objects: [], removedIds: [] });
    await expect(openChangeIndex(source)).rejects.toThrow('complete initial listing');
  });
});
