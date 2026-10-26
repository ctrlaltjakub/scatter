import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectMeta, ScatterNode, Settings } from '@/store/types';
import { DEFAULT_SETTINGS } from '@/store/types';
import type { ProjectViewEnvelope, RemoteChanges, RemoteObject, SyncSnapshotEnvelope } from './types';
import { readJSON, writeJSON } from '@/opfs/storage';
import { loadProjectById, saveProjectFile } from '@/opfs/projectsIO';
import { flushProjectPersistence, releaseProjectPersistence } from '@/store/projectPersistence';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSyncStore, type SyncHistoryEntry } from '@/store/useSyncStore';
import { applySyncedScatter, applySyncedProjectOrder } from '@/store/projectActions';
import { defaultSyncConfig, defaultSyncLedger, flushSyncPersistence } from './local';
import { assetObjectName, decodeEnvelope, encodeEnvelope, parseSnapshotName, preferencesSnapshotName, projectSnapshotName, projectViewName, sha256Hex } from './codec';
import { deleteSyncHistoryEntry, initializeSyncCoordinator, requestSyncNow, resolveRemoteProjectUpdate, restorePreferencesHistory, restoreProjectHistory, restoreSetupFromSync, scheduleSync, shutdownSyncCoordinator, stopScheduledSync } from './coordinator';
import * as googleDrive from './providers/googleDrive';
import { applySyncedPreferences, createSyncedPreferences } from './preferences';

vi.mock('@/store/useGraphStore', async () => {
  const { create } = await import('zustand');
  return { useGraphStore: create(() => ({ project: null, projectList: [], activeProjectId: null })) };
});
vi.mock('@/store/useSettingsStore', async () => {
  const { create } = await import('zustand');
  return { useSettingsStore: create(() => ({ providers: [], sentencePerLine: false })) };
});
vi.mock('@/opfs/storage', () => ({ readJSON: vi.fn(), writeJSON: vi.fn() }));
vi.mock('@/opfs/projectsIO', () => ({ loadProjectById: vi.fn(), saveProjectFile: vi.fn() }));
vi.mock('@/opfs/assetsIO', () => ({ loadAsset: vi.fn(), saveAsset: vi.fn() }));
vi.mock('@/opfs/sourceAssetsIO', () => ({ loadSourceAsset: vi.fn(), saveSourceAsset: vi.fn() }));
vi.mock('@/store/projectPersistence', () => ({ flushProjectPersistence: vi.fn(async () => undefined),
  releaseProjectPersistence: vi.fn(async () => undefined), adoptProjectPersistenceMirror: vi.fn() }));
vi.mock('@/store/foldRuntime', async (original) => {
  const actual = await original<typeof import('@/store/foldRuntime')>();
  return { ...actual, foldRuntimeIntoProject: (value: Project) => actual.withPersistedViewport(value) };
});
const background = vi.hoisted(() => ({ projects: new Map<string, Project>() }));
vi.mock('@/store/bgGen', () => ({
  projectHasGenerating: (value: Project) => Object.values(value.nodes).some((node) => node.generating),
  getGenProject: (id: string) => useGraphStore.getState().project?.id === id
    ? useGraphStore.getState().project : background.projects.get(id) ?? null,
}));
vi.mock('@/store/projectActions', () => ({ applySyncedScatter: vi.fn(), deleteScatter: vi.fn(), applySyncedProjectOrder: vi.fn() }));
vi.mock('@/sync/preferences', () => ({
  createSyncedPreferences: vi.fn((settings: Settings, projectOrder: string[]) => ({ settings: { providers: [], sentencePerLine: settings.sentencePerLine }, projectOrder })),
  applySyncedPreferences: vi.fn(),
}));
vi.mock('@/lib/networkStatus', () => ({ isBrowserOnline: () => true, subscribeNetworkStatus: () => () => undefined }));
const remote = vi.hoisted(() => ({
  changes: vi.fn(), list: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn(),
}));
vi.mock('./providers/webdav', () => ({
  WebDavSyncProvider: class {
    kind = 'webdav';
    indexScope = async () => 'test-account';
    test = vi.fn();
    changes = remote.changes; list = remote.list; read = remote.read; write = remote.write; remove = remote.remove;
  },
}));

const storage = new Map<string, unknown>();
const projects = new Map<string, Project>();
const cloud = new Map<string, { object: RemoteObject; data: Blob }>();
let delta: RemoteObject[] = [];
let removed: string[] = [];
let cursor = 0;
function project(id: string, updatedAt = 10): Project {
  return { id, name: `Project ${id}`, createdAt: 1, updatedAt, nodes: {}, arrows: {}, groups: {}, rootNodeId: '', viewport: { x: 0, y: 0, zoom: 1 }, selection: [] };
}
function metadata(value: Project): ProjectMeta {
  return { id: value.id, name: value.name, updatedAt: value.updatedAt, createdAt: value.createdAt };
}
function setProjects(count: number, active = false) {
  for (let i = 0; i < count; i++) projects.set(`p${i}`, project(`p${i}`));
  useGraphStore.setState({
    projectList: [...projects.values()].map(metadata),
    activeProjectId: active ? 'p0' : null, project: active ? projects.get('p0')! : null,
  });
}
async function settle() {
  await requestSyncNow();
  // Initial metadata normalization can require a conservative second check.
  await requestSyncNow();
  await flushSyncPersistence();
  vi.mocked(loadProjectById).mockClear();
  vi.mocked(flushProjectPersistence).mockClear();
  vi.mocked(createSyncedPreferences).mockClear();
  Object.values(remote).forEach((mock) => mock.mockClear());
}
async function addCloudProject(value: Project) {
  const envelope: SyncSnapshotEnvelope = {
    format: 'scatter-sync', formatVersion: 1, kind: 'project', projectId: value.id,
    editedAt: value.updatedAt, sequence: 1, deviceId: 'other', deviceName: 'Other',
    hash: await sha256Hex(JSON.stringify(value)), deleted: false, assetIds: [], project: value,
  };
  const name = projectSnapshotName(envelope);
  const object = { id: name, name };
  cloud.set(name, { object, data: await encodeEnvelope(envelope) });
  delta.push(object);
}

async function addCloudView(projectId: string, viewport: Project['viewport'], editedAt: number) {
  const value: ProjectViewEnvelope = { format: 'scatter-sync', formatVersion: 1, kind: 'view',
    projectId, viewport, editedAt, sequence: 1, deviceId: 'other' };
  const name = projectViewName(value);
  const object = { id: name, name };
  cloud.set(name, { object, data: await encodeEnvelope(value) });
  delta.push(object);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('crypto', webcrypto);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  storage.clear(); projects.clear(); cloud.clear(); delta = []; removed = []; cursor = 0;
  background.projects.clear();
  useGraphStore.setState({ project: null, projectList: [], activeProjectId: null });
  useLiveViewportStore.getState().clear();
  useSettingsStore.setState({ providers: [], sentencePerLine: false });
  useSyncStore.setState({ hydrated: true, config: {
    ...defaultSyncConfig(), enabled: true, provider: 'webdav',
    webdav: { baseUrl: 'https://example.test', username: 'test', appPassword: 'test', folder: 'sync' },
  }, ledger: defaultSyncLedger(), remoteUpdate: null, error: null, running: false, projectHistory: {}, preferenceHistory: [] });
  vi.mocked(readJSON).mockImplementation(async (path) => structuredClone(storage.get(path) ?? null) as never);
  vi.mocked(writeJSON).mockImplementation(async (path, data) => { storage.set(path, structuredClone(data)); });
  vi.mocked(loadProjectById).mockImplementation(async (id) => projects.get(id) ?? null);
  vi.mocked(saveProjectFile).mockImplementation(async (value) => { projects.set(value.id, value); });
  vi.mocked(applySyncedScatter).mockImplementation(async (value) => {
    projects.set(value.id, value);
    useGraphStore.setState({ projectList: [...projects.values()].map(metadata) });
  });
  remote.changes.mockImplementation(async (previous?: string): Promise<RemoteChanges> => {
    const result = { reset: !previous, cursor: String(++cursor), objects: previous ? delta : [...cloud.values()].map((entry) => entry.object), removedIds: removed };
    delta = []; removed = [];
    return result;
  });
  remote.list.mockImplementation(async () => [...cloud.values()].map((entry) => entry.object));
  remote.read.mockImplementation(async (object: RemoteObject) => cloud.get(object.id)!.data);
  remote.write.mockImplementation(async (name: string, data: Blob) => {
    const object = { id: name, name, modifiedAt: Date.now() };
    cloud.set(name, { object, data }); delta.push(object);
    return object;
  });
  remote.remove.mockImplementation(async (object: RemoteObject) => { cloud.delete(object.id); removed.push(object.id); });
});
afterEach(async () => {
  shutdownSyncCoordinator();
  await flushSyncPersistence();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each(['webdav', 'google-drive'] as const)('%s history restoration', provider => {
  beforeEach(() => {
    if (provider === 'google-drive') {
      vi.spyOn(googleDrive, 'ensureGoogleDriveAccessToken').mockResolvedValue();
      const prototype = googleDrive.GoogleDriveSyncProvider.prototype;
      vi.spyOn(prototype, 'indexScope').mockResolvedValue('test-account');
      vi.spyOn(prototype, 'changes').mockImplementation(remote.changes);
      vi.spyOn(prototype, 'list').mockImplementation(remote.list);
      vi.spyOn(prototype, 'read').mockImplementation(remote.read);
      vi.spyOn(prototype, 'write').mockImplementation(remote.write);
      vi.spyOn(prototype, 'remove').mockImplementation(remote.remove);
    }
    useSyncStore.setState(state => ({ config: { ...state.config, provider, enabled: false } }));
  });

  it.each([false, true])('immediately publishes restored project history with automatic syncing %s, without syncing other edits', async enabled => {
    useSyncStore.setState(state => ({ config: { ...state.config, enabled } }));
    setProjects(2, true);
    const unrelated = projects.get('p1');
    await addCloudProject({ ...project('p0', 1), name: 'Older project' });
    await addCloudProject(project('p0', Date.now() + 60_000));
    const entries = [...cloud.values()].map(({ object }) => ({
      object, projectId: 'p0', editedAt: parseSnapshotName(object.name)!.editedAt!, deleted: false,
    }));
    useSyncStore.setState(state => ({
      projectHistory: { p0: [...entries].reverse() },
      ledger: { ...state.ledger, projects: { p1: { projectId: 'p1', localEditedAt: 10, status: 'pending' } } },
    }));

    await restoreProjectHistory(entries[0]!);

    const history = useSyncStore.getState().projectHistory.p0!;
    expect(history).toHaveLength(3);
    expect(await decodeEnvelope(cloud.get(history[0]!.object.id)!.data)).toMatchObject({
      kind: 'project', project: { id: 'p0', name: 'Older project' },
    });
    expect(history[0]!.editedAt).toBeGreaterThan(entries[1]!.editedAt);
    expect(history[0]!.restoredFrom).toBe(1);
    expect(useSyncStore.getState().config.enabled).toBe(enabled);
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(parseSnapshotName(remote.write.mock.calls[0]![0])).toMatchObject({ kind: 'project', projectId: 'p0' });
    expect(projects.get('p1')).toBe(unrelated);
    expect(useSyncStore.getState().ledger.projects.p1?.status).toBe('pending');
    expect(remote.changes).not.toHaveBeenCalled();
    expect(applySyncedPreferences).not.toHaveBeenCalled();
    await expect(deleteSyncHistoryEntry(history[0]!)).rejects.toThrow('latest snapshot is required');
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('uploads restored settings with automatic syncing %s, without syncing projects', async enabled => {
    useSyncStore.setState(state => ({ config: { ...state.config, enabled } }));
    setProjects(2, true);
    const active = useGraphStore.getState().project;
    const entries: SyncHistoryEntry[] = [];
    for (const [editedAt, sentencePerLine] of [[1, true], [Date.now() + 60_000, false]] as const) {
      const preferences = { settings: { ...DEFAULT_SETTINGS, sentencePerLine }, projectOrder: ['p0', 'p1'] };
      const hash = await sha256Hex(JSON.stringify(preferences));
      const name = preferencesSnapshotName(editedAt, 1, 'other', hash);
      const object = { id: name, name };
      cloud.set(name, { object, data: await encodeEnvelope({ format: 'scatter-sync', formatVersion: 1,
        kind: 'preferences', editedAt, sequence: 1, deviceId: 'other', deviceName: 'Other', hash, preferences }) });
      entries.push({ object, editedAt });
    }
    useSyncStore.setState({ preferenceHistory: [...entries].reverse() });
    vi.mocked(applySyncedPreferences).mockImplementationOnce(async value => {
      useSettingsStore.setState({ sentencePerLine: value.settings.sentencePerLine });
    });

    await restorePreferencesHistory(entries[0]!);

    const history = useSyncStore.getState().preferenceHistory;
    expect(history).toHaveLength(3);
    expect(await decodeEnvelope(cloud.get(history[0]!.object.id)!.data)).toMatchObject({
      kind: 'preferences', preferences: { settings: { sentencePerLine: true } },
    });
    expect(history[0]!.editedAt).toBeGreaterThan(entries[1]!.editedAt);
    expect(history[0]!.restoredFrom).toBe(1);
    expect(useSettingsStore.getState().sentencePerLine).toBe(true);
    expect(useSyncStore.getState().config.enabled).toBe(enabled);
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(parseSnapshotName(remote.write.mock.calls[0]![0])?.kind).toBe('preferences');
    expect(useGraphStore.getState().project).toBe(active);
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(remote.changes).not.toHaveBeenCalled();
  });

  it('does not publish a successful restore in history when the upload fails', async () => {
    setProjects(1, true);
    await addCloudProject(project('p0', 1));
    const object = [...cloud.values()][0]!.object;
    const entry = { object, projectId: 'p0', editedAt: 1, deleted: false };
    useSyncStore.setState({ projectHistory: { p0: [entry] } });
    remote.write.mockRejectedValueOnce(new Error('Upload failed (503).'));

    await expect(restoreProjectHistory(entry)).rejects.toThrow('Upload failed (503).');

    expect(useSyncStore.getState().projectHistory.p0).toEqual([entry]);
    expect(cloud.size).toBe(1);
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(applySyncedScatter).not.toHaveBeenCalled();
  });

  it('serializes restoration with an active sync and keeps the restored copy on later passes', async () => {
    setProjects(1);
    await addCloudProject({ ...project('p0', 1), name: 'Chosen older copy' });
    await addCloudProject({ ...project('p0', Date.now() + 60_000), name: 'Rejected newer copy' });
    const objects = [...cloud.values()].map(entry => entry.object);
    let finishSync!: (changes: RemoteChanges) => void;
    remote.changes.mockImplementationOnce(() => new Promise(resolve => { finishSync = resolve; }));
    const syncing = requestSyncNow({ manual: true });
    await vi.waitFor(() => expect(finishSync).toBeTypeOf('function'));
    const restoration = restoreProjectHistory({ object: objects[0]!, projectId: 'p0', editedAt: 1 });
    const restoredEarly = await Promise.race([
      restoration.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25)),
    ]);
    delta = [];
    finishSync({ reset: true, cursor: '1', objects, removedIds: [] });
    await Promise.all([syncing, restoration]);
    expect(restoredEarly).toBe(false);
    expect(projects.get('p0')?.name).toBe('Chosen older copy');
    await requestSyncNow({ manual: true });
    await requestSyncNow({ manual: true });
    expect(projects.get('p0')?.name).toBe('Chosen older copy');
    expect(useSyncStore.getState().projectHistory.p0?.[0]?.restoredFrom).toBe(1);
  });
});

describe('cloud snapshot deletion', () => {
  async function history() {
    await addCloudProject(project('p0', 1));
    await addCloudProject(project('p0', 2));
    const entries: SyncHistoryEntry[] = [...cloud.values()].map(({ object }) => ({
      object, projectId: 'p0', editedAt: parseSnapshotName(object.name)!.editedAt!, deleted: false,
    }));
    useSyncStore.setState({ projectHistory: { p0: [...entries].reverse() } });
    return entries;
  }

  it.each(['webdav', 'google-drive'] as const)('deletes only the older cloud snapshot through %s while paused', async provider => {
    setProjects(1, true);
    const entries = await history();
    const asset = { id: 'asset-id', name: assetObjectName('p0', 'image') };
    cloud.set(asset.id, { object: asset, data: new Blob(['image']) });
    const currentProject = useGraphStore.getState().project;
    const currentLedger = useSyncStore.getState().ledger;
    let ensure: ReturnType<typeof vi.spyOn> | undefined;
    if (provider === 'google-drive') {
      ensure = vi.spyOn(googleDrive, 'ensureGoogleDriveAccessToken').mockResolvedValue();
      vi.spyOn(googleDrive.GoogleDriveSyncProvider.prototype, 'list').mockImplementation(remote.list);
      vi.spyOn(googleDrive.GoogleDriveSyncProvider.prototype, 'remove').mockImplementation(remote.remove);
    }
    useSyncStore.setState(state => ({ config: { ...state.config, provider, enabled: false } }));
    await deleteSyncHistoryEntry(entries[0]!);
    expect(remote.remove).toHaveBeenCalledExactlyOnceWith(entries[0]!.object);
    expect(cloud.has(entries[0]!.object.id)).toBe(false);
    expect(cloud.has(entries[1]!.object.id)).toBe(true);
    expect(cloud.has(asset.id)).toBe(true);
    expect(useSyncStore.getState().projectHistory.p0).toEqual([entries[1]]);
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(useSyncStore.getState().running).toBe(false);
    expect(useSyncStore.getState().ledger).toBe(currentLedger);
    expect(useGraphStore.getState().project).toBe(currentProject);
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(applySyncedPreferences).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
    if (ensure) expect(ensure).toHaveBeenCalledOnce();
  });

  it('protects the latest snapshot using a fresh listing, not stale history metadata', async () => {
    const entries = await history();
    cloud.delete(entries[1]!.object.id);
    await expect(deleteSyncHistoryEntry(entries[0]!)).rejects.toThrow('latest snapshot is required');
    expect(remote.remove).not.toHaveBeenCalled();
    expect(useSyncStore.getState().projectHistory.p0).toEqual([entries[0]]);
  });

  it('deletes an older settings snapshot but not the current settings copy', async () => {
    const entries = [1, 2].map(editedAt => {
      const name = preferencesSnapshotName(editedAt, 1, 'test', 'hash');
      const object = { id: name, name };
      cloud.set(name, { object, data: new Blob(['settings']) });
      return { object, editedAt };
    });
    useSyncStore.setState({ preferenceHistory: [...entries].reverse() });
    await deleteSyncHistoryEntry(entries[0]!);
    expect(useSyncStore.getState().preferenceHistory).toEqual([entries[1]]);
    await expect(deleteSyncHistoryEntry(entries[1]!)).rejects.toThrow('latest snapshot is required');
    expect(remote.remove).toHaveBeenCalledOnce();
  });

  it('protects a latest project-deletion marker so history deletion cannot resurrect a project', async () => {
    const entries = await history();
    const envelope = await decodeEnvelope(cloud.get(entries[1]!.object.id)!.data);
    if (envelope.kind !== 'project') throw new Error('Expected project fixture');
    const deletion = { ...envelope, deleted: true, project: undefined, editedAt: 3 };
    const name = projectSnapshotName(deletion);
    const object = { id: name, name };
    cloud.set(name, { object, data: await encodeEnvelope(deletion) });
    await expect(deleteSyncHistoryEntry({ object, projectId: 'p0', editedAt: 3, deleted: true }))
      .rejects.toThrow('latest snapshot is required');
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it('refreshes the list when the selected snapshot was already deleted elsewhere', async () => {
    const entries = await history();
    cloud.delete(entries[0]!.object.id);
    await deleteSyncHistoryEntry(entries[0]!);
    expect(remote.remove).not.toHaveBeenCalled();
    expect(useSyncStore.getState().projectHistory.p0).toEqual([entries[1]]);
  });

  it('keeps history unchanged when the provider rejects deletion', async () => {
    const entries = await history();
    remote.remove.mockRejectedValueOnce(new Error('Permission denied'));
    await expect(deleteSyncHistoryEntry(entries[0]!)).rejects.toThrow('Permission denied');
    expect(useSyncStore.getState().projectHistory.p0).toEqual([...entries].reverse());
    expect(cloud.size).toBe(2);
    expect(useSyncStore.getState().running).toBe(false);
  });

  it('does not permit deletion of shared image assets through history', async () => {
    await expect(deleteSyncHistoryEntry({ object: { id: 'image', name: assetObjectName('p0', 'image') }, editedAt: 1 }))
      .rejects.toThrow('Choose a project or app-settings snapshot');
    expect(remote.list).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it('stops before deletion if the user disconnects during the fresh listing', async () => {
    const entries = await history();
    let finish!: (objects: RemoteObject[]) => void;
    remote.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = deleteSyncHistoryEntry(entries[0]!);
    const rejected = expect(pending).rejects.toThrow('sync connection changed');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    stopScheduledSync();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false, provider: null } }));
    finish(entries.map(entry => entry.object));
    await rejected;
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it('waits behind an in-flight sync and prevents another pass from racing deletion', async () => {
    setProjects(1);
    const entries = await history();
    let finishSync!: (changes: RemoteChanges) => void;
    remote.changes.mockImplementationOnce(() => new Promise(resolve => { finishSync = resolve; }));
    const syncing = requestSyncNow();
    await vi.waitFor(() => expect(finishSync).toBeTypeOf('function'));
    let finishList!: (objects: RemoteObject[]) => void;
    remote.list.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
    const deletion = deleteSyncHistoryEntry(entries[0]!);
    expect(remote.list).not.toHaveBeenCalled();
    // These initial objects are consumed by the reset response below.
    delta = [];
    finishSync({ reset: true, cursor: '1', objects: entries.map(entry => entry.object), removedIds: [] });
    await syncing;
    await vi.waitFor(() => expect(finishList).toBeTypeOf('function'));
    expect(requestSyncNow()).toBe(deletion);
    finishList([...cloud.values()].map(entry => entry.object));
    await deletion;
    expect(remote.remove).toHaveBeenCalledExactlyOnceWith(entries[0]!.object);
    await requestSyncNow();
    expect(useSyncStore.getState().projectHistory.p0?.some(entry => entry.object.id === entries[0]!.object.id)).toBe(false);
  });

  it('waits for the browser sync lock and rechecks a cancelled connection before deleting', async () => {
    const entries = await history();
    let grant!: () => void;
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const request = vi.fn((_name: string, callback: () => Promise<void>) => new Promise<void>((resolve, reject) => {
      grant = () => { void callback().then(resolve, reject); };
    }));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const pending = deleteSyncHistoryEntry(entries[0]!);
      const rejected = expect(pending).rejects.toThrow('sync connection changed');
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith('scatter-cloud-sync', expect.any(Function)));
      expect(remote.list).not.toHaveBeenCalled();
      stopScheduledSync();
      grant();
      await rejected;
      expect(remote.remove).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(navigator, 'locks', previous);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });
});

describe('incremental synchronization coordinator', () => {
  it('syncs projects and settings manually while paused without enabling automatic syncing', async () => {
    setProjects(1);
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
    await requestSyncNow();
    expect(remote.changes).not.toHaveBeenCalled();
    await requestSyncNow({ manual: true });
    expect(remote.changes).toHaveBeenCalledOnce();
    const kinds = remote.write.mock.calls.map(([name]) => parseSnapshotName(name)?.kind);
    expect(kinds).toContain('project');
    expect(kinds).toContain('preferences');
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(useSyncStore.getState()).toMatchObject({ running: false, error: null });
  });

  it('does not run automatic timers or edit-triggered sync while paused', async () => {
    vi.useFakeTimers();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
    await initializeSyncCoordinator();
    setProjects(1, true);
    scheduleSync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(remote.changes).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('queues a manual run after a just-paused request finishes', async () => {
    setProjects(1);
    let finish!: (value: RemoteChanges) => void;
    remote.changes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const automatic = requestSyncNow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    stopScheduledSync();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
    const manual = requestSyncNow({ manual: true });
    finish({ reset: true, cursor: '1', objects: [], removedIds: [] });
    await Promise.all([automatic, manual]);
    expect(remote.write).toHaveBeenCalled();
    expect(remote.changes).toHaveBeenCalledTimes(2);
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });

  it('cancels a manual run that is still waiting for Google authorization', async () => {
    let finish!: () => void;
    const ensure = vi.spyOn(googleDrive, 'ensureGoogleDriveAccessToken')
      .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const changes = vi.spyOn(googleDrive.GoogleDriveSyncProvider.prototype, 'changes');
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false, provider: 'google-drive' } }));
    const pending = requestSyncNow({ manual: true });
    expect(ensure).toHaveBeenCalledOnce();
    expect(useSyncStore.getState().running).toBe(true);
    stopScheduledSync();
    finish();
    await pending;
    expect(changes).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({ running: false, error: null });
  });

  it('renews Google access before a manual sync and leaves automatic syncing paused', async () => {
    setProjects(1);
    const ensure = vi.spyOn(googleDrive, 'ensureGoogleDriveAccessToken').mockResolvedValue();
    const prototype = googleDrive.GoogleDriveSyncProvider.prototype;
    vi.spyOn(prototype, 'indexScope').mockResolvedValue('google-test-account');
    vi.spyOn(prototype, 'changes').mockImplementation(remote.changes);
    vi.spyOn(prototype, 'list').mockImplementation(remote.list);
    vi.spyOn(prototype, 'read').mockImplementation(remote.read);
    vi.spyOn(prototype, 'write').mockImplementation(remote.write);
    vi.spyOn(prototype, 'remove').mockImplementation(remote.remove);
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: false } }));
    await requestSyncNow({ manual: true });
    expect(ensure).toHaveBeenCalledOnce();
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(remote.changes.mock.invocationCallOrder[0]!);
    expect(remote.write).toHaveBeenCalled();
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });

  it('does not start a cancelled manual run when its browser lock arrives late', async () => {
    let grant!: () => void;
    const previous = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) =>
        new Promise<void>((resolve, reject) => { grant = () => { void callback({}).then(resolve, reject); }; }),
    } });
    try {
      const pending = requestSyncNow({ manual: true });
      stopScheduledSync();
      useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
      grant();
      await pending;
      expect(remote.changes).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(navigator, 'locks', previous);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it.each(['local', 'cloud'] as const)('resolves a %s version from a manual run while automatic syncing remains paused', async choice => {
    setProjects(1, true);
    await addCloudProject({ ...projects.get('p0')!, name: 'Remote edit', updatedAt: 500 });
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
    vi.mocked(applySyncedScatter).mockImplementation(async value => {
      projects.set(value.id, value);
      useGraphStore.setState({ project: value, projectList: [...projects.values()].map(metadata) });
    });
    await requestSyncNow({ manual: true });
    expect(useSyncStore.getState().remoteUpdate).not.toBeNull();
    await resolveRemoteProjectUpdate(choice);
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(useGraphStore.getState().project?.name).toBe(choice === 'cloud' ? 'Remote edit' : 'Project p0');
  });

  it('does not apply a pending version choice after pause-and-exit', async () => {
    setProjects(1, true);
    await addCloudProject({ ...projects.get('p0')!, name: 'Remote edit', updatedAt: 500 });
    await requestSyncNow();
    let finish!: (objects: RemoteObject[]) => void;
    remote.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    remote.write.mockClear();
    const pending = resolveRemoteProjectUpdate('cloud');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    stopScheduledSync();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false }, remoteUpdate: null }));
    finish([...cloud.values()].map(entry => entry.object));
    await pending;
    expect(remote.write).not.toHaveBeenCalled();
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(useGraphStore.getState().project?.name).toBe('Project p0');
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
  });

  it('downloads the latest view for a closed project without touching content or opening it', async () => {
    setProjects(2, true);
    await settle();
    const before = projects.get('p1')!;
    const viewport = { x: 410, y: -912, zoom: 0.12 };
    await addCloudView('p1', viewport, 500);
    await requestSyncNow();
    expect(projects.get('p1')).toEqual({ ...before, viewport, viewportUpdatedAt: 500 });
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(useGraphStore.getState().project?.id).toBe('p0');
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
    expect(remote.write).not.toHaveBeenCalled();
    expect([...cloud.values()].filter(entry => parseSnapshotName(entry.object.name)?.kind === 'view'
      && parseSnapshotName(entry.object.name)?.projectId === 'p1')).toHaveLength(1);
    await settle();
    await requestSyncNow();
    expect(loadProjectById).not.toHaveBeenCalled();
    expect(remote.read).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('ignores remote navigation for the open project, then applies it once the project is closed', async () => {
    setProjects(2, true);
    useLiveViewportStore.getState().seedFrom({ x: 40, y: 50, zoom: 0.4 }, 100);
    await settle();
    await addCloudView('p0', { x: -999, y: 888, zoom: 0.1 }, 500);
    await requestSyncNow();
    expect(useLiveViewportStore.getState()).toMatchObject({ x: 40, y: 50, zoom: 0.4 });
    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
    useGraphStore.setState({ project: projects.get('p1')!, activeProjectId: 'p1' });
    useLiveViewportStore.getState().seedFrom(projects.get('p1')!.viewport);
    await requestSyncNow();
    expect(projects.get('p0')?.viewport).toEqual({ x: -999, y: 888, zoom: 0.1 });
    expect(useLiveViewportStore.getState()).toMatchObject(projects.get('p1')!.viewport);
  });

  it('does not apply a downloaded view if the user opens that project during the download', async () => {
    setProjects(2, true);
    await settle();
    await addCloudView('p1', { x: 300, y: 400, zoom: 0.1 }, 500);
    const read = remote.read.getMockImplementation()!;
    remote.read.mockImplementation(async (object: RemoteObject) => {
      if (parseSnapshotName(object.name)?.kind === 'view') {
        useGraphStore.setState({ project: projects.get('p1')!, activeProjectId: 'p1' });
        useLiveViewportStore.getState().seedFrom({ x: 10, y: 20, zoom: 0.5 });
      }
      return read(object);
    });
    await requestSyncNow();
    expect(saveProjectFile).not.toHaveBeenCalled();
    expect(useLiveViewportStore.getState()).toMatchObject({ x: 10, y: 20, zoom: 0.5 });
  });

  it('preserves the real camera in project snapshots without treating it as a content conflict', async () => {
    setProjects(1, true);
    useLiveViewportStore.getState().seedFrom({ x: 400, y: -123, zoom: 0.13 }, 100);
    await requestSyncNow();
    const projectWrite = remote.write.mock.calls.find(([name]) => parseSnapshotName(name)?.kind === 'project')!;
    expect(await decodeEnvelope(projectWrite[1])).toMatchObject({ project: {
      viewport: { x: 400, y: -123, zoom: 0.13 }, viewportUpdatedAt: 100,
    } });
  });

  it('detects a second camera move in the same millisecond and keeps one cloud view', async () => {
    setProjects(1, true);
    await settle();
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    useLiveViewportStore.getState().setPan(10, 20);
    await requestSyncNow();
    useLiveViewportStore.getState().setPan(30, 40);
    await requestSyncNow();
    const views = [...cloud.values()].filter(entry => parseSnapshotName(entry.object.name)?.kind === 'view');
    expect(views).toHaveLength(1);
    expect(await decodeEnvelope(views[0]!.data)).toMatchObject({ viewport: { x: 30, y: 40, zoom: 1 }, editedAt: 1001 });
  });

  it('keeps camera movement during an upload pending for the next pass', async () => {
    setProjects(1, true);
    await settle();
    useLiveViewportStore.getState().setPan(10, 20);
    const write = remote.write.getMockImplementation()!;
    remote.write.mockImplementationOnce(async (...args) => {
      const object = await write(...args);
      useLiveViewportStore.getState().setPan(30, 40);
      return object;
    });
    await requestSyncNow();
    remote.write.mockClear();
    await requestSyncNow();
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(await decodeEnvelope(remote.write.mock.calls[0]![1])).toMatchObject({ kind: 'view',
      viewport: { x: 30, y: 40, zoom: 1 } });
  });

  it('reads the latest closed-project file after pending persistence finishes', async () => {
    setProjects(2, true);
    await settle();
    const viewport = { x: 300, y: 400, zoom: 0.1 };
    await addCloudView('p1', viewport, 500);
    vi.mocked(releaseProjectPersistence).mockImplementationOnce(async () => {
      projects.set('p1', { ...projects.get('p1')!, name: 'Renamed during sync', updatedAt: 100 });
    });
    await requestSyncNow();
    expect(projects.get('p1')).toMatchObject({ name: 'Renamed during sync', updatedAt: 100,
      viewport, viewportUpdatedAt: 500 });
  });

  it('restores setup download-first and defers project ordering until projects arrive', async () => {
    const preferences = { settings: { ...DEFAULT_SETTINGS, sentencePerLine: true }, projectOrder: ['p1', 'p0'] };
    const hash = await sha256Hex(JSON.stringify(preferences));
    const name = preferencesSnapshotName(500, 1, 'other', hash);
    const object = { id: name, name };
    cloud.set(name, { object, data: await encodeEnvelope({ format: 'scatter-sync', formatVersion: 1,
      kind: 'preferences', editedAt: 500, sequence: 1, deviceId: 'other', deviceName: 'Other', hash, preferences }) });
    await addCloudProject(project('p0')); await addCloudProject(project('p1'));
    await restoreSetupFromSync();
    expect(applySyncedPreferences).toHaveBeenCalledExactlyOnceWith(preferences);
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(remote.write).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
    expect(useSyncStore.getState().ledger).toMatchObject({ settingsEditedAt: 500, restoredProjectOrder: ['p1', 'p0'] });
    expect(applySyncedProjectOrder).not.toHaveBeenCalled();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: true } }));
    await requestSyncNow();
    expect(applySyncedScatter).toHaveBeenCalledTimes(2);
    expect(applySyncedProjectOrder).toHaveBeenCalledWith(['p1', 'p0']);
    expect(useSyncStore.getState().ledger.restoredProjectOrder).toBeUndefined();
  });

  it('keeps synchronization paused when no saved setup exists, without uploading defaults', async () => {
    await expect(restoreSetupFromSync()).rejects.toThrow('No saved app settings');
    expect(useSyncStore.getState().config.enabled).toBe(false);
    expect(remote.write).not.toHaveBeenCalled();
    expect(applySyncedPreferences).not.toHaveBeenCalled();
  });

  it('stops after an in-flight request when paused, without reporting a failure', async () => {
    setProjects(3);
    let finish!: (value: RemoteChanges) => void;
    remote.changes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = requestSyncNow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    stopScheduledSync();
    useSyncStore.setState(state => ({ config: { ...state.config, enabled: false } }));
    finish({ reset: true, cursor: '1', objects: [], removedIds: [] });
    await pending;
    expect(remote.write).not.toHaveBeenCalled();
    expect(loadProjectById).not.toHaveBeenCalled();
    expect(useSyncStore.getState()).toMatchObject({ running: false, error: null });
  });
  it('does not load, fold/persist, hash preferences or download any unchanged project in an idle pass', async () => {
    setProjects(30, true);
    await settle();
    await requestSyncNow();
    expect(remote.changes).toHaveBeenCalledTimes(1);
    expect(remote.list).not.toHaveBeenCalled();
    expect(loadProjectById).not.toHaveBeenCalled();
    expect(flushProjectPersistence).not.toHaveBeenCalled();
    expect(createSyncedPreferences).not.toHaveBeenCalled();
    expect(remote.read).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('loads only the one locally changed inactive project', async () => {
    setProjects(30);
    await settle();
    const changed = { ...projects.get('p12')!, name: 'Changed', updatedAt: Date.now() };
    projects.set(changed.id, changed);
    useGraphStore.setState({ projectList: [...projects.values()].map(metadata) });
    await requestSyncNow();
    expect(loadProjectById).toHaveBeenCalledExactlyOnceWith('p12');
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(parseSnapshotName(remote.write.mock.calls[0]![0])).toMatchObject({ projectId: 'p12' });
  });

  it('detects a change from another device and only downloads/reconciles that project', async () => {
    setProjects(30);
    await settle();
    await addCloudProject({ ...projects.get('p12')!, name: 'Remote edit', updatedAt: Date.now() + 1000 });
    await requestSyncNow();
    expect(loadProjectById).toHaveBeenCalledExactlyOnceWith('p12');
    expect(applySyncedScatter).toHaveBeenCalledTimes(1);
    expect(projects.get('p12')!.name).toBe('Remote edit');
    expect(remote.read).toHaveBeenCalledTimes(1);
  });

  it('does not lose same-millisecond content edits or live geometry changes', async () => {
    setProjects(1, true);
    await initializeSyncCoordinator();
    await settle();
    const active = useGraphStore.getState().project!;
    useGraphStore.setState({ project: { ...active, name: 'Same timestamp edit' } });
    await requestSyncNow();
    expect(remote.write).toHaveBeenCalledTimes(1);
    await settle();
    useLivePositionsStore.setState({ positions: { test: { x: 1, y: 2 } } });
    await requestSyncNow();
    expect(flushProjectPersistence).toHaveBeenCalledTimes(1);
  });

  it('syncs camera-only changes separately from content and ignores selection changes', async () => {
    setProjects(1, true);
    await initializeSyncCoordinator();
    await settle();
    const active = useGraphStore.getState().project!;
    useGraphStore.setState({ project: { ...active, selection: ['node'] } });
    await requestSyncNow();
    expect(flushProjectPersistence).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
    useLiveViewportStore.getState().setViewport({ x: 20, y: 30, zoom: 0.2 });
    await requestSyncNow();
    expect(remote.write).toHaveBeenCalledTimes(1);
    expect(await decodeEnvelope(remote.write.mock.calls[0]![1])).toMatchObject({ kind: 'view',
      projectId: active.id, viewport: { x: 20, y: 30, zoom: 0.2 } });
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
    expect(flushProjectPersistence).not.toHaveBeenCalled();
    expect([...cloud.values()].filter(entry => parseSnapshotName(entry.object.name)?.kind === 'view')).toHaveLength(1);
    await settle();
    await requestSyncNow();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('detects an inactive project write even when its metadata timestamp has not advanced', async () => {
    setProjects(2);
    await initializeSyncCoordinator();
    await settle();
    const changed = { ...projects.get('p1')!, goldenColorCursorHue: 100 };
    projects.set('p1', changed);
    useGraphStore.setState({ projectList: useGraphStore.getState().projectList.map((meta) => meta.id === 'p1' ? metadata(changed) : meta) });
    await requestSyncNow();
    expect(loadProjectById).toHaveBeenCalledExactlyOnceWith('p1');
    const projectWrite = remote.write.mock.calls.find(([name]) => parseSnapshotName(name)?.kind === 'project')!;
    expect(await decodeEnvelope(projectWrite[1])).toMatchObject({ project: { goldenColorCursorHue: 100 } });
  });

  it('keeps edits made during an upload pending and sends them in the next pass', async () => {
    setProjects(1, true);
    await initializeSyncCoordinator();
    await settle();
    const initial = useGraphStore.getState().project!;
    useGraphStore.setState({ project: { ...initial, name: 'First edit', updatedAt: Date.now() } });
    const write = remote.write.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    remote.write.mockImplementationOnce(async (...args) => {
      started(); await new Promise<void>((resolve) => { release = resolve; });
      return write(...args);
    });
    const syncing = requestSyncNow();
    await waiting;
    useGraphStore.setState({ project: { ...useGraphStore.getState().project!, name: 'Second edit' } });
    release(); await syncing;
    expect(useSyncStore.getState().ledger.projects.p0?.status).toBe('pending');
    await requestSyncNow();
    const latest = remote.write.mock.calls.at(-1)!;
    expect(await decodeEnvelope(latest[1])).toMatchObject({ project: { name: 'Second edit' } });
  });

  it('rechecks all projects after a missing/corrupt index without changing their content', async () => {
    setProjects(3);
    await settle();
    storage.set('sync/change-index.json', { damaged: true });
    await requestSyncNow();
    expect(remote.changes).toHaveBeenLastCalledWith(undefined);
    expect(loadProjectById).toHaveBeenCalledTimes(3);
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('does not cache unfinished background generation and uploads the completed content even with stale sidebar metadata', async () => {
    setProjects(2);
    await settle();
    const partial = { ...projects.get('p0')!, updatedAt: Date.now(),
      nodes: { n: { id: 'n', generating: true } as ScatterNode } };
    background.projects.set('p0', partial);
    await requestSyncNow();
    expect(useSyncStore.getState().ledger.projects.p0?.status).toBe('pending');
    expect(remote.write).not.toHaveBeenCalled();
    const complete = { ...partial, name: 'Completed in background', nodes: {} };
    projects.set('p0', complete);
    background.projects.delete('p0');
    // Background persistence finishes without changing projectList.updatedAt.
    await requestSyncNow();
    expect(await decodeEnvelope(remote.write.mock.calls[0]![1])).toMatchObject({ project: { name: 'Completed in background' } });
  });

  it('preserves the active-project conflict prompt instead of treating a remote change as an idle pass', async () => {
    setProjects(1, true);
    await settle();
    await addCloudProject({ ...projects.get('p0')!, name: 'New remote version', updatedAt: Date.now() + 1000 });
    await requestSyncNow();
    expect(useSyncStore.getState().remoteUpdate?.projectId).toBe('p0');
    expect(useGraphStore.getState().project?.name).toBe('Project p0');
    expect(applySyncedScatter).not.toHaveBeenCalled();
    expect(remote.write).not.toHaveBeenCalled();
  });

  it('retention cleanup only reads snapshots of the project whose history needs trimming', async () => {
    setProjects(30);
    await settle();
    for (let i = 0; i < 11; i++) {
      await addCloudProject({ ...projects.get('p12')!, name: `Version ${i}`, updatedAt: 1000 + i });
    }
    await requestSyncNow();
    const projectReads = remote.read.mock.calls.map(([object]) => parseSnapshotName(object.name)?.projectId);
    expect(new Set(projectReads)).toEqual(new Set(['p12']));
    expect(useSyncStore.getState().projectHistory.p12).toHaveLength(10);
    expect(loadProjectById).toHaveBeenCalledExactlyOnceWith('p12');
  });

  it('does not save a new cursor when an upload fails; a retry retains the pending work', async () => {
    setProjects(1, true);
    await initializeSyncCoordinator();
    await settle();
    const oldIndex = structuredClone(storage.get('sync/change-index.json'));
    useGraphStore.setState({ project: { ...useGraphStore.getState().project!, name: 'Retry me', updatedAt: Date.now() } });
    remote.write.mockRejectedValueOnce(new Error('Connection interrupted'));
    await expect(requestSyncNow()).rejects.toThrow('Connection interrupted');
    expect(storage.get('sync/change-index.json')).toEqual(oldIndex);
    expect(useSyncStore.getState().error).toBe('Connection interrupted');
    await requestSyncNow();
    expect(useSyncStore.getState().error).toBeNull();
    expect(await decodeEnvelope(remote.write.mock.calls.at(-1)![1])).toMatchObject({ project: { name: 'Retry me' } });
  });

  it('coalesces return events, waits 60 seconds between polls, and lets edits/manual sync bypass the return cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    await initializeSyncCoordinator();
    await settle();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.changes).not.toHaveBeenCalled();
    useSettingsStore.setState({ sentencePerLine: true });
    await vi.advanceTimersByTimeAsync(3000);
    await requestSyncNow(); // Join the scheduled pass if crypto work is pending.
    expect(remote.changes).toHaveBeenCalled();
    remote.changes.mockClear();
    await requestSyncNow();
    expect(remote.changes).toHaveBeenCalledTimes(1);
    remote.changes.mockClear();
    await vi.advanceTimersByTimeAsync(15000);
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1);
    expect(remote.changes).toHaveBeenCalledTimes(1);
    remote.changes.mockClear();
    await vi.advanceTimersByTimeAsync(41997);
    expect(remote.changes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(remote.changes).toHaveBeenCalledTimes(1);
  });
});
