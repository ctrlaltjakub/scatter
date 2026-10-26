import { decodeEnvelope, parseSnapshotName } from './codec';
import type { RemoteObject, SyncLedger, SyncProvider } from './types';
import type { SyncHistoryEntry } from '@/store/useSyncStore';

/** Limit the selector, not cloud retention: older projects remain recoverable remotely. */
export function historyProjectGroups(history: Record<string, SyncHistoryEntry[]>, localIds: Set<string>) {
  const latest = (id: string) => history[id]?.reduce<SyncHistoryEntry | undefined>(
    (newest, entry) => !newest || entry.editedAt > newest.editedAt ? entry : newest, undefined);
  const deleted = (id: string) => !localIds.has(id) && latest(id)?.deleted === true;
  const ids = Object.keys(history);
  return {
    active: ids.filter(id => !deleted(id)),
    deleted: ids.filter(deleted).sort((a, b) => (latest(b)?.editedAt ?? 0) - (latest(a)?.editedAt ?? 0)).slice(0, 5),
  };
}

/** Recover legacy names from retained content, without downloading assets or
 * installing/restoring projects. Cache by immutable snapshot name, not local presence. */
export async function resolveHistoryTitles(
  provider: SyncProvider,
  projects: Map<string, RemoteObject[]>,
  cached: NonNullable<SyncLedger['historyTitles']>,
  localNames: Map<string, string>,
): Promise<NonNullable<SyncLedger['historyTitles']>> {
  const titles = { ...cached };
  const pending = [...projects.entries()];
  const worker = async () => {
    for (let entry = pending.shift(); entry; entry = pending.shift()) {
      const [projectId, objects] = entry;
      const latest = objects.at(-1);
      if (!latest) continue;
      const localName = localNames.get(projectId);
      if (localName) {
        titles[projectId] = { name: localName, snapshotName: latest.name };
        continue;
      }
      if (cached[projectId]?.snapshotName === latest.name) continue;
      try {
        const readName = async (object: RemoteObject) => {
          const snapshot = await decodeEnvelope(await provider.read(object));
          if (snapshot.kind !== 'project' || snapshot.projectId !== projectId) return undefined;
          return snapshot.projectName?.trim() || snapshot.project?.name?.trim() || undefined;
        };
        let name = await readName(latest);
        if (!name && parseSnapshotName(latest.name)?.deleted) {
          const previous = [...objects].reverse().find((object) => !parseSnapshotName(object.name)?.deleted);
          if (previous) name = await readName(previous);
        }
        titles[projectId] = { name: name ?? cached[projectId]?.name, snapshotName: latest.name };
      } catch (error) {
        // Name recovery must not block synchronization. Retry failed reads on
        // the next pass, but cache successful unnamed legacy tombstones too.
        console.warn('[scatter] could not read a sync history title', error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  return titles;
}

export function historyProjectLabel(name: string | undefined, deleted: boolean): string {
  return `${name?.trim() || 'Untitled project'}${deleted ? ' (deleted)' : ''}`;
}
