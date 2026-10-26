import { readJSON, writeJSON } from '@/opfs/storage';
import { parseSnapshotName } from './codec';
import type { RemoteObject, SyncProvider } from './types';

const INDEX_PATH = 'sync/change-index.json';
export const SYNC_INDEX_MAX_OBJECTS = 10_000;
export const SYNC_INDEX_MAX_BYTES = 4 * 1024 * 1024;

interface Checkpoint { local: string; remote: string; }
interface ChangeIndex {
  schemaVersion: 1;
  scope: string;
  cursor: string;
  objects: RemoteObject[];
  checks: Record<string, Checkpoint>;
}

function validIndex(value: unknown, scope: string): value is ChangeIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as ChangeIndex;
  return index.schemaVersion === 1 && index.scope === scope
    && typeof index.cursor === 'string' && index.cursor.length > 0
    && Array.isArray(index.objects) && index.objects.length <= SYNC_INDEX_MAX_OBJECTS
    && index.objects.every((object) => object && typeof object.id === 'string'
      && typeof object.name === 'string' && parseSnapshotName(object.name))
    && !!index.checks && typeof index.checks === 'object' && !Array.isArray(index.checks)
    && Object.keys(index.checks).length <= SYNC_INDEX_MAX_OBJECTS
    && Object.values(index.checks).every((check) => check && typeof check.local === 'string' && typeof check.remote === 'string')
    && new Blob([JSON.stringify(index)]).size <= SYNC_INDEX_MAX_BYTES;
}

/** Disposable, bounded materialized view of the provider's native change feed.
 * No shared mutable manifest: simultaneous devices cannot overwrite each
 * other's index. The cursor and its complete catalog are committed together,
 * only after a successful pass. Interrupted passes can replay safely.
 */
export async function openChangeIndex(source: SyncProvider) {
  const scope = source.indexScope ? await source.indexScope() : '';
  let previous: ChangeIndex | null = null;
  if (scope) {
    try {
      const raw = await readJSON(INDEX_PATH, { allowEmpty: true });
      if (validIndex(raw, scope)) previous = raw;
    } catch {
      // This is only a cache. Corruption must cause a full scan, never data loss.
    }
  }
  const changes = source.changes
    ? await source.changes(previous?.cursor)
    : { reset: true, objects: await source.list(), removedIds: [], cursor: 'listing' };
  if (!changes.reset && !previous) throw new Error('A sync change feed requires a complete initial listing.');
  const objects = new Map((changes.reset ? [] : previous!.objects).map((object) => [object.id, object]));
  for (const id of changes.removedIds) objects.delete(id);
  for (const object of changes.objects) {
    if (parseSnapshotName(object.name)) objects.set(object.id, object);
    else objects.delete(object.id);
  }
  // A rejected/expired cursor must also recheck local content once.
  const checks: Record<string, Checkpoint> = changes.reset ? {} : { ...previous!.checks };
  // Listing-only servers still benefit from skipping unchanged local projects.
  if (previous && changes.cursor === 'listing') Object.assign(checks, previous.checks);

  const provider: SyncProvider = {
    kind: source.kind,
    test: () => source.test(),
    list: () => source.list(),
    read: (object) => source.read(object),
    write: async (name, data) => {
      const object = await source.write(name, data);
      objects.set(object.id, object);
      return object;
    },
    remove: async (object) => {
      await source.remove(object);
      objects.delete(object.id);
    },
  };

  return {
    provider,
    objects: [...objects.values()],
    matches: (key: string, local: string, remote: string) => checks[key]?.local === local && checks[key]?.remote === remote,
    remember: (key: string, local: string, remote: string) => { checks[key] = { local, remote }; },
    forget: (key: string) => { delete checks[key]; },
    async commit() {
      if (!scope) return;
      // Keep one checkpoint per current remote project/settings entry. Deleted
      // file IDs and abandoned checkpoints disappear instead of forming a log.
      const retainedKeys = new Set<string>();
      for (const object of objects.values()) {
        const parsed = parseSnapshotName(object.name);
        if (parsed?.kind === 'project') retainedKeys.add(`project:${parsed.projectId}`);
        if (parsed?.kind === 'view') retainedKeys.add(`view:${parsed.projectId}`);
        if (parsed?.kind === 'preferences') retainedKeys.add('preferences');
      }
      const index: ChangeIndex = {
        schemaVersion: 1, scope, cursor: changes.cursor, objects: [...objects.values()],
        checks: Object.fromEntries(Object.entries(checks).filter(([key]) => retainedKeys.has(key))),
      };
      // Never truncate a catalog while keeping its cursor: that could hide
      // unchanged remote files forever. Oversized collections use a full scan.
      const withinLimit = objects.size <= SYNC_INDEX_MAX_OBJECTS
        && Object.keys(index.checks).length <= SYNC_INDEX_MAX_OBJECTS
        && new Blob([JSON.stringify(index)]).size <= SYNC_INDEX_MAX_BYTES;
      try {
        await writeJSON(INDEX_PATH, withinLimit ? index : null);
      } catch (error) {
        console.warn('[scatter] could not cache sync index; next sync can rebuild it', error);
      }
    },
  };
}
