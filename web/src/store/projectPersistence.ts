import type {
  Arrow,
  Group,
  NodeVersion,
  Project,
  ScatterNode,
} from './types';
import { useActiveIdxStore } from './useActiveIdxStore';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { foldRuntimeIntoProject, withPersistedViewport } from './foldRuntime';
import {
  evictProjectFileMirror,
  flushProjectFileMirror,
  patchProjectFile,
  saveProjectFile,
} from '@/opfs/projectsIO';
import type {
  NodeFilePatch,
  ProjectBasePatch,
  ProjectFilePatch,
  RecordPatch,
  RuntimePersistenceOverlay,
} from '@/opfs/projectPersistenceProtocol';
import { trackProjectPersistence } from '@/opfs/projectPersistenceBarrier';

const AUTOSAVE_DELAY_MS = 300;

interface ProjectPersistenceState {
  projectId: string;
  baseline: Project;
  latest: Project;
  lastRuntime: RuntimePersistenceOverlay;
  revision: number;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  dirty: boolean;
  followUpAfterFlight: boolean;
  useLiveRuntime: boolean;
  mirrorKnown: boolean;
}

const states = new Map<string, ProjectPersistenceState>();

function projectRuntime(project: Project): RuntimePersistenceOverlay {
  const positions: RuntimePersistenceOverlay['positions'] = {};
  const anchors: RuntimePersistenceOverlay['anchors'] = {};
  const activeBulletIdx: RuntimePersistenceOverlay['activeBulletIdx'] = {};
  for (const [id, node] of Object.entries(project.nodes)) {
    positions[id] = node.position;
    if (node.activeBulletIdx !== undefined) activeBulletIdx[id] = node.activeBulletIdx;
  }
  for (const [id, arrow] of Object.entries(project.arrows)) {
    if (arrow.anchors) anchors[id] = arrow.anchors;
  }
  return { positions, anchors, activeBulletIdx };
}

function liveRuntime(project: Project): RuntimePersistenceOverlay {
  const livePositions = useLivePositionsStore.getState().positions;
  const liveAnchors = useArrowAnchorsStore.getState().anchors;
  const liveActiveIdx = useActiveIdxStore.getState().byNodeId;
  const positions: RuntimePersistenceOverlay['positions'] = {};
  const anchors: RuntimePersistenceOverlay['anchors'] = {};
  const activeBulletIdx: RuntimePersistenceOverlay['activeBulletIdx'] = {};

  for (const [id, node] of Object.entries(project.nodes)) {
    positions[id] = livePositions[id] ?? node.position;
    const idx = liveActiveIdx[id];
    if (typeof idx === 'number') activeBulletIdx[id] = idx;
  }
  for (const [id, arrow] of Object.entries(project.arrows)) {
    const chain = liveAnchors[id];
    if (chain && chain.length >= 2) anchors[id] = chain;
    else if (arrow.anchors) anchors[id] = arrow.anchors;
  }
  return { positions, anchors, activeBulletIdx };
}

function fieldPatch(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  omitted: ReadonlySet<string> = new Set(),
): ProjectBasePatch {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const key of Object.keys(previous)) {
    if (!omitted.has(key) && !(key in next)) remove.push(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (!omitted.has(key) && !Object.is(previous[key], value)) set[key] = value;
  }
  return { set, remove };
}

function recordPatch<T>(
  previous: Record<string, T>,
  next: Record<string, T>,
): RecordPatch<T> {
  if (previous === next) return { upsert: {}, remove: [] };
  const upsert: Record<string, T> = {};
  const remove: string[] = [];
  for (const id of Object.keys(previous)) {
    if (!(id in next)) remove.push(id);
  }
  for (const [id, value] of Object.entries(next)) {
    if (previous[id] !== value) upsert[id] = value;
  }
  return { upsert, remove };
}

const VERSION_KEY = new Set(['versions']);
const PROJECT_RECORD_KEYS = new Set(['nodes', 'arrows', 'groups']);

function versionPatch(
  previous: readonly NodeVersion[],
  next: readonly NodeVersion[],
): NodeFilePatch['versions'] | undefined {
  if (previous === next) return undefined;
  const upsert: Record<string, NodeVersion> = {};
  const update: Record<string, ProjectBasePatch> = {};
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (!after || before === after) continue;
    if (!before) {
      upsert[String(index)] = after;
      continue;
    }
    const patch = fieldPatch(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
    );
    if (Object.keys(patch.set).length > 0 || patch.remove.length > 0) {
      update[String(index)] = patch;
    }
  }
  if (
    previous.length === next.length
    && Object.keys(upsert).length === 0
    && Object.keys(update).length === 0
  ) return undefined;
  return { length: next.length, upsert, update };
}

function nodePatch(
  previous: Record<string, ScatterNode>,
  next: Record<string, ScatterNode>,
): ProjectFilePatch['nodes'] {
  if (previous === next) return { upsert: {}, update: {}, remove: [] };
  const upsert: Record<string, ScatterNode> = {};
  const update: Record<string, NodeFilePatch> = {};
  const remove: string[] = [];
  for (const id of Object.keys(previous)) {
    if (!(id in next)) remove.push(id);
  }
  for (const [id, after] of Object.entries(next)) {
    const before = previous[id];
    if (!before) {
      upsert[id] = after;
      continue;
    }
    if (before === after) continue;
    const fields = fieldPatch(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      VERSION_KEY,
    );
    const versions = versionPatch(before.versions, after.versions);
    if (Object.keys(fields.set).length > 0 || fields.remove.length > 0 || versions) {
      update[id] = { ...fields, ...(versions ? { versions } : {}) };
    }
  }
  return { upsert, update, remove };
}

function positionEqual(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined,
): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function anchorsEqual(
  a: readonly { x: number; y: number }[] | undefined,
  b: readonly { x: number; y: number }[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!positionEqual(a[index], b[index])) return false;
  }
  return true;
}

function runtimePatch(
  previous: RuntimePersistenceOverlay,
  next: RuntimePersistenceOverlay,
): RuntimePersistenceOverlay {
  const positions: RuntimePersistenceOverlay['positions'] = {};
  const anchors: RuntimePersistenceOverlay['anchors'] = {};
  const activeBulletIdx: RuntimePersistenceOverlay['activeBulletIdx'] = {};
  for (const [id, value] of Object.entries(next.positions)) {
    if (!positionEqual(previous.positions[id], value)) positions[id] = value;
  }
  for (const [id, value] of Object.entries(next.anchors)) {
    if (!anchorsEqual(previous.anchors[id], value)) anchors[id] = value;
  }
  const activeIds = new Set([
    ...Object.keys(previous.activeBulletIdx),
    ...Object.keys(next.activeBulletIdx),
  ]);
  for (const id of activeIds) {
    const before = previous.activeBulletIdx[id];
    const after = next.activeBulletIdx[id];
    if (before === after) continue;
    activeBulletIdx[id] = typeof after === 'number' ? after : null;
  }
  return { positions, anchors, activeBulletIdx };
}

function baseRecord(project: Project): Record<string, unknown> {
  const {
    nodes: _nodes,
    arrows: _arrows,
    groups: _groups,
    ...base
  } = project;
  return base;
}

/** Pure delta builder exported for correctness and large-project benchmarks. */
export function buildProjectFilePatch(
  previous: Project,
  next: Project,
  previousRuntime: RuntimePersistenceOverlay,
  nextRuntime: RuntimePersistenceOverlay,
  revision: number,
): ProjectFilePatch {
  return {
    revision,
    base: fieldPatch(baseRecord(previous), baseRecord(next), PROJECT_RECORD_KEYS),
    nodes: nodePatch(previous.nodes, next.nodes),
    arrows: recordPatch<Arrow>(previous.arrows, next.arrows),
    groups: recordPatch<Group>(previous.groups, next.groups),
    runtime: runtimePatch(previousRuntime, nextRuntime),
  };
}

function patchHasChanges(patch: ProjectFilePatch): boolean {
  return (
    Object.keys(patch.base.set).length > 0
    || patch.base.remove.length > 0
    || Object.keys(patch.nodes.upsert).length > 0
    || Object.keys(patch.nodes.update).length > 0
    || patch.nodes.remove.length > 0
    || Object.keys(patch.arrows.upsert).length > 0
    || patch.arrows.remove.length > 0
    || Object.keys(patch.groups.upsert).length > 0
    || patch.groups.remove.length > 0
    || Object.keys(patch.runtime.positions).length > 0
    || Object.keys(patch.runtime.anchors).length > 0
    || Object.keys(patch.runtime.activeBulletIdx).length > 0
  );
}

function newState(project: Project, mirrorKnown: boolean): ProjectPersistenceState {
  return {
    projectId: project.id,
    baseline: project,
    latest: project,
    lastRuntime: projectRuntime(project),
    revision: 0,
    timer: null,
    inFlight: null,
    dirty: false,
    followUpAfterFlight: false,
    useLiveRuntime: true,
    mirrorKnown,
  };
}

/** Register a project just read from or completely written to the worker. */
export function adoptProjectPersistenceMirror(project: Project): void {
  const existing = states.get(project.id);
  if (existing) {
    existing.latest = project;
    return;
  }
  states.set(project.id, newState(project, true));
}

function ensureState(project: Project): ProjectPersistenceState {
  const existing = states.get(project.id);
  if (existing) return existing;
  const created = newState(project, false);
  states.set(project.id, created);
  return created;
}

function scheduleTimer(state: ProjectPersistenceState, delay = AUTOSAVE_DELAY_MS): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    if (state.inFlight) {
      state.followUpAfterFlight = true;
      return;
    }
    void startSave(state).catch((error) => {
      console.error('[scatter] autosave failed; the latest project remains queued', error);
    });
  }, delay);
}

async function persistState(
  state: ProjectPersistenceState,
  target: Project,
  currentRuntime: RuntimePersistenceOverlay,
  useLiveRuntime: boolean,
): Promise<void> {
  if (!state.mirrorKnown) {
    await saveProjectFile(
      useLiveRuntime ? foldRuntimeIntoProject(target) : target,
    );
    state.mirrorKnown = true;
    return;
  }

  const revision = state.revision + 1;
  const startedAt = typeof performance === 'undefined' ? 0 : performance.now();
  const patch = buildProjectFilePatch(
    state.baseline,
    target,
    state.lastRuntime,
    currentRuntime,
    revision,
  );
  const preparationMs = startedAt === 0 ? 0 : performance.now() - startedAt;
  if (
    process.env.NODE_ENV !== 'production'
    && preparationMs > 8
  ) {
    console.warn(`[scatter] autosave patch preparation took ${preparationMs.toFixed(1)}ms`);
  }
  if (!patchHasChanges(patch)) return;

  const patched = await patchProjectFile(target.id, patch);
  const flushed = patched && await flushProjectFileMirror(target.id, revision);
  if (!flushed) {
    await saveProjectFile(
      useLiveRuntime ? foldRuntimeIntoProject(target) : target,
    );
  }
  state.revision = revision;
  state.mirrorKnown = true;
}

function startSave(state: ProjectPersistenceState): Promise<void> {
  if (state.inFlight) return state.inFlight;
  if (!state.dirty) return Promise.resolve();
  state.dirty = false;
  state.followUpAfterFlight = false;
  const useLiveRuntime = state.useLiveRuntime;
  // Includes an unfinished wheel gesture/tween on pagehide or project switch.
  const target = useLiveRuntime ? withPersistedViewport(state.latest) : state.latest;
  const currentRuntime = useLiveRuntime ? liveRuntime(target) : projectRuntime(target);

  const task = persistState(state, target, currentRuntime, useLiveRuntime).then(() => {
    state.baseline = target;
    state.lastRuntime = currentRuntime;
  }).catch((error) => {
    state.dirty = true;
    throw error;
  }).finally(() => {
    state.inFlight = null;
    if (state.dirty && state.followUpAfterFlight) scheduleTimer(state, 0);
  });
  state.inFlight = task;
  trackProjectPersistence(state.projectId, task);
  return task;
}

function markDirty(project: Project, useLiveRuntime: boolean): ProjectPersistenceState {
  const state = ensureState(project);
  state.latest = project;
  state.useLiveRuntime = useLiveRuntime;
  state.dirty = true;
  scheduleTimer(state);
  return state;
}

export function scheduleProjectAutosave(project: Project): void {
  markDirty(project, true);
}

export function scheduleReadingPositionAutosave(project: Project): void {
  markDirty(project, true);
}

export async function flushProjectPersistence(project: Project): Promise<void> {
  const state = ensureState(project);
  state.latest = project;
  state.useLiveRuntime = true;
  state.dirty = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.inFlight) await state.inFlight;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.dirty) await startSave(state);
  // A store update may have landed while the first write was in flight.
  if (state.dirty) await startSave(state);
}

export async function flushDetachedProjectPersistence(project: Project): Promise<void> {
  const state = states.get(project.id);
  if (!state) {
    await saveProjectFile(project);
    adoptProjectPersistenceMirror(project);
    return;
  }
  state.latest = project;
  state.useLiveRuntime = false;
  state.dirty = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.inFlight) await state.inFlight;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.dirty) await startSave(state);
}

export async function releaseProjectPersistence(
  projectId: string,
  keepMirror = false,
): Promise<void> {
  const state = states.get(projectId);
  if (state?.timer) clearTimeout(state.timer);
  if (keepMirror) return;
  if (state?.inFlight) {
    try {
      await state.inFlight;
    } catch {
      // The caller that requested the save owns error reporting.
    }
  }
  states.delete(projectId);
  await evictProjectFileMirror(projectId);
}

/** Test-only reset; production project switches use releaseProjectPersistence. */
export async function resetProjectPersistenceForTests(): Promise<void> {
  const ids = [...states.keys()];
  for (const id of ids) await releaseProjectPersistence(id);
}
