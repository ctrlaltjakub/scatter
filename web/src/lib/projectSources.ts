import type {
  Project,
  ProjectSource,
  ProjectSourceLibrary,
  ProjectSourceMode,
  ProjectSourceRevision,
} from '@/store/types';

export const EMPTY_SOURCE_LIBRARY: Readonly<ProjectSourceLibrary> = Object.freeze({
  mode: 'ignore',
  order: Object.freeze([]) as unknown as string[],
  sources: Object.freeze({}) as Record<string, ProjectSource>,
});

export function sourceLibrary(project: Project | null | undefined): ProjectSourceLibrary {
  return project?.sourceLibrary ?? EMPTY_SOURCE_LIBRARY;
}

export function orderedSources(library: ProjectSourceLibrary): ProjectSource[] {
  const seen = new Set<string>();
  const ordered: ProjectSource[] = [];
  for (const id of library.order) {
    const source = library.sources[id];
    if (!source || seen.has(id)) continue;
    seen.add(id);
    ordered.push(source);
  }
  for (const [id, source] of Object.entries(library.sources)) {
    if (!seen.has(id)) ordered.push(source);
  }
  return ordered;
}

export function activeProjectSources(library: ProjectSourceLibrary): ProjectSource[] {
  return orderedSources(library).filter((source) => source.checked);
}

export function effectiveSourceMode(library: ProjectSourceLibrary): ProjectSourceMode {
  if (activeProjectSources(library).length === 0) return 'ignore';
  return library.mode;
}

export function activeRevision(source: ProjectSource): ProjectSourceRevision | undefined {
  return source.revisions[source.activeRevisionId];
}

export function withSourceMode(
  library: ProjectSourceLibrary,
  mode: ProjectSourceMode,
): ProjectSourceLibrary {
  return {
    ...library,
    mode,
    ...(mode === 'ignore' ? {} : { rememberedNonIgnoreMode: mode }),
  };
}

export function withSourceChecked(
  library: ProjectSourceLibrary,
  sourceId: string,
  checked: boolean,
): ProjectSourceLibrary {
  const source = library.sources[sourceId];
  if (!source || source.checked === checked) return library;
  return {
    ...library,
    sources: { ...library.sources, [sourceId]: { ...source, checked } },
  };
}

export function withAllSourcesChecked(
  library: ProjectSourceLibrary,
  checked: boolean,
): ProjectSourceLibrary {
  let changed = false;
  const sources: Record<string, ProjectSource> = {};
  for (const [id, source] of Object.entries(library.sources)) {
    sources[id] = source.checked === checked ? source : { ...source, checked };
    changed ||= source.checked !== checked;
  }
  return changed ? { ...library, sources } : library;
}

export function publishReadySource(
  library: ProjectSourceLibrary,
  source: ProjectSource,
): ProjectSourceLibrary {
  const existed = Boolean(library.sources[source.id]);
  const firstSource = Object.keys(library.sources).length === 0;
  return {
    ...library,
    mode: firstSource && library.mode === 'ignore' ? 'use' : library.mode,
    rememberedNonIgnoreMode: firstSource && library.mode === 'ignore'
      ? 'use'
      : library.rememberedNonIgnoreMode,
    order: existed ? library.order : [source.id, ...library.order],
    sources: { ...library.sources, [source.id]: source },
  };
}

export function removeReadySource(
  library: ProjectSourceLibrary,
  sourceId: string,
  deletedAt = Date.now(),
): ProjectSourceLibrary {
  if (!library.sources[sourceId]) return library;
  const sources = { ...library.sources };
  delete sources[sourceId];
  return {
    ...library,
    sources,
    order: library.order.filter((id) => id !== sourceId),
    tombstones: { ...(library.tombstones ?? {}), [sourceId]: { deletedAt } },
  };
}

export function reorderSourceIds(
  library: ProjectSourceLibrary,
  fromId: string,
  toId: string,
): ProjectSourceLibrary {
  if (fromId === toId) return library;
  const order = orderedSources(library).map((source) => source.id);
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0) return library;
  const [moved] = order.splice(from, 1);
  if (!moved) return library;
  order.splice(to, 0, moved);
  return { ...library, order };
}

export function findDuplicateSource(
  library: ProjectSourceLibrary,
  contentHash: string,
): ProjectSource | undefined {
  return Object.values(library.sources).find((source) => source.contentHash === contentHash);
}

export function uniqueSourceTitle(library: ProjectSourceLibrary, requested: string): string {
  const clean = requested.trim() || 'Untitled source';
  const existing = new Set(Object.values(library.sources).map((source) => source.title.toLocaleLowerCase()));
  if (!existing.has(clean.toLocaleLowerCase())) return clean;
  let suffix = 2;
  while (existing.has(`${clean} (${suffix})`.toLocaleLowerCase())) suffix += 1;
  return `${clean} (${suffix})`;
}

export function sourceAssetIds(library: ProjectSourceLibrary): {
  eager: Set<string>;
  lazy: Set<string>;
} {
  const eager = new Set<string>();
  const lazy = new Set<string>();
  for (const source of Object.values(library.sources)) {
    for (const revision of Object.values(source.revisions)) {
      eager.add(revision.contentAssetId);
      eager.add(revision.keywordIndexAssetId);
      if (revision.embeddingIndexAssetId) eager.add(revision.embeddingIndexAssetId);
      if (revision.originalAssetId) lazy.add(revision.originalAssetId);
    }
  }
  return { eager, lazy };
}

export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256Blob(blob: Blob): Promise<string> {
  return sha256Bytes(await blob.arrayBuffer());
}

export async function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text).buffer);
}
