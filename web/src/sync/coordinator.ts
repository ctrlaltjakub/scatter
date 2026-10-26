import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore, type SyncHistoryEntry } from '@/store/useSyncStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import type { Project, ProjectMeta } from '@/store/types';
import { SETTINGS_FIELD_NAMES } from '@/store/settingsSnapshot';
import {
  applySyncedProjectOrder,
  applySyncedScatter,
  deleteScatter,
} from '@/store/projectActions';
import {
  flushProjectPersistence,
  releaseProjectPersistence,
  adoptProjectPersistenceMirror,
} from '@/store/projectPersistence';
import { foldRuntimeIntoProject, withPersistedViewport } from '@/store/foldRuntime';
import { getGenProject, projectHasGenerating } from '@/store/bgGen';
import { loadProjectById, saveProjectFile } from '@/opfs/projectsIO';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { clampViewportZoom } from '@/lib/zoomLimits';
import { loadAsset, saveAsset } from '@/opfs/assetsIO';
import { loadSourceAsset, saveSourceAsset } from '@/opfs/sourceAssetsIO';
import { stripTransient } from '@/opfs/projectIO';
import { collectReferencedProjectAssets } from '@/lib/projectBranch';
import { flushSyncPersistence, saveSyncLedger } from './local';
import {
  assetObjectName,
  compareSnapshotObjects,
  decodeEnvelope,
  encodeEnvelope,
  parseSnapshotName,
  preferencesSnapshotName,
  projectSnapshotName,
  projectViewName,
  sha256Hex,
} from './codec';
import {
  applySyncedPreferences,
  createSyncedPreferences,
} from './preferences';
import {
  GoogleDriveAuthorizationRejected,
  GoogleDriveReconnectRequired,
  GoogleDriveSyncProvider,
  ensureGoogleDriveAccessToken,
  googleDriveTokenNeedsRefresh,
  installGoogleDriveGestureRefresh,
} from './providers/googleDrive';
import { isBrowserOnline, subscribeNetworkStatus } from '@/lib/networkStatus';
import { WebDavSyncProvider } from './providers/webdav';
import { resolveHistoryTitles } from './history';
import { openChangeIndex } from './changeIndex';
import type {
  PreferencesSnapshotEnvelope,
  ProjectSnapshotEnvelope,
  ProjectViewEnvelope,
  RemoteObject,
  SyncLedger,
  SyncProvider,
  SyncedPreferences,
} from './types';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION, SYNC_HISTORY_LIMIT } from './types';

const QUIET_SYNC_MS = 3_000;
const POLL_MS = 60_000;
const RETURN_COOLDOWN_MS = 15_000;
let initialized = false;
let applyingRemote = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let inFlightRevision = 0;
let sequence = 0;
let cleanupCallbacks: Array<() => void> = [];
let lastSuccessfulSyncAt = 0;
let syncRunRevision = 0;
class SyncPaused extends Error {}

/** An already-sent request may finish, but pausing prevents any further work. */
export function stopScheduledSync(): void {
  syncRunRevision += 1;
  if (timer) clearTimeout(timer);
  timer = null;
}

const runtimeIds = new WeakMap<object, number>();
const metaIndexes = new WeakMap<ProjectMeta[], Map<string, ProjectMeta>>();
let nextRuntimeId = 0;
let runtimeSession = '';
function runtimeId(value: object | undefined): number {
  if (!value) return 0;
  let id = runtimeIds.get(value);
  if (id === undefined) { id = ++nextRuntimeId; runtimeIds.set(value, id); }
  return id;
}

/** Only compare small metadata and reference identities here. Folding live
 * geometry, loading project files and hashing bodies happen after a miss. */
function localProjectStamp(projectId: string): string {
  const graph = useGraphStore.getState();
  let metas = metaIndexes.get(graph.projectList);
  if (!metas) {
    metas = new Map(graph.projectList.map((meta) => [meta.id, meta]));
    metaIndexes.set(graph.projectList, metas);
  }
  const meta = metas.get(projectId);
  const entry = useSyncStore.getState().ledger.projects[projectId];
  const candidate = getGenProject(projectId);
  const live = candidate?.id === projectId ? candidate : null;
  const active = graph.activeProjectId === projectId && graph.project?.id === projectId;
  const base = `${!!meta}:${Math.max(meta?.updatedAt ?? 0, live?.updatedAt ?? 0, entry?.localEditedAt ?? 0)}:${entry?.localRevision ?? 0}:${!!entry?.deleted}`;
  if (!live) return base;
  runtimeSession ||= crypto.randomUUID();
  return `${base}:${runtimeSession}:${[
    live.nodes, live.arrows, live.groups, live.sourceLibrary,
    ...(active ? [useLivePositionsStore.getState().positions, useArrowAnchorsStore.getState().anchors,
      useActiveIdxStore.getState().byNodeId] : []),
  ].map(runtimeId).join(':')}`;
}

function localPreferencesStamp(): string {
  const ledger = useSyncStore.getState().ledger;
  runtimeSession ||= crypto.randomUUID();
  // Remote installs can change the project order without producing a local
  // edit event. Recheck settings once after restart/import as well.
  return `${runtimeSession}:${ledger.settingsEditedAt}:${ledger.settingsRevision ?? 0}:${JSON.stringify(useGraphStore.getState().projectList.map((project) => project.id))}`;
}

function projectContentChanged(current: Project, previous: Project | null): boolean {
  if (!previous || current.id !== previous.id) return true;
  return (Object.keys(current) as Array<keyof Project>).some((key) => (
    key !== 'viewport' && key !== 'viewportUpdatedAt' && key !== 'selection' && current[key] !== previous[key]
  ));
}

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

function projectForSync(project: NonNullable<ReturnType<typeof useGraphStore.getState>['project']>) {
  const clean = stripTransient(project);
  return {
    ...clean,
    selection: [],
  };
}

async function projectHash(project: NonNullable<ReturnType<typeof useGraphStore.getState>['project']>): Promise<string> {
  // Retain the historical content hash: navigation has its own tiny record
  // and must not create graph conflicts or fill content snapshot history.
  const { viewportUpdatedAt: _viewTime, ...clean } = projectForSync(project);
  return sha256Hex(JSON.stringify({ ...clean, viewport: { x: 0, y: 0, zoom: 1 } }));
}

function providerFromConfig(): SyncProvider {
  const config = useSyncStore.getState().config;
  if (config.provider === 'google-drive') return new GoogleDriveSyncProvider();
  if (config.provider === 'webdav' && config.webdav) return new WebDavSyncProvider(config.webdav);
  throw new Error('Choose and connect a sync provider first.');
}

function guardProvider(remote: SyncProvider, assertActive: () => void): SyncProvider {
  const guarded = async <T>(action: () => Promise<T>): Promise<T> => {
    assertActive();
    const value = await action();
    assertActive();
    return value;
  };
  return {
    kind: remote.kind,
    test: () => guarded(() => remote.test()),
    list: () => guarded(() => remote.list()),
    read: object => guarded(() => remote.read(object)),
    write: (name, data) => guarded(() => remote.write(name, data)),
    remove: object => guarded(() => remote.remove(object)),
    ...(remote.indexScope ? { indexScope: () => guarded(() => remote.indexScope!()) } : {}),
    ...(remote.changes ? { changes: (cursor?: string) => guarded(() => remote.changes!(cursor)) } : {}),
  };
}

function updateLedger(mutator: (ledger: SyncLedger) => SyncLedger): void {
  const next = mutator(useSyncStore.getState().ledger);
  useSyncStore.setState({ ledger: next });
  void saveSyncLedger(next).catch((error) => {
    console.error('[scatter] could not save sync state', error);
  });
}

function projectStatus(projectId: string, status: SyncLedger['projects'][string]['status'], error?: string): void {
  updateLedger((ledger) => ({
    ...ledger,
    projects: {
      ...ledger.projects,
      [projectId]: {
        projectId,
        localEditedAt: ledger.projects[projectId]?.localEditedAt ?? 0,
        ...ledger.projects[projectId],
        status,
        ...(error ? { error } : { error: undefined }),
      },
    },
  }));
}

function requireGoogleDriveReconnect(message: string): void {
  useSyncStore.getState().setRuntime({
    running: false,
    error: message,
    googleDriveReconnectRequired: true,
  });
}

/** Developer-only diagnostic entry point. It deliberately leaves the real
 * token untouched while exercising the same recovery UI as a failed renewal. */
export function simulateGoogleDriveRenewalFailure(): void {
  requireGoogleDriveReconnect('Developer test: Google Drive token renewal failed.');
}

/** Opens the real version-conflict UI using an in-memory copy of the active
 * project. The preview flag makes either choice dismiss-only: no provider,
 * project, history, or persistence operation is allowed to run. */
export function simulateRemoteProjectUpdateConflict(): boolean {
  const current = useGraphStore.getState().project;
  if (!current) return false;
  const local = structuredClone(current);
  const editedAt = Math.max(Date.now(), local.updatedAt + 60_000);
  const remote = { ...structuredClone(current), updatedAt: editedAt };
  useSyncStore.getState().setRuntime({
    remoteUpdate: {
      projectId: local.id,
      local,
      remote: {
        format: SYNC_FORMAT,
        formatVersion: SYNC_FORMAT_VERSION,
        kind: 'project',
        projectId: local.id,
        editedAt,
        sequence: 1,
        deviceId: 'developer-preview-device',
        deviceName: 'Other device',
        hash: 'developer-preview',
        deleted: false,
        assetIds: [],
        project: remote,
      },
      object: { id: 'developer-preview', name: 'developer-preview.scatter-sync' },
      previewOnly: true,
    },
  });
  return true;
}

function markProjectDirty(projectId: string, editedAt = Date.now(), deleted = false, name?: string): void {
  updateLedger((ledger) => ({
    ...ledger,
    ...(name ? { historyTitles: { ...ledger.historyTitles, [projectId]: { name } } } : {}),
    knownProjectIds: ledger.knownProjectIds.includes(projectId)
      ? ledger.knownProjectIds
      : [...ledger.knownProjectIds, projectId],
    projects: {
      ...ledger.projects,
      [projectId]: {
        ...ledger.projects[projectId],
        projectId,
        localEditedAt: Math.max(editedAt, ledger.projects[projectId]?.localEditedAt ?? 0),
        localRevision: (ledger.projects[projectId]?.localRevision ?? 0) + 1,
        status: 'pending',
        deleted,
      },
    },
  }));
  scheduleSync();
}

function markPreferencesDirty(): void {
  updateLedger((ledger) => ({ ...ledger, settingsEditedAt: Date.now(), settingsRevision: (ledger.settingsRevision ?? 0) + 1 }));
  scheduleSync();
}

function groupRemoteObjects(objects: RemoteObject[]) {
  const projects = new Map<string, RemoteObject[]>();
  const views = new Map<string, RemoteObject[]>();
  const preferences: RemoteObject[] = [];
  const assets = new Map<string, RemoteObject>();
  for (const object of objects) {
    const parsed = parseSnapshotName(object.name);
    if (!parsed) continue;
    if (parsed.kind === 'project' && parsed.projectId) {
      projects.set(parsed.projectId, [...(projects.get(parsed.projectId) ?? []), object]);
    } else if (parsed.kind === 'view' && parsed.projectId) {
      views.set(parsed.projectId, [...(views.get(parsed.projectId) ?? []), object]);
    } else if (parsed.kind === 'preferences') {
      preferences.push(object);
    } else if (parsed.kind === 'asset' && parsed.projectId && parsed.assetId) {
      assets.set(`${parsed.projectId}\n${parsed.assetId}`, object);
    }
  }
  for (const list of projects.values()) list.sort(compareSnapshotObjects);
  for (const list of views.values()) list.sort(compareSnapshotObjects);
  preferences.sort(compareSnapshotObjects);
  return { projects, preferences, assets, views };
}

function publishHistory(grouped: ReturnType<typeof groupRemoteObjects>): void {
  const restored = useSyncStore.getState().ledger.restoredSnapshots ?? {};
  const projectHistory: Record<string, SyncHistoryEntry[]> = {};
  for (const [projectId, objects] of grouped.projects) {
    projectHistory[projectId] = objects.slice(-SYNC_HISTORY_LIMIT).reverse().map((object) => {
      const parsed = parseSnapshotName(object.name)!;
      return { object, projectId, editedAt: parsed.editedAt ?? object.modifiedAt ?? 0, deleted: parsed.deleted, restoredFrom: restored[object.name] };
    });
  }
  const preferenceHistory = grouped.preferences.slice(-SYNC_HISTORY_LIMIT).reverse().map((object) => {
    const parsed = parseSnapshotName(object.name)!;
    return { object, editedAt: parsed.editedAt ?? object.modifiedAt ?? 0, restoredFrom: restored[object.name] };
  });
  const retained = new Set([...Object.values(projectHistory).flat(), ...preferenceHistory].map(entry => entry.object.name));
  const restoredSnapshots = Object.fromEntries(Object.entries(restored).filter(([name]) => retained.has(name)));
  if (Object.keys(restoredSnapshots).length !== Object.keys(restored).length) {
    updateLedger(ledger => ({ ...ledger, restoredSnapshots }));
  }
  useSyncStore.getState().setRuntime({ projectHistory, preferenceHistory });
}

async function uploadAssetIfNeeded(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  projectId: string,
  assetId: string,
  kind: 'media' | 'source' = 'media',
): Promise<void> {
  const key = `${projectId}\n${assetId}`;
  if (grouped.assets.has(key)) return;
  const blob = kind === 'source'
    ? await loadSourceAsset(projectId, assetId)
    : await loadAsset(projectId, assetId);
  if (!blob) throw new Error(`A local ${kind} asset is missing (${assetId}).`);
  const object = await provider.write(assetObjectName(projectId, assetId), blob);
  grouped.assets.set(key, object);
}

async function uploadProject(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  project: NonNullable<ReturnType<typeof useGraphStore.getState>['project']>,
  editedAt: number,
  deleted = false,
  revision = useSyncStore.getState().ledger.projects[project.id]?.localRevision ?? 0,
  restoredFrom?: number,
): Promise<ProjectSnapshotEnvelope> {
  const config = useSyncStore.getState().config;
  const clean = projectForSync(project);
  const referenced = deleted ? null : collectReferencedProjectAssets(clean);
  const mediaAssetIds = referenced ? [...referenced.media] : [];
  const sourceAssetIds = referenced ? [...referenced.sourceEager] : [];
  const lazySourceAssetIds = referenced ? [...referenced.sourceLazy] : [];
  const assetIds = [...new Set([...mediaAssetIds, ...sourceAssetIds, ...lazySourceAssetIds])];
  await Promise.all([
    ...mediaAssetIds.map((assetId) => uploadAssetIfNeeded(provider, grouped, project.id, assetId, 'media')),
    ...[...sourceAssetIds, ...lazySourceAssetIds]
      .map((assetId) => uploadAssetIfNeeded(provider, grouped, project.id, assetId, 'source')),
  ]);
  const hash = deleted ? await sha256Hex(`deleted:${project.id}:${editedAt}`) : await projectHash(clean);
  const envelope: ProjectSnapshotEnvelope = {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    kind: 'project',
    projectId: project.id,
    projectName: clean.name || undefined,
    editedAt,
    sequence: nextSequence(),
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    hash,
    deleted,
    assetIds,
    mediaAssetIds,
    sourceAssetIds,
    lazySourceAssetIds,
    ...(restoredFrom != null ? { restoredFrom } : {}),
    ...(!deleted ? { project: clean } : {}),
  };
  const name = projectSnapshotName(envelope);
  if (!(grouped.projects.get(project.id) ?? []).some((object) => object.name === name)) {
    const object = await provider.write(name, await encodeEnvelope(envelope));
    const list = [...(grouped.projects.get(project.id) ?? []), object].sort(compareSnapshotObjects);
    grouped.projects.set(project.id, list);
  }
  updateLedger((ledger) => ({
    ...ledger,
    ...(restoredFrom != null ? { restoredSnapshots: { ...ledger.restoredSnapshots, [name]: restoredFrom } } : {}),
    historyTitles: { ...ledger.historyTitles, [project.id]: { name: clean.name || undefined, snapshotName: name } },
    projects: {
      ...ledger.projects,
      [project.id]: {
        ...ledger.projects[project.id],
        projectId: project.id,
        localEditedAt: Math.max(editedAt, ledger.projects[project.id]?.localEditedAt ?? 0),
        lastSyncedHash: hash,
        lastSyncedAt: Date.now(),
        status: (ledger.projects[project.id]?.localRevision ?? 0) === revision ? 'synced' : 'pending',
        error: undefined,
        deleted: (ledger.projects[project.id]?.localRevision ?? 0) === revision ? deleted : ledger.projects[project.id]?.deleted,
      },
    },
  }));
  return envelope;
}

async function uploadDeletion(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  projectId: string,
  editedAt: number,
): Promise<void> {
  // Preserve the name after deleting content; this placeholder is never installed.
  const placeholder = {
    id: projectId,
    name: useSyncStore.getState().ledger.historyTitles?.[projectId]?.name ?? '',
    createdAt: editedAt,
    updatedAt: editedAt,
    rootNodeId: '', nodes: {}, arrows: {}, groups: {},
    viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
  };
  await uploadProject(provider, grouped, placeholder, editedAt, true);
}

async function downloadAssets(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  snapshot: ProjectSnapshotEnvelope,
): Promise<void> {
  const mediaIds = snapshot.mediaAssetIds ?? snapshot.assetIds;
  const sourceIds = snapshot.sourceAssetIds ?? [];
  await Promise.all(mediaIds.map(async (assetId) => {
    if (await loadAsset(snapshot.projectId, assetId)) return;
    const remote = grouped.assets.get(`${snapshot.projectId}\n${assetId}`);
    if (!remote) throw new Error(`A synchronized media asset is missing (${assetId}).`);
    await saveAsset(snapshot.projectId, assetId, await provider.read(remote));
  }));
  await Promise.all(sourceIds.map(async (assetId) => {
    if (await loadSourceAsset(snapshot.projectId, assetId)) return;
    const remote = grouped.assets.get(`${snapshot.projectId}\n${assetId}`);
    if (!remote) throw new Error(`A synchronized source asset is missing (${assetId}).`);
    await saveSourceAsset(snapshot.projectId, assetId, await provider.read(remote));
  }));
}

async function installRemoteProject(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  envelope: ProjectSnapshotEnvelope,
  local?: NonNullable<ReturnType<typeof useGraphStore.getState>['project']>,
  assertActive: () => void = () => undefined,
): Promise<Project | undefined> {
  assertActive();
  if (envelope.deleted) {
    const name = envelope.projectName || local?.name
      || useGraphStore.getState().projectList.find((project) => project.id === envelope.projectId)?.name;
    const exists = useGraphStore.getState().projectList.some((project) => project.id === envelope.projectId);
    if (exists) await deleteScatter(envelope.projectId);
    updateLedger((ledger) => ({
      ...ledger,
      ...(name ? { historyTitles: { ...ledger.historyTitles, [envelope.projectId]: { name } } } : {}),
      knownProjectIds: ledger.knownProjectIds.includes(envelope.projectId)
        ? ledger.knownProjectIds
        : [...ledger.knownProjectIds, envelope.projectId],
      projects: {
        ...ledger.projects,
        [envelope.projectId]: {
          ...ledger.projects[envelope.projectId],
          projectId: envelope.projectId,
          localEditedAt: envelope.editedAt,
          lastSyncedHash: envelope.hash,
          lastSyncedAt: Date.now(),
          status: 'synced',
          deleted: true,
        },
      },
    }));
    return;
  }
  if (!envelope.project) throw new Error('The synchronized project snapshot has no project data.');
  await downloadAssets(provider, grouped, envelope);
  assertActive();
  const graph = useGraphStore.getState();
  const viewSource = local ?? (
    graph.activeProjectId === envelope.projectId && graph.project
      ? foldRuntimeIntoProject(graph.project)
      : undefined
  );
  // applySyncedScatter protects the *current* live camera for an open project.
  // Inactive projects should accept the incoming saved view.
  let project = viewSource && (viewSource.viewportUpdatedAt ?? 0) > (envelope.project.viewportUpdatedAt ?? 0)
    ? { ...envelope.project, viewport: viewSource.viewport, viewportUpdatedAt: viewSource.viewportUpdatedAt }
    : envelope.project;
  // A permanent local source deletion must not be undone by selecting an
  // older synchronized project snapshot. Merge deletion markers first, then
  // remove every source whose marker is newer than the remote source record.
  const localTombstones = viewSource?.sourceLibrary?.tombstones ?? {};
  const remoteLibrary = project.sourceLibrary;
  if (remoteLibrary && Object.keys(localTombstones).length) {
    const tombstones = { ...(remoteLibrary.tombstones ?? {}), ...localTombstones };
    const sources = { ...remoteLibrary.sources };
    for (const [sourceId, tombstone] of Object.entries(tombstones)) {
      const source = sources[sourceId];
      if (source && tombstone.deletedAt >= source.createdAt) delete sources[sourceId];
    }
    project = {
      ...project,
      sourceLibrary: {
        ...remoteLibrary,
        tombstones,
        sources,
        order: remoteLibrary.order.filter((sourceId) => Boolean(sources[sourceId])),
      },
    };
  }
  await applySyncedScatter(project);
  updateLedger((ledger) => ({
    ...ledger,
    knownProjectIds: ledger.knownProjectIds.includes(project.id)
      ? ledger.knownProjectIds
      : [...ledger.knownProjectIds, project.id],
    projects: {
      ...ledger.projects,
      [project.id]: {
        ...ledger.projects[project.id],
        projectId: project.id,
        localEditedAt: envelope.editedAt,
        lastSyncedHash: envelope.hash,
        lastSyncedAt: Date.now(),
        status: 'synced',
        deleted: false,
      },
    },
  }));
  return project;
}

async function decodeProject(provider: SyncProvider, object: RemoteObject): Promise<ProjectSnapshotEnvelope> {
  const envelope = await decodeEnvelope(await provider.read(object));
  if (envelope.kind !== 'project') throw new Error('Expected a project sync snapshot.');
  if (envelope.restoredFrom != null) updateLedger(ledger => ({ ...ledger,
    restoredSnapshots: { ...ledger.restoredSnapshots, [object.name]: envelope.restoredFrom! } }));
  return envelope;
}

async function reconcileProject(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  projectId: string,
  loaded: Map<string, Project | null>,
): Promise<boolean> {
  const graph = useGraphStore.getState();
  const meta = graph.projectList.find((project) => project.id === projectId);
  const ledgerEntry = useSyncStore.getState().ledger.projects[projectId];
  const live = getGenProject(projectId);
  const local = meta
    ? (graph.activeProjectId === projectId && graph.project
        ? foldRuntimeIntoProject(graph.project)
        : live?.id === projectId ? live : await loadProjectById(projectId))
    : null;
  loaded.set(projectId, local);
  const remoteObjects = grouped.projects.get(projectId) ?? [];
  const latestObject = remoteObjects.at(-1);
  const latestMeta = latestObject ? parseSnapshotName(latestObject.name) : null;

  if (!local) {
    if (ledgerEntry?.deleted) {
      if (!latestMeta || (ledgerEntry.localEditedAt > (latestMeta.editedAt ?? 0))) {
        await uploadDeletion(provider, grouped, projectId, ledgerEntry.localEditedAt);
      } else if (latestMeta.deleted) {
        updateLedger((ledger) => ({
          ...ledger,
          projects: {
            ...ledger.projects,
            [projectId]: {
              ...ledger.projects[projectId]!,
              localEditedAt: latestMeta.editedAt ?? ledgerEntry.localEditedAt,
              lastSyncedHash: latestMeta.hash,
              lastSyncedAt: Date.now(),
              status: 'synced',
              deleted: true,
            },
          },
        }));
      }
      return false;
    }
    if (!latestObject || latestMeta?.deleted) return false;
    const remote = await decodeProject(provider, latestObject);
    applyingRemote = true;
    try { loaded.set(projectId, await installRemoteProject(provider, grouped, remote) ?? null); } finally { applyingRemote = false; }
    return false;
  }

  if (projectHasGenerating(local)) {
    projectStatus(projectId, 'pending');
    return false;
  }
  const localEditedAt = Math.max(local.updatedAt, ledgerEntry?.localEditedAt ?? 0);
  const localHash = await projectHash(local);
  if (!latestObject || !latestMeta) {
    projectStatus(projectId, 'syncing');
    await uploadProject(provider, grouped, local, localEditedAt || Date.now(), false, ledgerEntry?.localRevision ?? 0);
    return false;
  }
  const remoteEditedAt = latestMeta.editedAt ?? 0;
  if (latestMeta.hash === localHash.slice(0, 24)) {
    updateLedger((ledger) => ({
      ...ledger,
      projects: {
        ...ledger.projects,
        [projectId]: {
          ...ledger.projects[projectId],
          projectId,
          localEditedAt: Math.max(localEditedAt, ledger.projects[projectId]?.localEditedAt ?? 0),
          lastSyncedHash: localHash,
          lastSyncedAt: Date.now(),
          status: (ledger.projects[projectId]?.localRevision ?? 0) === (ledgerEntry?.localRevision ?? 0) ? 'synced' : 'pending',
          error: undefined,
          deleted: (ledger.projects[projectId]?.localRevision ?? 0) === (ledgerEntry?.localRevision ?? 0)
            ? false : ledger.projects[projectId]?.deleted,
        },
      },
    }));
    return false;
  }
  if (remoteEditedAt > localEditedAt) {
    const remote = await decodeProject(provider, latestObject);
    if (graph.activeProjectId === projectId) {
      projectStatus(projectId, 'remote-update');
      useSyncStore.getState().setRuntime({ remoteUpdate: { projectId, local, remote, object: latestObject } });
      return true;
    }
    applyingRemote = true;
    try { loaded.set(projectId, await installRemoteProject(provider, grouped, remote, local) ?? null); } finally { applyingRemote = false; }
    return false;
  }
  projectStatus(projectId, 'syncing');
  await uploadProject(provider, grouped, local, Math.max(localEditedAt, Date.now()), false, ledgerEntry?.localRevision ?? 0);
  return false;
}

function localViewStamp(projectId: string): string {
  const graph = useGraphStore.getState();
  const project = getGenProject(projectId);
  const live = graph.project?.id === projectId ? useLiveViewportStore.getState() : null;
  const viewport = live ?? project?.viewport;
  return `${localProjectStamp(projectId)}:view:${project?.viewportUpdatedAt ?? 0}:${live?.editedAt ?? 0}:${viewport ? `${viewport.x},${viewport.y},${viewport.zoom}` : ''}`;
}

async function reconcileProjectView(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  projectId: string,
  loaded: Map<string, Project | null>,
): Promise<void> {
  const graph = useGraphStore.getState();
  if (!graph.projectList.some(project => project.id === projectId)) return;
  const candidate = getGenProject(projectId);
  const local = graph.project?.id === projectId ? withPersistedViewport(graph.project)
    : candidate?.id === projectId ? candidate
    : loaded.has(projectId) ? loaded.get(projectId) : await loadProjectById(projectId);
  if (!local || projectHasGenerating(local)) return;
  const objects = grouped.views.get(projectId) ?? [];
  const remoteObject = objects.at(-1);
  const remoteMeta = remoteObject ? parseSnapshotName(remoteObject.name) : null;
  const editedAt = local.viewportUpdatedAt ?? 0;
  if (remoteObject && (remoteMeta?.editedAt ?? 0) >= editedAt) {
    if ((remoteMeta?.editedAt ?? 0) === editedAt) return;
    // A view received while this project is open is intentionally ignored.
    // It remains available for closed projects, without a camera snap or a
    // content-conflict dialog. Recheck after every await in the inactive path.
    if (useGraphStore.getState().project?.id === projectId) return;
    const remote = await decodeEnvelope(await provider.read(remoteObject));
    if (remote.kind !== 'view' || remote.projectId !== projectId) throw new Error('The synchronized camera view is invalid.');
    if (useGraphStore.getState().project?.id === projectId || getGenProject(projectId)) return;
    // Await in-flight writes and release the cached mirror before reading,
    // so changing only the camera does not reuse an older content snapshot.
    await releaseProjectPersistence(projectId);
    if (useGraphStore.getState().project?.id === projectId || getGenProject(projectId)) return;
    const latest = await loadProjectById(projectId);
    if (!latest || useGraphStore.getState().project?.id === projectId
      || (latest.viewportUpdatedAt ?? 0) >= remote.editedAt) return;
    if (getGenProject(projectId)) return;
    const updated = { ...latest, viewport: clampViewportZoom(remote.viewport), viewportUpdatedAt: remote.editedAt };
    await saveProjectFile(updated);
    adoptProjectPersistenceMirror(updated);
    return;
  }
  const config = useSyncStore.getState().config;
  const envelope: ProjectViewEnvelope = { format: SYNC_FORMAT, formatVersion: SYNC_FORMAT_VERSION,
    kind: 'view', projectId, editedAt, sequence: nextSequence(), deviceId: config.deviceId,
    viewport: local.viewport };
  const object = await provider.write(projectViewName(envelope), await encodeEnvelope(envelope));
  grouped.views.set(projectId, [...objects, object].sort(compareSnapshotObjects));
}

async function reconcilePreferences(
  provider: SyncProvider,
  grouped: ReturnType<typeof groupRemoteObjects>,
  { restoredPreferences, restoredFrom }: { restoredPreferences?: SyncedPreferences; restoredFrom?: number } = {},
): Promise<void> {
  const restoring = restoredPreferences != null;
  const graph = useGraphStore.getState();
  const preferences = restoredPreferences ?? createSyncedPreferences(
    useSettingsStore.getState(),
    graph.projectList.map((project) => project.id),
  );
  const hash = await sha256Hex(JSON.stringify(preferences));
  const ledger = useSyncStore.getState().ledger;
  const latestObject = grouped.preferences.at(-1);
  const latestMeta = latestObject ? parseSnapshotName(latestObject.name) : null;
  if (!restoring && latestMeta?.hash === hash.slice(0, 24)) return;

  if (!restoring && latestObject && (latestMeta?.editedAt ?? 0) > ledger.settingsEditedAt) {
    const envelope = await decodeEnvelope(await provider.read(latestObject));
    if (envelope.kind !== 'preferences') return;
    applyingRemote = true;
    try {
      await applySyncedPreferences(envelope.preferences);
      await applySyncedProjectOrder(envelope.preferences.projectOrder);
    } finally {
      applyingRemote = false;
    }
    updateLedger((current) => ({
      ...current,
      settingsEditedAt: envelope.editedAt,
      settingsHash: envelope.hash,
      ...(envelope.restoredFrom != null ? { restoredSnapshots: { ...current.restoredSnapshots, [latestObject.name]: envelope.restoredFrom } } : {}),
    }));
    return;
  }

  const config = useSyncStore.getState().config;
  // A deliberate restore must become the newest copy, even if another
  // device's clock is ahead. Never download over the user's selected copy.
  const editedAt = restoring
    ? Math.max(Date.now(), ledger.settingsEditedAt, (latestMeta?.editedAt ?? 0) + 1)
    : ledger.settingsEditedAt || Date.now();
  const envelope: PreferencesSnapshotEnvelope = {
    format: SYNC_FORMAT,
    formatVersion: SYNC_FORMAT_VERSION,
    kind: 'preferences',
    editedAt,
    sequence: nextSequence(),
    deviceId: config.deviceId,
    deviceName: config.deviceName,
    hash,
    preferences,
    ...(restoredFrom != null ? { restoredFrom } : {}),
  };
  const name = preferencesSnapshotName(editedAt, envelope.sequence, config.deviceId, hash);
  if (!grouped.preferences.some((object) => object.name === name)) {
    grouped.preferences.push(await provider.write(name, await encodeEnvelope(envelope)));
    grouped.preferences.sort(compareSnapshotObjects);
  }
  updateLedger((current) => ({ ...current, settingsEditedAt: Math.max(editedAt, current.settingsEditedAt), settingsHash: hash,
    ...(restoredFrom != null ? { restoredSnapshots: { ...current.restoredSnapshots, [name]: restoredFrom } } : {}) }));
}

async function trimHistory(provider: SyncProvider, grouped: ReturnType<typeof groupRemoteObjects>): Promise<void> {
  const removals: RemoteObject[] = [];
  // Camera navigation needs only the latest view, not an ever-growing log.
  for (const [projectId, objects] of grouped.views) {
    const deleted = parseSnapshotName(grouped.projects.get(projectId)?.at(-1)?.name ?? '')?.deleted;
    const keep = deleted ? [] : objects.slice(-1);
    removals.push(...objects.slice(0, objects.length - keep.length));
    grouped.views.set(projectId, keep);
  }
  const trimmedProjects = new Set<string>();
  for (const [projectId, objects] of grouped.projects) {
    if (objects.length <= SYNC_HISTORY_LIMIT) continue;
    trimmedProjects.add(projectId);
    const split = objects.length - SYNC_HISTORY_LIMIT;
    removals.push(...objects.slice(0, split));
    grouped.projects.set(projectId, objects.slice(split));
  }
  if (grouped.preferences.length > SYNC_HISTORY_LIMIT) {
    const split = grouped.preferences.length - SYNC_HISTORY_LIMIT;
    removals.push(...grouped.preferences.slice(0, split));
    grouped.preferences.splice(0, split);
  }
  for (const object of removals) await provider.remove(object);

  // Assets have content-addressed names and are shared by every retained
  // history entry. Only inspect them when history was actually trimmed: this
  // avoids repeatedly downloading project snapshots during ordinary polling.
  if (trimmedProjects.size) {
    const retainedAssets = new Set<string>();
    try {
      for (const [projectId, objects] of grouped.projects) {
        if (!trimmedProjects.has(projectId)) continue;
        for (const object of objects) {
          const envelope = await decodeProject(provider, object);
          for (const assetId of envelope.assetIds) retainedAssets.add(`${projectId}\n${assetId}`);
        }
      }
      for (const [key, object] of [...grouped.assets]) {
        if (!trimmedProjects.has(parseSnapshotName(object.name)?.projectId ?? '')) continue;
        if (retainedAssets.has(key)) continue;
        // Another device may have uploaded an asset but not its snapshot yet.
        // Unknown/recent timestamps are not safe evidence of an orphan.
        if (!object.modifiedAt || Date.now() - object.modifiedAt < 24 * 60 * 60 * 1000) continue;
        await provider.remove(object);
        grouped.assets.delete(key);
      }
    } catch (error) {
      // A damaged/unavailable snapshot must never make us guess which binary
      // files are safe to delete. Keeping an orphan is safer than losing media.
      console.warn('[scatter] skipped synchronized asset cleanup', error);
    }
  }
}

async function runCore(manual: boolean, revision: number): Promise<void> {
  const store = useSyncStore.getState();
  if (revision !== syncRunRevision || (!manual && !store.config.enabled) || !store.config.provider || store.remoteUpdate || !isBrowserOnline()) return;
  if (!manual && store.config.provider === 'google-drive' && googleDriveTokenNeedsRefresh()) return;
  store.setRuntime({ running: true, error: null });
  const assertActive = () => {
    if (revision !== syncRunRevision || (!manual && !useSyncStore.getState().config.enabled)) throw new SyncPaused();
  };
  try {
    const guardedProvider = guardProvider(providerFromConfig(), assertActive);
    const index = await openChangeIndex(guardedProvider);
    const provider = index.provider;
    const grouped = groupRemoteObjects(index.objects);
    publishHistory(grouped);

    const graph = useGraphStore.getState();
    const localIds = graph.projectList.map((project) => project.id);
    updateLedger((ledger) => ({
      ...ledger,
      knownProjectIds: [...new Set([...ledger.knownProjectIds, ...localIds])],
    }));
    const ids = new Set([
      ...localIds,
      ...grouped.projects.keys(),
      ...useSyncStore.getState().ledger.knownProjectIds,
    ]);
    const loaded = new Map<string, Project | null>();
    for (const projectId of ids) {
      assertActive();
      const key = `project:${projectId}`;
      const before = localProjectStamp(projectId);
      const latestName = () => grouped.projects.get(projectId)?.at(-1)?.name ?? '';
      const contentUnchanged = useSyncStore.getState().ledger.projects[projectId]?.status === 'synced'
        && index.matches(key, before, latestName());
      if (!contentUnchanged) {
        const active = useGraphStore.getState();
        if (active.project?.id === projectId) await flushProjectPersistence(active.project);
        if (await reconcileProject(provider, grouped, projectId, loaded)) {
          index.forget(key);
          break;
        }
      }
      // Never acknowledge edits made while loading/hashing/uploading the old
      // state. A subsequent pass must still inspect the new local content.
      if (before === localProjectStamp(projectId)
        && useSyncStore.getState().ledger.projects[projectId]?.status === 'synced') {
        index.remember(key, before, latestName());
      } else index.forget(key);
      const viewKey = `view:${projectId}`;
      const beforeView = localViewStamp(projectId);
      const latestViewName = () => grouped.views.get(projectId)?.at(-1)?.name ?? '';
      if (!index.matches(viewKey, beforeView, latestViewName())) {
        await reconcileProjectView(provider, grouped, projectId, loaded);
        if (beforeView === localViewStamp(projectId)) index.remember(viewKey, beforeView, latestViewName());
        else index.forget(viewKey);
      }
    }
    if (!useSyncStore.getState().remoteUpdate) {
      assertActive();
      const restoredOrder = useSyncStore.getState().ledger.restoredProjectOrder;
      if (restoredOrder) {
        applyingRemote = true;
        try { await applySyncedProjectOrder(restoredOrder); } finally { applyingRemote = false; }
        updateLedger(current => ({ ...current, restoredProjectOrder: undefined }));
      }
      const before = localPreferencesStamp();
      if (!index.matches('preferences', before, grouped.preferences.at(-1)?.name ?? '')) {
        await reconcilePreferences(provider, grouped);
        if (before === localPreferencesStamp()) {
          index.remember('preferences', before, grouped.preferences.at(-1)?.name ?? '');
        } else index.forget('preferences');
      }
    }
    const cachedTitles = useSyncStore.getState().ledger.historyTitles ?? {};
    const historyTitles = await resolveHistoryTitles(
      provider, grouped.projects, cachedTitles,
      new Map(useGraphStore.getState().projectList.map((project) => [project.id, project.name])),
    );
    updateLedger((ledger) => ({ ...ledger, historyTitles: {
      ...historyTitles,
      // Do not overwrite a rename/deletion made while remote reads were pending.
      ...Object.fromEntries(Object.entries(ledger.historyTitles ?? {})
        .filter(([id, title]) => title !== cachedTitles[id])),
    } }));
    await trimHistory(provider, grouped);
    assertActive();
    await index.commit();
    publishHistory(grouped);
    const completedAt = Date.now();
    updateLedger((ledger) => ({ ...ledger, lastSyncedAt: completedAt }));
    if (!useSyncStore.getState().remoteUpdate) lastSuccessfulSyncAt = completedAt;
    useSyncStore.getState().setRuntime({ running: false, error: null });
  } catch (error) {
    if (error instanceof SyncPaused || revision !== syncRunRevision) {
      useSyncStore.getState().setRuntime({ running: false });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const current = useSyncStore.getState();
    const projects = { ...current.ledger.projects };
    const projectIds = new Set([
      ...Object.keys(projects),
      ...useGraphStore.getState().projectList.map((project) => project.id),
    ]);
    for (const id of projectIds) {
      const entry = projects[id];
      projects[id] = {
        projectId: id,
        localEditedAt: entry?.localEditedAt ?? 0,
        ...entry,
        status: 'paused',
        error: message,
      };
    }
    updateLedger((ledger) => ({ ...ledger, projects }));
    if (error instanceof GoogleDriveReconnectRequired) requireGoogleDriveReconnect(message);
    else current.setRuntime({ running: false, error: message });
    throw error;
  }
}

async function runWithLeaderLock(manual: boolean, revision: number): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    await navigator.locks.request('scatter-cloud-sync', { ifAvailable: true }, async (lock) => {
      if (lock) await runCore(manual, revision);
    });
    return;
  }
  await runCore(manual, revision);
}

/** Manual runs bypass the automatic-sync preference for one pass only. */
export function requestSyncNow(options: { manual?: boolean } = {}): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  const manual = options.manual === true;
  const store = useSyncStore.getState();
  if ((!manual && !store.config.enabled) || !store.config.provider || store.remoteUpdate || !isBrowserOnline()) return Promise.resolve();
  const revision = syncRunRevision;
  if (inFlight) {
    if (!manual || inFlightRevision === revision) return inFlight;
    // A just-paused run may still be finishing a request. Start authorization
    // in this click, then queue the explicit pass behind that cancelled run.
    const authorization = store.config.provider === 'google-drive' ? ensureGoogleDriveAccessToken() : Promise.resolve();
    return Promise.all([inFlight.catch(() => undefined), authorization]).then(() => {
      if (revision === syncRunRevision) return requestSyncNow(options);
    });
  }
  inFlightRevision = revision;
  const operation = (async () => {
    if (manual && store.config.provider === 'google-drive') {
      store.setRuntime({ running: true, error: null });
      await ensureGoogleDriveAccessToken();
      if (revision !== syncRunRevision) return;
    }
    await runWithLeaderLock(manual, revision);
  })().catch(error => {
    if (revision !== syncRunRevision) return;
    useSyncStore.getState().setRuntime({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  }).finally(() => {
    // A history action may already be queued behind this pass.
    if (inFlight !== operation) return;
    useSyncStore.getState().setRuntime({ running: false });
    inFlight = null;
    if (revision !== syncRunRevision && useSyncStore.getState().config.enabled) scheduleSync(0);
  });
  inFlight = operation;
  return operation;
}

/** Serialize history mutations with sync passes, including those in other tabs. */
function withSyncHistoryLock(action: (provider: SyncProvider, assertActive: () => void) => Promise<void>): Promise<void> {
  const config = useSyncStore.getState().config;
  const revision = syncRunRevision;
  const previous = inFlight;
  const assertActive = () => {
    const current = useSyncStore.getState().config;
    if (revision !== syncRunRevision || current.provider !== config.provider
      || (current.provider === 'webdav' && current.webdav !== config.webdav)) {
      throw new Error('The sync connection changed. Reopen snapshot history and try again.');
    }
  };
  const run = async () => {
    assertActive();
    const provider = guardProvider(providerFromConfig(), assertActive);
    await action(provider, assertActive);
  };
  // Request Google authorization within the user gesture, not after waiting
  // for an earlier sync pass (browsers would otherwise block its popup).
  const authorization = config.provider === 'google-drive' ? ensureGoogleDriveAccessToken() : Promise.resolve();
  const operation = (async () => {
    const [, auth] = await Promise.allSettled([previous, authorization]);
    if (auth.status === 'rejected') throw auth.reason;
    assertActive();
    useSyncStore.getState().setRuntime({ running: true });
    if (typeof navigator !== 'undefined' && navigator.locks) {
      // Unlike background sync, an explicit history action waits for the lock.
      await navigator.locks.request('scatter-cloud-sync', run);
    } else await run();
  })().finally(() => {
    if (inFlight !== operation) return;
    useSyncStore.getState().setRuntime({ running: false });
    inFlight = null;
    // Do not lose local edits made while the history action held the lock.
    if (useSyncStore.getState().config.enabled) scheduleSync();
  });
  inFlightRevision = revision;
  inFlight = operation;
  return operation;
}

/** Delete an older recovery copy, never the authoritative sync head or assets.
 * This permanent cloud action intentionally does not enter app undo/redo. */
export function deleteSyncHistoryEntry(entry: SyncHistoryEntry): Promise<void> {
  const parsed = parseSnapshotName(entry.object.name);
  if (!parsed || (parsed.kind !== 'project' && parsed.kind !== 'preferences')) {
    return Promise.reject(new Error('Choose a project or app-settings snapshot to delete.'));
  }
  return withSyncHistoryLock(async provider => {
    // Recheck against a fresh listing: another device or retention cleanup may
    // have changed the history since it was displayed.
    const objects = await provider.list();
    const grouped = groupRemoteObjects(objects);
    const object = objects.find(candidate => candidate.id === entry.object.id && candidate.name === entry.object.name);
    if (!object) { publishHistory(grouped); return; }
    const history = parsed.kind === 'preferences' ? grouped.preferences : grouped.projects.get(parsed.projectId!) ?? [];
    if (history.at(-1)?.id === object.id) {
      publishHistory(grouped);
      throw new Error('The latest snapshot is required for syncing and cannot be deleted.');
    }
    await provider.remove(object);
    publishHistory(groupRemoteObjects(objects.filter(candidate => candidate.id !== object.id)));
  });
}

export function scheduleSync(delay = QUIET_SYNC_MS): void {
  if (!useSyncStore.getState().config.enabled) return;
  if (!isBrowserOnline()) {
    if (timer) clearTimeout(timer);
    timer = null;
    return;
  }
  const config = useSyncStore.getState().config;
  if (config.provider === 'google-drive' && googleDriveTokenNeedsRefresh()) {
    if (timer) clearTimeout(timer);
    timer = null;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void requestSyncNow().catch((error) => console.error('[scatter] sync paused', error));
  }, delay);
}

export async function resolveRemoteProjectUpdate(choice: 'cloud' | 'local'): Promise<void> {
  const update = useSyncStore.getState().remoteUpdate;
  if (!update) return;
  const revision = syncRunRevision;
  const assertActive = () => {
    if (revision !== syncRunRevision || useSyncStore.getState().remoteUpdate !== update) throw new SyncPaused();
  };
  try {
    if (useSyncStore.getState().config.provider === 'google-drive') await ensureGoogleDriveAccessToken();
    if (inFlight) await inFlight.catch(() => undefined);
    assertActive();
    const provider = guardProvider(providerFromConfig(), assertActive);
    const grouped = groupRemoteObjects(await provider.list());
    if (choice === 'cloud') {
      // Preserve the rejected local state as an older recovery snapshot without
      // making it win over the user's chosen cloud copy.
      const recoveryTime = Math.min(update.local.updatedAt, update.remote.editedAt - 1);
      await uploadProject(provider, grouped, update.local, Math.max(1, recoveryTime));
      assertActive();
      applyingRemote = true;
      try { await installRemoteProject(provider, grouped, update.remote, update.local, assertActive); } finally { applyingRemote = false; }
    } else {
      const editedAt = Math.max(Date.now(), update.remote.editedAt + 1);
      await uploadProject(provider, grouped, update.local, editedAt);
    }
    assertActive();
    useSyncStore.getState().setRuntime({ remoteUpdate: null });
    await requestSyncNow({ manual: true });
  } catch (error) {
    if (error instanceof SyncPaused || revision !== syncRunRevision) return;
    throw error;
  }
}

export function restoreProjectHistory(entry: SyncHistoryEntry): Promise<void> {
  // A cloud restore is an explicit replacement, outside app undo/redo. Its
  // recovery copies remain in cloud history.
  return withSyncHistoryLock(async (provider, assertActive) => {
    const envelope = await decodeProject(provider, entry.object);
    if (envelope.deleted || !envelope.project) throw new Error('Choose a non-deleted project version to restore.');
    const local = getGenProject(envelope.projectId) ?? await loadProjectById(envelope.projectId);
    const assertReady = () => {
      assertActive();
      const live = getGenProject(envelope.projectId) ?? local;
      if (live && projectHasGenerating(live)) throw new Error('Stop generation in this project before restoring a snapshot.');
    };
    assertReady();
    const grouped = groupRemoteObjects(await provider.list());
    const latest = grouped.projects.get(envelope.projectId)?.at(-1);
    const editedAt = Math.max(Date.now(), (latest ? parseSnapshotName(latest.name)?.editedAt ?? 0 : 0) + 1,
      (useSyncStore.getState().ledger.projects[envelope.projectId]?.localEditedAt ?? 0) + 1);
    const restored = { ...envelope.project, updatedAt: editedAt };
    await downloadAssets(provider, grouped, envelope);
    assertReady();
    // Do not replace local content until the new authoritative copy is safe
    // in the cloud. Install that exact envelope, with its NEW timestamp/hash.
    const published = await uploadProject(provider, grouped, restored, editedAt, false, undefined, envelope.editedAt);
    assertReady();
    applyingRemote = true;
    let installed: Project | undefined;
    try { installed = await installRemoteProject(provider, grouped, published, local ?? undefined, assertReady); }
    finally { applyingRemote = false; }
    // Permanent source deletions are retained when installing an old copy.
    if (installed && await projectHash(installed) !== published.hash) {
      await uploadProject(provider, grouped, installed, editedAt, false, undefined, envelope.editedAt);
    }
    if (useSyncStore.getState().remoteUpdate?.projectId === envelope.projectId) {
      useSyncStore.getState().setRuntime({ remoteUpdate: null });
    }
    publishHistory(grouped);
    await flushSyncPersistence();
  });
}

/** Onboarding is download-first: never publish empty local preferences while
 * discovering a saved setup. Keep sync paused until the user finishes setup. */
export async function restoreSetupFromSync(): Promise<void> {
  stopScheduledSync();
  await useSyncStore.getState().patchConfig({ enabled: false });
  if (inFlight) await inFlight.catch(() => undefined);
  const provider = providerFromConfig();
  const objects = await provider.list();
  const latest = groupRemoteObjects(objects).preferences.at(-1);
  if (!latest) throw new Error('No saved app settings were found in this sync location. Choose another connection or use quick setup.');
  const envelope = await decodeEnvelope(await provider.read(latest));
  if (envelope.kind !== 'preferences') throw new Error('This cloud snapshot does not contain app settings.');
  applyingRemote = true;
  try {
    await applySyncedPreferences(envelope.preferences);
    await useSyncStore.getState().replaceLedger({ ...useSyncStore.getState().ledger,
      settingsEditedAt: envelope.editedAt, settingsHash: envelope.hash,
      restoredProjectOrder: envelope.preferences.projectOrder });
    await flushSyncPersistence();
  } finally { applyingRemote = false; }
}

export function restorePreferencesHistory(entry: SyncHistoryEntry): Promise<void> {
  return withSyncHistoryLock(async (provider, assertActive) => {
    const envelope = await decodeEnvelope(await provider.read(entry.object));
    if (envelope.kind !== 'preferences') throw new Error('Expected synchronized preferences.');
    const grouped = groupRemoteObjects(await provider.list());
    // Publish before applying, so a failed upload leaves local settings alone.
    await reconcilePreferences(provider, grouped, {
      restoredPreferences: createSyncedPreferences(envelope.preferences.settings, envelope.preferences.projectOrder),
      restoredFrom: envelope.editedAt,
    });
    assertActive();
    applyingRemote = true;
    try {
      await applySyncedPreferences(envelope.preferences);
      await applySyncedProjectOrder(envelope.preferences.projectOrder);
    } finally { applyingRemote = false; }
    publishHistory(grouped);
    await flushSyncPersistence();
  });
}

export async function initializeSyncCoordinator(): Promise<() => void> {
  if (initialized) return () => undefined;
  initialized = true;
  try {
    await useSyncStore.getState().hydrate();
  } catch (error) {
    initialized = false;
    throw error;
  }

  const initialSyncConfig = useSyncStore.getState().config;
  let driveRefreshCleanup: (() => void) | null = null;
  let driveRefreshSetupPending = false;
  let driveRefreshGeneration = 0;
  const googleSyncEnabled = () => {
    const config = useSyncStore.getState().config;
    return config.enabled && config.provider === 'google-drive';
  };
  const updateDriveRefresh = () => {
    if (!googleSyncEnabled()) {
      driveRefreshGeneration += 1;
      driveRefreshSetupPending = false;
      driveRefreshCleanup?.();
      driveRefreshCleanup = null;
      useSyncStore.getState().setRuntime({ googleDriveReconnectRequired: false });
      return;
    }
    if (!isBrowserOnline()) return;
    if (driveRefreshCleanup || driveRefreshSetupPending) return;
    driveRefreshSetupPending = true;
    const generation = ++driveRefreshGeneration;
    void installGoogleDriveGestureRefresh({
      shouldRefresh: googleSyncEnabled,
      onRefreshed: () => {
        if (!googleSyncEnabled()) return;
        useSyncStore.getState().setRuntime({ error: null, googleDriveReconnectRequired: false });
        scheduleSync(0);
      },
      onError: (error) => {
        if (!googleSyncEnabled()) return;
        if (!isBrowserOnline()) return;
        if (error instanceof GoogleDriveAuthorizationRejected) {
          requireGoogleDriveReconnect(error.message);
          return;
        }
        // Loading Google Identity or reaching Google can fail temporarily.
        // Keep local work pending and retry on a later real user gesture.
        if (isBrowserOnline()) useSyncStore.getState().setRuntime({ error: error.message });
      },
    }).then((cleanup) => {
      driveRefreshSetupPending = false;
      if (generation !== driveRefreshGeneration || !googleSyncEnabled()) cleanup();
      else driveRefreshCleanup = cleanup;
    }).catch((error) => {
      driveRefreshSetupPending = false;
      if (generation === driveRefreshGeneration && googleSyncEnabled()) {
        useSyncStore.getState().setRuntime({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };
  updateDriveRefresh();
  const unsubscribeDriveRefresh = useSyncStore.subscribe((state, previous) => {
    if (state.config !== previous.config) updateDriveRefresh();
  });
  cleanupCallbacks.push(() => {
    driveRefreshGeneration += 1;
    driveRefreshCleanup?.();
    driveRefreshCleanup = null;
    unsubscribeDriveRefresh();
  });

  cleanupCallbacks.push(useGraphStore.subscribe((state, previous) => {
    if (applyingRemote) return;
    if (state.project && state.project !== previous.project
        && projectContentChanged(state.project, previous.project)) {
      markProjectDirty(state.project.id, state.project.updatedAt, false, state.project.name);
    }
    if (state.project?.id === previous.project?.id
      && state.project?.viewport !== previous.project?.viewport) scheduleSync();
    if (state.projectList !== previous.projectList) {
      const ids = state.projectList.map((project) => project.id);
      const previousById = new Map(previous.projectList.map((project) => [project.id, project]));
      for (const id of previousById.keys()) {
        if (!ids.includes(id)) markProjectDirty(id, Date.now(), true, previousById.get(id)?.name);
      }
      for (const project of state.projectList) {
        const before = previousById.get(project.id);
        // Replaced metadata is also a dirty signal: two inactive-project
        // writes can have the same timestamp and unchanged title/color.
        if (project !== before) {
          markProjectDirty(project.id, project.updatedAt, false, project.name);
        }
      }
      markPreferencesDirty();
    }
  }));

  cleanupCallbacks.push(useSettingsStore.subscribe((state, previous) => {
    if (applyingRemote) return;
    if (SETTINGS_FIELD_NAMES.some((field) => state[field] !== previous[field])) markPreferencesDirty();
  }));
  // Focus and visibility often fire together. Share one debounced request and
  // ignore a quick return after a successful pass; edits/manual sync bypass it.
  const onReturn = () => {
    if (!document.hidden && Date.now() - lastSuccessfulSyncAt >= RETURN_COOLDOWN_MS) scheduleSync(0);
  };
  const onNetworkChange = () => {
    if (isBrowserOnline()) {
      // Identity-script setup may have been deferred while offline. Prepare it
      // now; if the token is stale, the next real gesture performs renewal.
      updateDriveRefresh();
    }
    scheduleSync(0);
  };
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);
  const unsubscribeNetwork = subscribeNetworkStatus(onNetworkChange);
  cleanupCallbacks.push(() => window.removeEventListener('focus', onReturn));
  cleanupCallbacks.push(() => document.removeEventListener('visibilitychange', onReturn));
  cleanupCallbacks.push(unsubscribeNetwork);
  pollTimer = setInterval(() => { if (!document.hidden) scheduleSync(0); }, POLL_MS);
  cleanupCallbacks.push(() => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; });

  if (initialSyncConfig.enabled
    && (initialSyncConfig.provider !== 'google-drive' || !googleDriveTokenNeedsRefresh())) {
    scheduleSync(0);
  }
  return shutdownSyncCoordinator;
}

export function shutdownSyncCoordinator(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const cleanup of cleanupCallbacks.splice(0)) cleanup();
  initialized = false;
  lastSuccessfulSyncAt = 0;
}

/** An import changes the destination as well as preferences. Finish existing
 * sync work and local metadata writes before installing the replacement. */
export async function suspendSyncForSettingsImport(): Promise<() => Promise<void>> {
  const wasInitialized = initialized;
  shutdownSyncCoordinator();
  await inFlight?.catch(() => undefined);
  shutdownSyncCoordinator();
  try { await flushSyncPersistence(); } catch (error) {
    if (wasInitialized) await initializeSyncCoordinator();
    throw error;
  }
  return async () => { if (wasInitialized) await initializeSyncCoordinator(); };
}
