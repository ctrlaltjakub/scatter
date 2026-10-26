import { migrateInteractiveNodes } from '@/lib/migrateInteractiveNodes';
import { pruneInheritedGoogleSearchSuggestions } from '@/lib/googleSearchSuggestions';
import { useGraphStore, createBlankProject } from './useGraphStore';
import { foldRuntimeIntoProject, activeIdxSeedEntries, withPersistedViewport } from './foldRuntime';
import { useActiveIdxStore } from './useActiveIdxStore';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import {
  loadProjectsIndex, saveProjectsIndex,
  loadProjectById, saveProjectFile, deleteProjectFile, metaOf,
} from '@/opfs/projectsIO';
import { loadProject as loadLegacyProject, deleteLegacyProjectFile, stripTransient } from '@/opfs/projectIO';
import { projectHasGenerating, stashDetached, takeDetached, dropDetached } from './bgGen';
import {
  adoptProjectPersistenceMirror,
  flushProjectPersistence,
  releaseProjectPersistence,
} from './projectPersistence';
import { useMediaUrlStore } from './useMediaUrlStore';
import { sweepOrphanAssets, deleteProjectAssets, loadAsset, saveAsset } from '@/opfs/assetsIO';
import {
  copySourceAsset,
  deleteProjectSourceAssets,
  saveSourceAsset,
  sweepOrphanSourceAssets,
} from '@/opfs/sourceAssetsIO';
import { sourceAssetIds } from '@/lib/projectSources';
import { ensureProjectColor } from '@/lib/groupHierarchy';
import { buildProjectZip, parseProjectZip } from '@/lib/projectTransfer';
import { sanitizeFilename } from '@/lib/download';
import { newId } from '@/lib/ids';
import { localChatDraftAssetIds } from './useChatRuntimeStore';
import {
  collectAutomaticBranchNodeIds,
  collectReferencedAssetIds,
  collectReferencedProjectAssets,
  copyBranchIntoProject,
} from '@/lib/projectBranch';
import { resolveColorHex } from '@/lib/groupColor';
import { hexToOklch } from '@/lib/oklch';
import type {
  GroupColor,
  GroupColorAssignment,
  Project,
  ProjectMeta,
} from './types';

/**
 * Multi-scatter orchestration. Kept OUTSIDE the zustand store (like generate.ts)
 * because these flows do file I/O and coordinate several stores: the graph
 * store (active project + registry), the runtime position/anchor/viewport
 * stores, the temporal (undo) store, and the OPFS persistence layer.
 *
 * Invariants:
 *   - There is always at least one scatter; the active one is loaded into
 *     `useGraphStore.project`, the rest live only as `ProjectMeta` rows + their
 *     own `projects/<id>.json` files.
 *   - Undo history is PER-SCATTER: every switch/load clears the temporal stack
 *     so an undo in scatter B can never reach back into scatter A.
 */

/** Replace (by id) or append a metadata row. */
function upsertMeta(list: ProjectMeta[], meta: ProjectMeta): ProjectMeta[] {
  const i = list.findIndex((m) => m.id === meta.id);
  if (i === -1) return [...list, meta];
  const next = list.slice();
  next[i] = meta;
  return next;
}

/** True when a scatter name is one this app auto-assigned (vs. user-chosen).
 *  Used to decide whether AI auto-naming may overwrite it. */
export function isAutoScatterName(name: string): boolean {
  // Matches both the current "project" defaults and the older "scatter"
  // defaults (so projects created before the rename can still be auto-named).
  return /^(My|New|Untitled) (project|scatter)( \d+)?$/.test(name.trim());
}

/** Pick a name not already used in the list (base, "base 2", "base 3", …). */
function uniqueScatterName(list: ProjectMeta[], base: string): string {
  const names = new Set(list.map((m) => m.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Save the registry (`projects/index.json`) from current store state. */
async function persistIndex(): Promise<void> {
  const s = useGraphStore.getState();
  await saveProjectsIndex({ activeId: s.activeProjectId, items: s.projectList });
}

/**
 * Make `project` the active scatter in memory, resetting every piece of
 * transient/runtime state so nothing bleeds from the previous scatter:
 *   - rope anchors cleared (they re-settle from physics)
 *   - live node positions reseeded from the project's saved positions
 *   - live camera reseeded from the project's saved viewport
 *   - search query + selected group cleared
 *   - undo history cleared (per-scatter) — done LAST, after setProject pushes
 *     the swap onto the temporal stack.
 */
function loadIntoStore(project: Project, preserveOpenView = false): void {
  // A project loaded or completely written through projectsIO already has an
  // identical worker mirror. Register that baseline before lazy migrations
  // create the first small autosave patch.
  adoptProjectPersistenceMirror(project);
  if (preserveOpenView && useGraphStore.getState().project?.id === project.id) {
    const current = useGraphStore.getState().project!;
    const view = withPersistedViewport(current);
    project = { ...project, viewport: view.viewport, viewportUpdatedAt: view.viewportUpdatedAt,
      selection: current.selection.filter(id => !!project.nodes[id]) };
  }

  // Lazy migration: pre-project-color scatters get a base color on first load
  // (aware of their group colors). No-op — same reference — when one exists;
  // the migrated color reaches disk via the normal autosave subscription.
  project = pruneInheritedGoogleSearchSuggestions(migrateInteractiveNodes(ensureProjectColor(project)));

  // Drop the previous scatter's media object URLs (MediaView re-loads its own
  // bytes on mount for the new scatter).
  useMediaUrlStore.getState().revokeAll();
  useArrowAnchorsStore.getState().clear();
  useLivePositionsStore.getState().seedFromMap(
    Object.entries(project.nodes).map(
      ([id, n]) => [id, { x: n.position.x, y: n.position.y }] as [string, { x: number; y: number }],
    ),
  );
  useLiveViewportStore.getState().seedFrom(project.viewport, project.viewportUpdatedAt);

  const g = useGraphStore.getState();
  // Camera requests are runtime-only and refer to node IDs in the project that
  // created them. Branch copies intentionally preserve IDs, so allowing a fit
  // request to survive a project handoff can make the source project obey the
  // copied project's camera animation when the user switches back.
  g.requestPanTo(null);
  g.setSearchQuery('');
  g.selectGroup(null);
  g.setProject(project, { resetRuntime: true });
  g.setActiveProjectId(project.id);
  // Reading positions: restore each node's expanded bullet only AFTER the
  // incoming project is active. The reading-store subscription schedules a
  // save; doing this earlier attributed that save to the outgoing project,
  // then folded the incoming project's same-ID live positions into it.
  useActiveIdxStore.getState().replaceAll(activeIdxSeedEntries(project));
  // Mirror the (possibly just-migrated) color into the registry row so the
  // sidebar can tint it later without loading the file. Read state FRESH —
  // `g` predates the setProject above.
  {
    const cur = useGraphStore.getState();
    cur.setProjectList(upsertMeta(cur.projectList, metaOf(project)));
  }

  // Clear AFTER setProject — setProject pushes the previous project onto the
  // temporal past-stack; clearing now leaves the new scatter with empty history.
  useGraphStore.temporal.getState().clear();

  // Background: delete OPFS asset files no longer referenced by any media node
  // (we keep bytes on node-delete so in-session undo works; orphans are swept
  // here, on load, when the undo history is gone anyway).
  const liveAssets = collectReferencedAssetIds(Object.values(project.nodes));
  for (const assetId of localChatDraftAssetIds(project.id)) liveAssets.add(assetId);
  void sweepOrphanAssets(project.id, liveAssets);
  const liveSourceAssets = sourceAssetIds(project.sourceLibrary ?? {
    mode: 'ignore', order: [], sources: {},
  });
  void sweepOrphanSourceAssets(
    project.id,
    new Set([...liveSourceAssets.eager, ...liveSourceAssets.lazy]),
  );
  // Staging is device-local and may need to resume after refresh. Keep the
  // document/embedding code out of the initial bundle until a project opens.
  void import('@/lib/sourceProcessing').then(({ restoreSourceProcessing }) => (
    restoreSourceProcessing(project.id)
  )).catch((error) => console.error('[scatter] could not resume source processing', error));
}

/** Flush the currently active scatter to disk immediately (bypassing the 300 ms
 *  autosave debounce) and sync its registry row. Used before switching away so
 *  quick switches never drop edits. */
async function flushActive(): Promise<void> {
  const s = useGraphStore.getState();
  if (!s.project) return;
  await flushProjectPersistence(s.project);
  s.setProjectList(upsertMeta(useGraphStore.getState().projectList, metaOf(s.project)));
}

/** Flush the active project, and if it is mid-generation, keep it alive in the
 *  background registry so its stream isn't lost when we leave it. */
async function flushAndDetachActive(): Promise<void> {
  const project = useGraphStore.getState().project;
  await flushActive();
  if (!project) return;
  // A generation chunk can land while the flush is awaiting OPFS. Read the
  // active project again so the detached copy keeps that newest content, then
  // fold in the live physics positions that were persisted to disk. Keeping
  // the pre-flush project object here used to resurrect stale node coordinates
  // when returning from a project created from one of its branches.
  const latest = useGraphStore.getState().project;
  const active = latest?.id === project.id ? latest : project;
  const keepAlive = projectHasGenerating(active);
  if (keepAlive) stashDetached(foldRuntimeIntoProject(active));
  await releaseProjectPersistence(active.id, keepAlive);
}

/** Switch the active project. No-op if already active. */
export async function switchScatter(id: string): Promise<void> {
  const s = useGraphStore.getState();
  if (id === s.activeProjectId) return;

  await flushAndDetachActive();

  // Prefer a detached in-memory copy (one that kept generating in the
  // background) over the on-disk file, so generation continues seamlessly.
  let next = takeDetached(id) ?? await loadProjectById(id);
  if (!next) {
    // File missing (corrupt / externally cleared) — keep the registry row valid
    // by substituting a blank scatter under the same id.
    next = { ...createBlankProject('Untitled project', ''), id };
    await saveProjectFile(next);
  }

  loadIntoStore(next);
  await persistIndex();
}

/** Create a new empty scatter and immediately switch to it (the "+" button).
 *  Returns the new scatter id. */
export async function createScatter(name?: string): Promise<string> {
  await flushAndDetachActive();

  const list = useGraphStore.getState().projectList;
  const blank = createBlankProject(name ?? uniqueScatterName(list, 'New project'), '');
  await saveProjectFile(blank);

  // New projects appear at the TOP of the list.
  useGraphStore.getState().setProjectList([metaOf(blank), ...list]);
  loadIntoStore(blank);
  await persistIndex();
  return blank.id;
}

let branchProjectCreationInFlight = false;

/** Copy an automatic-arrow branch into a self-contained project and switch to
 * it. This deliberately bypasses graph undo: the source graph is unchanged,
 * while project creation and switching are cross-project operations. */
export async function createScatterFromBranch(rootNodeId: string): Promise<string> {
  if (branchProjectCreationInFlight) {
    throw new Error('Another branch project is already being created.');
  }
  branchProjectCreationInFlight = true;
  try {
    return await createScatterFromBranchUnlocked(rootNodeId);
  } finally {
    branchProjectCreationInFlight = false;
  }
}

async function createScatterFromBranchUnlocked(rootNodeId: string): Promise<string> {
  const initial = useGraphStore.getState();
  const source = initial.project ? foldRuntimeIntoProject(initial.project) : null;
  const sourceNode = source?.nodes[rootNodeId];
  if (!source || !sourceNode) {
    throw new Error('The selected node no longer exists.');
  }
  if (source.rootNodeId === rootNodeId) {
    throw new Error('The current project root is already its own project.');
  }

  const branchIds = collectAutomaticBranchNodeIds(
    rootNodeId,
    Object.values(source.arrows),
  );
  const branchNodes = [...branchIds]
    .map((id) => source.nodes[id])
    .filter((node): node is NonNullable<typeof node> => !!node);
  if (branchNodes.some((node) => node.generating)) {
    throw new Error('Wait for every node in this branch to finish generating.');
  }

  const currentVersion = sourceNode.versions[sourceNode.currentVersionIndex];
  const baseName = currentVersion?.header.trim() || 'New project';
  const originalList = initial.projectList;
  let sourceListForRollback = originalList;
  let activationStarted = false;
  const name = uniqueScatterName(originalList, baseName);
  const accent = (
    sourceNode.groupId ? source.groups[sourceNode.groupId]?.color : undefined
  ) ?? source.color;
  const blank = createBlankProject(name, rootNodeId);
  const accentHue = accent
    ? hexToOklch(resolveColorHex(accent)).h
    : blank.oppositesColorBaseHue;
  const destinationBase: Project = {
    ...blank,
    ...(accent ? { color: accent } : {}),
    ...(typeof accentHue === 'number' && Number.isFinite(accentHue)
      ? {
          goldenColorCursorHue: accentHue,
          oppositesColorBaseHue: accentHue,
          oppositesColorCursorIndex: 0,
        }
      : {}),
  };
  const fresh = copyBranchIntoProject(source, rootNodeId, destinationBase);
  const assetIds = collectReferencedAssetIds(Object.values(fresh.nodes));
  const sourceAssets = collectReferencedProjectAssets(fresh);
  const assets = new Map<string, Blob>();

  try {
    // Read every byte before mutating the registry or active project. A missing
    // asset aborts cleanly rather than creating a subtly incomplete copy.
    for (const assetId of assetIds) {
      const blob = await loadAsset(source.id, assetId);
      if (!blob) throw new Error(`A branch media asset could not be read (${assetId}).`);
      assets.set(assetId, blob);
    }
    for (const [assetId, blob] of assets) await saveAsset(fresh.id, assetId, blob);
    for (const assetId of [...sourceAssets.sourceEager, ...sourceAssets.sourceLazy]) {
      await copySourceAsset(source.id, fresh.id, assetId);
    }
    await saveProjectFile(fresh);

    await flushAndDetachActive();
    sourceListForRollback = useGraphStore.getState().projectList;
    activationStarted = true;
    useGraphStore.getState().setProjectList([metaOf(fresh), ...sourceListForRollback]);
    loadIntoStore(fresh);
    await persistIndex();
    useGraphStore.getState().requestFitNodes(Object.keys(fresh.nodes), 'branchProjects');
    return fresh.id;
  } catch (error) {
    // Best-effort atomic rollback. The source project was never edited; if it
    // had unrelated background generation, prefer that live detached copy.
    try { await releaseProjectPersistence(fresh.id, false); } catch { /* noop */ }
    try { await deleteProjectFile(fresh.id); } catch { /* noop */ }
    try { await deleteProjectAssets(fresh.id); } catch { /* noop */ }
    try { await deleteProjectSourceAssets(fresh.id); } catch { /* noop */ }
    dropDetached(fresh.id);

    if (activationStarted) {
      const restoredSource = takeDetached(source.id) ?? source;
      useGraphStore.getState().setProjectList(sourceListForRollback);
      loadIntoStore(restoredSource);
      try {
        await saveProjectsIndex({ activeId: source.id, items: sourceListForRollback });
      } catch { /* noop */ }
    }
    throw error;
  }
}

/** Bundle the ACTIVE scatter (runtime state folded in) into a downloadable
 *  `.scatter.zip`. Returns null when no scatter is loaded. */
export async function exportActiveScatterZip(): Promise<{ blob: Blob; filename: string } | null> {
  const s = useGraphStore.getState();
  if (!s.project) return null;
  const proj = foldRuntimeIntoProject(s.project);
  const blob = await buildProjectZip(proj);
  return { blob, filename: `${sanitizeFilename(proj.name, 'scatter-project')}.scatter.zip` };
}

/** Add an imported project as a NEW scatter (fresh id, de-duplicated name),
 *  write its media bytes, and switch to it. Returns the new scatter id. */
export async function importScatter(
  project: Project,
  assets: ReadonlyMap<string, Blob>,
  sourceAssets: ReadonlyMap<string, Blob> = new Map(),
): Promise<string> {
  await flushAndDetachActive();

  const list = useGraphStore.getState().projectList;
  const fresh: Project = {
    ...stripTransient(project),
    id: newId(),                 // never trust the incoming id — it could collide
    name: uniqueScatterName(list, project.name),
    updatedAt: Date.now(),
  };

  // Assets BEFORE loadIntoStore — its orphan sweep must find the files already
  // written. The assetIds inside the JSON carry over untouched (they're only
  // unique within a project); just the directory moves to the fresh id's.
  for (const [assetId, blob] of assets) await saveAsset(fresh.id, assetId, blob);
  for (const [assetId, blob] of sourceAssets) await saveSourceAsset(fresh.id, assetId, blob);

  await saveProjectFile(fresh);
  // Imported projects appear at the TOP of the list, like new ones.
  useGraphStore.getState().setProjectList([metaOf(fresh), ...list]);
  loadIntoStore(fresh);
  await persistIndex();
  return fresh.id;
}

/** One call from a picked file to a live scatter (shared by the Settings Data
 *  tab and the topic picker). Throws ProjectImportError with a user-facing
 *  message when the file isn't a valid export. */
export async function importScatterFromFile(file: File): Promise<string> {
  const { project, assets, sourceAssets } = await parseProjectZip(await file.arrayBuffer());
  return importScatter(project, assets, sourceAssets);
}

/** Reorder the project list by moving `fromId` to `toId`'s position (drag-reorder). */
export async function reorderProjects(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const list = [...useGraphStore.getState().projectList];
  const from = list.findIndex((m) => m.id === fromId);
  const to = list.findIndex((m) => m.id === toId);
  if (from < 0 || to < 0) return;
  const [moved] = list.splice(from, 1);
  if (!moved) return;
  // `to` belongs to the original layout, matching Dnd Kit's arrayMove
  // semantics. Looking the target up after removal put downward moves one row
  // too early (the stored order disagreed with the animated placeholder).
  list.splice(to, 0, moved);
  useGraphStore.getState().setProjectList(list);
  await persistIndex();
}

/** Rename a scatter (active or not). */
export async function renameScatter(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const s = useGraphStore.getState();

  s.setProjectList(s.projectList.map((m) => (m.id === id ? { ...m, name: trimmed } : m)));

  if (s.activeProjectId === id && s.project) {
    const updated = { ...s.project, name: trimmed, updatedAt: Date.now() };
    // The active project's name is meaningful user-authored content. Its
    // lightweight sidebar mirror was updated above; the semantic undo wrapper
    // keeps both representations in sync when this is reversed.
    s.setProject(updated);
    const current = useGraphStore.getState();
    current.setProjectList(upsertMeta(current.projectList, metaOf(updated)));
    await flushProjectPersistence(updated);
  } else {
    const p = await loadProjectById(id);
    if (p) {
      const updated = { ...p, name: trimmed, updatedAt: Date.now() };
      await saveProjectFile(updated);
      const current = useGraphStore.getState();
      current.setProjectList(upsertMeta(current.projectList, metaOf(updated)));
    }
  }
  await persistIndex();
}

/** Recolor a scatter's base color (active or not). Active → the undoable
 *  store action (autosave persists it); non-active → rewrite its file
 *  directly. Both paths mirror the color into the registry row. */
export async function recolorScatter(id: string, color: GroupColor): Promise<void> {
  const s = useGraphStore.getState();
  if (s.activeProjectId === id && s.project) {
    s.recolorProject(color);
    const current = useGraphStore.getState();
    if (current.project) {
      current.setProjectList(upsertMeta(current.projectList, metaOf(current.project)));
    }
  } else {
    const p = await loadProjectById(id);
    if (!p) return;
    const updated = { ...p, color, updatedAt: Date.now() };
    await saveProjectFile(updated);
    const current = useGraphStore.getState();
    current.setProjectList(upsertMeta(current.projectList, metaOf(updated)));
  }
  await persistIndex();
}

/** Rebuild the active project's complete palette in one undoable graph edit,
 * then immediately mirror its new base color into the lightweight registry. */
export async function reassignActiveProjectColors(
  assignment: GroupColorAssignment,
): Promise<void> {
  const before = useGraphStore.getState();
  if (!before.project) return;
  before.reassignProjectColors(assignment);

  const after = useGraphStore.getState();
  if (!after.project) return;
  after.setProjectList(upsertMeta(after.projectList, metaOf(after.project)));
  await flushProjectPersistence(after.project);
  await persistIndex();
}

/** Backfill a registry row's color for a scatter last opened before colors
 *  existed: load its file, run the same lazy migration loading would, save,
 *  and mirror into the registry. Called when editing such a row (the picker
 *  needs a current color). No-op when the file already has one. */
export async function ensureScatterColorInMeta(id: string): Promise<void> {
  const p = await loadProjectById(id);
  if (!p) return;
  const ensured = ensureProjectColor(p);
  if (ensured !== p) await saveProjectFile(ensured);
  const cur = useGraphStore.getState();
  cur.setProjectList(
    cur.projectList.map((m) => (m.id === id ? { ...m, color: ensured.color } : m)),
  );
  await persistIndex();
}

/** Delete a scatter. If it was active, switch to the most-recently-updated
 *  remaining one; if it was the last, create a fresh blank so there's always
 *  at least one scatter. */
export async function deleteScatter(id: string): Promise<void> {
  const s = useGraphStore.getState();
  const wasActive = s.activeProjectId === id;
  const remaining = s.projectList.filter((m) => m.id !== id);
  s.setProjectList(remaining);
  dropDetached(id);            // discard any background generation for it
  await releaseProjectPersistence(id);
  await deleteProjectFile(id);
  await deleteProjectAssets(id);   // remove this scatter's media bytes
  await deleteProjectSourceAssets(id);

  if (wasActive) {
    if (remaining.length > 0) {
      const target = remaining.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      const next = (await loadProjectById(target.id))
        ?? (() => { const b = { ...createBlankProject(target.name, ''), id: target.id }; return b; })();
      loadIntoStore(next);
    } else {
      const blank = createBlankProject('My project', '');
      await saveProjectFile(blank);
      useGraphStore.getState().setProjectList([metaOf(blank)]);
      loadIntoStore(blank);
    }
  }
  await persistIndex();
}

/** Install a project received from an enabled sync target. This is deliberately
 * outside app-level undo: cloud history is the recovery surface, and allowing
 * Ctrl+Z to cross an external project replacement would mix two timelines. */
export async function applySyncedScatter(project: Project): Promise<void> {
  const state = useGraphStore.getState();
  if (state.activeProjectId === project.id) {
    await releaseProjectPersistence(project.id);
    await saveProjectFile(project);
    // Use the camera at installation time, not a snapshot taken before cloud
    // downloads or the conflict dialog. Never pull an open canvas elsewhere.
    if (useGraphStore.getState().activeProjectId === project.id) {
      loadIntoStore(project, true);
    }
  } else {
    await saveProjectFile(project);
    adoptProjectPersistenceMirror(project);
  }
  const current = useGraphStore.getState();
  current.setProjectList(upsertMeta(current.projectList, metaOf(project)));
  await persistIndex();
}

/** Apply a remotely synchronized sidebar order without changing the active
 * project. Unknown local projects are retained at the end. */
export async function applySyncedProjectOrder(order: readonly string[]): Promise<void> {
  const state = useGraphStore.getState();
  const byId = new Map(state.projectList.map((project) => [project.id, project]));
  const next: ProjectMeta[] = [];
  for (const id of order) {
    const project = byId.get(id);
    if (!project) continue;
    next.push(project);
    byId.delete(id);
  }
  next.push(...byId.values());
  state.setProjectList(next);
  await persistIndex();
}

/** Reset to a single fresh blank scatter. Used after the Settings "Erase
 *  project" flow wipes the OPFS project files. */
export async function resetToSingleBlankScatter(): Promise<void> {
  const activeId = useGraphStore.getState().activeProjectId;
  if (activeId) await releaseProjectPersistence(activeId);
  const blank = createBlankProject('My scatter', '');
  useGraphStore.getState().setProjectList([metaOf(blank)]);
  await saveProjectFile(blank);
  loadIntoStore(blank);
  await persistIndex();
}

/**
 * Hydration entry point (called once on mount from useProjectPersistence).
 *   1. No registry yet → migrate the legacy single `project.json` if present,
 *      else start with one blank scatter.
 *   2. Registry exists → load the active scatter (falling back to the first
 *      loadable row, then to a fresh blank if nothing loads).
 */
export async function bootstrapScatters(): Promise<void> {
  const idx = await loadProjectsIndex();

  if (!idx) {
    const legacy = await loadLegacyProject();
    if (legacy) {
      await saveProjectFile(legacy);
      await deleteLegacyProjectFile();
      useGraphStore.getState().setProjectList([metaOf(legacy)]);
      loadIntoStore(legacy);
      await persistIndex();
    } else {
      await resetToSingleBlankScatter();
    }
    return;
  }

  useGraphStore.getState().setProjectList(idx.items);

  const order = [
    ...(idx.activeId ? [idx.activeId] : []),
    ...idx.items.map((m) => m.id),
  ];
  let project: Project | null = null;
  for (const candidateId of order) {
    project = await loadProjectById(candidateId);
    if (project) break;
  }

  if (!project) {
    await resetToSingleBlankScatter();
    return;
  }

  loadIntoStore(project);
  await persistIndex();
}
