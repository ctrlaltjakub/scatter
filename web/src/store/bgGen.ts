import type { Project, ScatterNode } from './types';
import { useGraphStore } from './useGraphStore';
import {
  flushDetachedProjectPersistence,
  releaseProjectPersistence,
} from './projectPersistence';
import { isGroupTitleGenerating } from '@/lib/groupTitle';

/**
 * Background generation registry.
 *
 * A generation stream writes into a node of ONE specific project. Normally
 * that's the active project (held in useGraphStore). But if the user switches
 * to another project mid-generation, the generating project leaves the store —
 * its stream must keep updating SOMETHING or its output is lost.
 *
 * This module holds such "detached" projects in memory so their in-flight
 * generation keeps progressing in the background. When a detached project
 * finishes generating, it's persisted to disk and dropped; when the user
 * switches back to it, its live in-memory copy is reclaimed (see projectActions
 * switchScatter), so generation continues seamlessly.
 */
const detached = new Map<string, Project>();

/** Model-default updates wait until active and detached projects finish. */
export function anyProjectGenerating(): boolean {
  const active = useGraphStore.getState().project;
  return (!!active && projectHasGenerating(active)) || [...detached.values()].some(projectHasGenerating);
}

/** True if any node or group title still needs its live project retained. */
export function projectHasGenerating(p: Project): boolean {
  return Object.values(p.nodes).some((n) => n.generating)
    || Object.values(p.groups).some(isGroupTitleGenerating);
}

/** Settle only the captured automatic title, never a user rename. Patch
 * matching undo/redo snapshots too: finishing is part of group creation, not
 * another action, and redo must not restore a spinner with no live request. */
export function completeGenGroupTitle(projectId: string, groupId: string, requestId: string, name: string, error?: string): void {
  const patch = (project: Project | null): Project | null => {
    const group = project?.id === projectId ? project.groups[groupId] : undefined;
    if (!project || !group || group.titleGeneration?.id !== requestId) return project;
    return { ...project, updatedAt: Date.now(), groups: { ...project.groups,
      [groupId]: { ...group, name, titleGeneration: error ? { ...group.titleGeneration, error } : undefined },
    } };
  };
  const history = useGraphStore.temporal.getState();
  useGraphStore.temporal.setState({
    pastStates: history.pastStates.map(state => state.project ? { ...state, project: patch(state.project) } : state),
    futureStates: history.futureStates.map(state => state.project ? { ...state, project: patch(state.project) } : state),
  });
  const current = useGraphStore.getState().project;
  if (current?.id === projectId) {
    const next = patch(current);
    if (next === current) return;
    const tracking = history.isTracking;
    history.pause();
    try { useGraphStore.setState({ project: next }); }
    finally { if (tracking) history.resume(); }
    return;
  }
  const previous = detached.get(projectId);
  const next = patch(previous ?? null);
  if (!next || next === previous) return;
  detached.set(projectId, next);
  persistCompletedDetached(next);
}

function persistCompletedDetached(next: Project): void {
  if (projectHasGenerating(next)) return;
  const projectId = next.id;
  void flushDetachedProjectPersistence(next).then(async () => {
    if (detached.get(projectId) !== next) return;
    detached.delete(projectId);
    await releaseProjectPersistence(projectId);
  }).catch((error) => {
    console.error('[scatter] could not persist completed background generation', error);
  });
}

/** Keep a project alive in the background — called when switching away from a
 *  project that is mid-generation. */
export function stashDetached(project: Project): void {
  detached.set(project.id, project);
}

/** Reclaim a detached project (switching back to it). Returns the in-memory
 *  copy — including any generation that progressed while away — and stops
 *  tracking it. */
export function takeDetached(projectId: string): Project | undefined {
  const p = detached.get(projectId);
  if (p) detached.delete(projectId);
  return p;
}

/** Forget a detached project without persisting — called when it's deleted. */
export function dropDetached(projectId: string): void {
  detached.delete(projectId);
}

/** The live Project a generation is writing into: the active store project if
 *  its id matches, else the detached copy (or null if neither). */
export function getGenProject(projectId: string): Project | null {
  const g = useGraphStore.getState();
  if (g.activeProjectId === projectId) return g.project;
  return detached.get(projectId) ?? null;
}

/**
 * Apply a node patch to whichever holds the project — the active store (drives
 * the live UI + autosave) or the detached map. When a detached project finishes
 * generating entirely, it is persisted to disk and dropped from the registry.
 */
export function updateGenNode(projectId: string, nodeId: string, patch: Partial<ScatterNode>): void {
  const g = useGraphStore.getState();
  if (g.activeProjectId === projectId && g.project) {
    // Per-chunk streaming writes must NOT each become an undo step — the
    // spawn's structural creation (addNodeWithArrow) is the single undo
    // point, and undoing it removes the whole node anyway. Pause history
    // around the write (scoped + synchronous, same idiom as the measurement
    // writes in AdaptiveBullets/NodeView). A user action between chunks
    // still records normally because the pause is released each call.
    useGraphStore.temporal.getState().pause();
    try {
      g.updateNode(nodeId, patch);
    } finally {
      useGraphStore.temporal.getState().resume();
    }
    return;
  }
  const p = detached.get(projectId);
  if (!p) return;
  const cur = p.nodes[nodeId];
  if (!cur) return;
  const next: Project = {
    ...p,
    nodes: { ...p.nodes, [nodeId]: { ...cur, ...patch } },
    updatedAt: Date.now(),
  };
  detached.set(projectId, next);
  // Keep the completed copy reclaimable until its ordered flush succeeds.
  persistCompletedDetached(next);
}
