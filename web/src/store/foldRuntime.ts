import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { useActiveIdxStore } from './useActiveIdxStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import { parseBody } from '@/lib/bulletParse';
import type { Project, Arrow, ScatterNode } from './types';

/**
 * Inject the runtime anchor chain positions into project.arrows[id].anchors
 * so the rope resumes its settled shape on reload. Snapshotted at save time so
 * we don't have to mirror anchors into the temporal store every tick (which
 * would pollute undo history and re-render React 60×/sec).
 */
function withPersistedAnchors(project: Project): Project {
  const anchors = useArrowAnchorsStore.getState().anchors;
  const arrowsOut: Record<string, Arrow> = {};
  for (const [id, a] of Object.entries(project.arrows)) {
    const live = anchors[id];
    arrowsOut[id] = live && live.length >= 2
      ? { ...a, anchors: live.map((p) => ({ x: p.x, y: p.y })) }
      : a;
  }
  return { ...project, arrows: arrowsOut };
}

/**
 * PERF R2: fold runtime live positions into the project. After R2 the physics
 * tick stream updates `useLivePositionsStore` instead of
 * `project.nodes[id].position`, so the in-memory project's positions can lag
 * the visible truth between user commits. Captured at save time so the saved
 * file matches what the user sees, even when the save was triggered by an edit
 * unrelated to position.
 */
function withPersistedPositions(project: Project): Project {
  const live = useLivePositionsStore.getState().positions;
  const nodesOut: Record<string, ScatterNode> = {};
  for (const [id, n] of Object.entries(project.nodes)) {
    const lp = live[id];
    nodesOut[id] = lp
      ? { ...n, position: { x: lp.x, y: lp.y } }
      : n;
  }
  return { ...project, nodes: nodesOut };
}

/**
 * Reading position: snapshot the transient active-bullet map into each node's
 * `activeBulletIdx` so a reload restores which bullet the user had expanded.
 * A node whose transient entry is gone gets the saved field STRIPPED (the
 * user cleared it this session — a stale value must not resurrect). Nodes
 * with nothing to change pass through by reference.
 */
function withPersistedActiveIdx(project: Project): Project {
  const byNodeId = useActiveIdxStore.getState().byNodeId;
  const nodesOut: Record<string, ScatterNode> = {};
  for (const [id, n] of Object.entries(project.nodes)) {
    const idx = byNodeId[id];
    if (typeof idx === 'number') nodesOut[id] = { ...n, activeBulletIdx: idx };
    else if (n.activeBulletIdx !== undefined) {
      const { activeBulletIdx: _drop, ...rest } = n;
      nodesOut[id] = rest as ScatterNode;
    } else nodesOut[id] = n;
  }
  return { ...project, nodes: nodesOut };
}

/**
 * `[nodeId, idx]` pairs to seed useActiveIdxStore from a freshly loaded
 * project. Clamps against the CURRENT version's L1 bullet count (the body
 * may have been edited since the save) and drops entries with no valid
 * target (negative, or a body without bullets).
 */
export function activeIdxSeedEntries(project: Project): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const n of Object.values(project.nodes)) {
    const idx = n.activeBulletIdx;
    if (typeof idx !== 'number' || idx < 0) continue;
    const body = n.versions[n.currentVersionIndex]?.body ?? '';
    const count = parseBody(body)?.bullets.length ?? 0;
    if (count === 0) continue;
    out.push([n.id, Math.min(idx, count - 1)]);
  }
  return out;
}

/** Capture the active project's live camera, including an unfinished gesture. */
export function withPersistedViewport(project: Project): Project {
  const live = useLiveViewportStore.getState();
  // Direct navigation may have committed to the graph before Canvas has
  // mirrored it into the live store. Do not replace that newer intent.
  if ((project.viewportUpdatedAt ?? 0) > live.editedAt) return project;
  if (project.viewport.x === live.x && project.viewport.y === live.y
    && project.viewport.zoom === live.zoom
    && (project.viewportUpdatedAt ?? 0) === live.editedAt) return project;
  return { ...project, viewport: { x: live.x, y: live.y, zoom: live.zoom },
    ...(live.editedAt ? { viewportUpdatedAt: Math.max(project.viewportUpdatedAt ?? 0, live.editedAt) } : {}) };
}

/** Fold runtime geometry, reading positions, and camera into the active
 * project so exports and project-switch snapshots match what the user sees. */
export function foldRuntimeIntoProject(project: Project): Project {
  return withPersistedViewport(withPersistedActiveIdx(withPersistedPositions(withPersistedAnchors(project))));
}
