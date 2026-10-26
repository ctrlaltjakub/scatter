export const LAST_GROUPS_STORAGE_KEY = 'scatter.sidebar.lastGroups.v1';

export type LastGroupMemory = Record<string, string>;

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function normalizeLastGroupMemory(value: unknown): LastGroupMemory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

export function readLastGroupMemory(storage: Storage | null = browserStorage()): LastGroupMemory {
  if (!storage) return {};
  try {
    return normalizeLastGroupMemory(
      JSON.parse(storage.getItem(LAST_GROUPS_STORAGE_KEY) ?? '{}') as unknown,
    );
  } catch {
    return {};
  }
}

export function writeLastGroupMemory(
  memory: LastGroupMemory,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LAST_GROUPS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage can be unavailable in private browsing; the runtime value still works.
  }
}
