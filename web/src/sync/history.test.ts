import { describe, expect, it, vi } from 'vitest';
import { createBlankProject } from '@/store/useGraphStore';
import { encodeEnvelope, projectSnapshotName } from './codec';
import { historyProjectGroups, historyProjectLabel, resolveHistoryTitles } from './history';
import type { SyncHistoryEntry } from '@/store/useSyncStore';
import type { ProjectSnapshotEnvelope, RemoteObject, SyncProvider, SyncProviderKind } from './types';

it('groups by the newest snapshot, keeps restored local projects active, and limits deleted projects to five', () => {
  const entry = (editedAt: number, deleted: boolean): SyncHistoryEntry => ({
    object: { id: String(editedAt), name: String(editedAt) }, editedAt, deleted });
  const history = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`deleted-${index}`, [entry(index + 1, true)]]));
  history.restored = [entry(20, true), entry(30, false)];
  history.local = [entry(40, true)];
  const groups = historyProjectGroups(history, new Set(['local']));
  expect(groups.active).toEqual(['restored', 'local']);
  expect(groups.deleted).toEqual(['deleted-7', 'deleted-6', 'deleted-5', 'deleted-4', 'deleted-3']);
  expect(Object.keys(history)).toHaveLength(10);
});

async function fixture(kind: SyncProviderKind, versions: Array<Partial<ProjectSnapshotEnvelope>>) {
  const blobs = new Map<string, Blob>();
  const objects: RemoteObject[] = [];
  for (const [index, version] of versions.entries()) {
    const snapshot: ProjectSnapshotEnvelope = {
      format: 'scatter-sync', formatVersion: 1, kind: 'project', projectId: 'project',
      editedAt: index + 1, sequence: index, deviceId: 'test', deviceName: 'Test',
      hash: 'abcdef0123456789abcdef0123456789', deleted: false, assetIds: [],
      project: { ...createBlankProject('Psychotherapy', ''), id: 'project' }, ...version,
    };
    const name = projectSnapshotName(snapshot);
    blobs.set(name, await encodeEnvelope(snapshot));
    objects.push({ id: name, name });
  }
  const provider: SyncProvider = {
    kind, test: vi.fn(), list: vi.fn(), write: vi.fn(), remove: vi.fn(),
    read: vi.fn(async (object) => blobs.get(object.name)!),
  };
  return { provider, objects, projects: new Map([['project', objects]]) };
}

describe.each(['google-drive', 'webdav'] as const)('%s history titles', (kind) => {
  it('recovers a deleted legacy project title from the last retained content', async () => {
    const { provider, projects } = await fixture(kind, [{}, { deleted: true, project: undefined }]);
    const titles = await resolveHistoryTitles(provider, projects, {}, new Map());
    expect(titles.project?.name).toBe('Psychotherapy');
    expect(provider.read).toHaveBeenCalledTimes(2);
    expect(provider.write).not.toHaveBeenCalled();
    expect(provider.remove).not.toHaveBeenCalled();
    expect(historyProjectLabel(titles.project?.name, true)).toBe('Psychotherapy (deleted)');
    await resolveHistoryTitles(provider, projects, titles, new Map());
    expect(provider.read).toHaveBeenCalledTimes(2);
  });

  it('reads the name directly from new deletion snapshots without content', async () => {
    const { provider, projects } = await fixture(kind, [{ deleted: true, project: undefined, projectName: 'The Glass Bead Game' }]);
    const titles = await resolveHistoryTitles(provider, projects, {}, new Map());
    expect(titles.project?.name).toBe('The Glass Bead Game');
    expect(provider.read).toHaveBeenCalledTimes(1);
  });

  it('uses current local names without downloading project content', async () => {
    const { provider, projects } = await fixture(kind, [{}]);
    const titles = await resolveHistoryTitles(provider, projects, {}, new Map([['project', 'Renamed locally']]));
    expect(titles.project?.name).toBe('Renamed locally');
    expect(provider.read).not.toHaveBeenCalled();
  });

  it('refreshes cached names when a new remote snapshot arrives', async () => {
    const { provider, projects } = await fixture(kind, [{ projectName: 'Renamed remotely' }]);
    const titles = await resolveHistoryTitles(provider, projects,
      { project: { name: 'Old title', snapshotName: 'older-snapshot' } }, new Map());
    expect(titles.project?.name).toBe('Renamed remotely');
    expect(historyProjectLabel(titles.project?.name, false)).toBe('Renamed remotely');
  });

  it('caches unnamed old tombstones and uses an honest fallback without IDs', async () => {
    const { provider, projects } = await fixture(kind, [{ deleted: true, project: undefined }]);
    const titles = await resolveHistoryTitles(provider, projects, {}, new Map());
    expect(historyProjectLabel(titles.project?.name, true)).toBe('Untitled project (deleted)');
    expect(historyProjectLabel(undefined, false)).toBe('Untitled project');
    await resolveHistoryTitles(provider, projects, titles, new Map());
    expect(provider.read).toHaveBeenCalledTimes(1);
  });

  it('retries a failed title read without failing the sync operation', async () => {
    const { provider, projects } = await fixture(kind, [{}]);
    vi.mocked(provider.read).mockRejectedValueOnce(new Error('Offline'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const titles = await resolveHistoryTitles(provider, projects, {}, new Map());
    expect(titles.project).toBeUndefined();
    expect((await resolveHistoryTitles(provider, projects, titles, new Map())).project?.name).toBe('Psychotherapy');
    warning.mockRestore();
  });
});
