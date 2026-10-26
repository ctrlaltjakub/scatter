import { create } from 'zustand';
import { temporal } from 'zundo';
import type {
  Project,
  ScatterNode,
  NodeVersion,
  Arrow,
  Group,
  GroupColor,
  GroupColorAssignment,
  ProjectMeta,
  ProjectSourceLibrary,
  ProjectSourceMode,
} from './types';
import { newId } from '@/lib/ids';
import { assignGroupColorHex } from '@/lib/groupColorAssign';
import { deriveColorInputs } from '@/lib/groupHierarchy';
import {
  nextGoldenGroupColor,
  nextOppositesGroupColor,
  randomProjectColor,
  reassignProjectPalette,
} from '@/lib/projectColorAssignment';
import { useSettingsStore } from './useSettingsStore';
import type { CameraPanTrigger } from '@/lib/cameraPreferences';
import {
  readLastGroupMemory,
  writeLastGroupMemory,
  type LastGroupMemory,
} from '@/lib/sidebarGroupMemory';
import { clampViewportZoom } from '@/lib/zoomLimits';
import { useLiveViewportStore } from './useLiveViewportStore';
import {
  describeHistoryChange,
  graphHistorySlicesEqual,
  preserveProjectPresentation,
  type GraphHistorySlice,
} from '@/lib/historySemantics';
import { useHistoryMetaStore } from './useHistoryMetaStore';
import { collectAutomaticBranchNodeIds } from '@/lib/projectBranch';
import { planNodeDeletion, planNodesDeletion } from '@/lib/arrowPolicy';
import {
  EMPTY_SOURCE_LIBRARY,
  reorderSourceIds,
  withAllSourcesChecked,
  withSourceChecked,
  withSourceMode,
} from '@/lib/projectSources';

/** Select the configured automatic allocator. Sequence-based modes advance
 * their own persisted cursor; hierarchy-aware retains graph-relative behavior. */
function pickGroupColor(
  project: Project,
  seedNodeId: string | null,
): {
  color: GroupColor;
  goldenColorCursorHue?: number;
  oppositesColorBaseHue?: number;
  oppositesColorCursorIndex?: number;
} {
  const assignment = useSettingsStore.getState().groupColorAssignment;
  if (assignment === 'opposites') {
    const generated = nextOppositesGroupColor(project);
    return {
      color: generated.color,
      oppositesColorBaseHue: generated.baseHue,
      oppositesColorCursorIndex: generated.cursorIndex,
    };
  }
  if (assignment === 'golden-angle') {
    const generated = nextGoldenGroupColor(project);
    return {
      color: generated.color,
      goldenColorCursorHue: generated.cursorHue,
    };
  }
  return { color: assignGroupColorHex(deriveColorInputs(project, seedNodeId)) };
}

function rememberGroup(
  memory: LastGroupMemory,
  project: Project,
  groupId: string | null | undefined,
): LastGroupMemory {
  if (!groupId || !project.groups[groupId] || memory[project.id] === groupId) return memory;
  const next = { ...memory, [project.id]: groupId };
  writeLastGroupMemory(next);
  return next;
}

function forgetDeletedGroup(
  memory: LastGroupMemory,
  project: Project,
  deletedGroupId: string,
): LastGroupMemory {
  if (memory[project.id] !== deletedGroupId) return memory;
  const next = { ...memory };
  const fallback = Object.keys(project.groups)[0];
  if (fallback) next[project.id] = fallback;
  else delete next[project.id];
  writeLastGroupMemory(next);
  return next;
}

export function createBlankProject(name: string, rootNodeId: string, rng?: () => number): Project {
  const generatedColor = randomProjectColor(rng);
  return {
    id: newId(),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rootNodeId,
    nodes: {},
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
    // Base color for the root + ungrouped nodes: a uniformly random top-chroma
    // hue. The exact source hue also seeds both deterministic sequences.
    color: generatedColor.color,
    goldenColorCursorHue: generatedColor.hue,
    oppositesColorBaseHue: generatedColor.hue,
    oppositesColorCursorIndex: 0,
  };
}

/**
 * Transient highlight that flashes the parent's term, the connecting arrow,
 * and the child node — used when the user re-clicks an already-explored term
 * or clicks a child node and we want to draw their attention to the relation.
 * `nonce` increments per call so re-flashing the same trio still re-fires the
 * effect-deps in subscribers.
 */
export interface Highlight {
  parentNodeId: string;
  childNodeId: string;
  arrowId: string;
  /** Present for ordinary reference chips; selected-text relations are keyed by arrow. */
  term?: string;
  nonce: number;
  /** Where the flash came from. 'chip' (default) lights up the connecting
   *  arrow to help locate the spawned child; 'node' (clicking the child
   *  itself) does NOT light the arrow — you're already at the node — it only
   *  drives the on-arrival aura ripple. */
  source?: 'node' | 'chip';
}

/** Runtime-only acknowledgement that Canvas successfully settled a pan.
 * The nonce makes repeated arrivals at the same node observable. */
export interface PanArrival {
  nodeId: string;
  requestId: number;
  nonce: number;
}

/** Identity-bearing camera request. The ID prevents a stale animation frame
 * from completing a newer request, including a repeat for the same node. */
interface NodePanRequest {
  kind: 'node';
  id: string;
  includeId?: string;
  /** Panel reveals preserve the reader's vertical position and current zoom. */
  axis?: 'both' | 'x';
  /** Explicit fit-button navigation centers the node and can zoom in or out. */
  fit?: 'centered';
  /** False when movement must not trigger an additional node-arrival ripple. */
  announceArrival?: boolean;
  ids?: never;
  requestId: number;
  automatic?: CameraPanTrigger;
}

interface MultiNodePanRequest {
  kind: 'nodes';
  ids: string[];
  id?: never;
  includeId?: never;
  requestId: number;
  automatic?: CameraPanTrigger;
}

export type PanRequest = NodePanRequest | MultiNodePanRequest;

interface GraphState {
  project: Project | null;
  /** Runtime snapshot identity: same-project cloud loads must replace physics
   * too. Not persisted and deliberately excluded from undo/redo. */
  projectLoadRevision: number;
  setProject: (p: Project | null, options?: { resetRuntime?: boolean }) => void;

  /** Multi-scatter registry — the list of all scatters and which one is
   *  active. Transient at the store level: NOT in the temporal `partialize`
   *  (so switching scatters never enters undo history) and persisted
   *  separately to `projects/index.json` by the actions in projectActions.ts.
   *  The active scatter's full {@link Project} lives in `project` above. */
  projectList: ProjectMeta[];
  activeProjectId: string | null;
  setProjectList: (list: ProjectMeta[]) => void;
  setActiveProjectId: (id: string | null) => void;
  /** Topic-picker overlay flag. When true the picker floats over the current
   *  (still-mounted, blurred) project; a new project is created only on submit.
   *  Transient UI state — NOT in the temporal partialize (never enters undo). */
  pickerOpen: boolean;
  setPickerOpen: (v: boolean) => void;
  addNode: (node: ScatterNode) => void;
  updateNode: (id: string, patch: Partial<ScatterNode>) => void;
  /** Patch size fields on a node's CURRENT version (per-version sizing).
   *  Callers that shouldn't pollute undo (measurement / resize) wrap this in
   *  temporal.pause()/resume(), exactly as they do for the size updateNode
   *  calls. */
  setVersionSize: (
    id: string,
    patch: Partial<Pick<NodeVersion,
      'width' | 'interactiveCanvasWidth' | 'minWidth' | 'bodyMaxHeight' | 'minBodyHeight' | 'fullBodyHeight' | 'freeTextHeight' | 'expandedMeasureWidth'>>,
  ) => void;
  /**
   * Bulk position update — single store mutation for every node moved
   * by a physics tick. Compared to calling `updateNode(id, {position})`
   * per node, this is one shallow-clone of the nodes record instead of
   * N (each `updateNode` did its own `{ ...nodes, [id]: ... }`).
   *
   * Skips entries whose stored position is already within 0.01 px of
   * the supplied value — same dead-zone filter the Canvas onTick had
   * around the old per-node loop, just centralized here.
   *
   * Pauses temporal recording around the change is the CALLER'S job
   * (same as updateNode) so they decide whether physics updates
   * pollute undo history. Canvas always pauses around the tick.
   */
  setNodePositions: (positions: { id: string; x: number; y: number }[]) => void;
  addArrow: (arrow: Arrow) => void;
  /** Add a node and its connecting arrow in a SINGLE store mutation, so a
   *  spawn (or pop) lands as exactly ONE undo entry instead of two. */
  addNodeWithArrow: (node: ScatterNode, arrow: Arrow, references?: Arrow[]) => void;
  /** "Pop selected": atomically rewrite the parent's current-version body
   *  (the popped bullet already removed → `newParentBody`), add the new
   *  child node + connecting `arrow`, and select the child — all in ONE
   *  store mutation so the whole extraction is a single undo entry. The
   *  caller (generate.ts) computes the body split, child shape, and
   *  position; the store just commits them together. */
  popBulletToChild: (
    parentId: string,
    newParentBody: string,
    child: ScatterNode,
    arrow: Arrow,
  ) => void;
  deleteNodeCascade: (id: string) => void;
  /** Bulk actions are one semantic undo step, regardless of selection size. */
  deleteNodesCascade: (ids: readonly string[]) => void;
  setNodesFrozen: (ids: readonly string[], frozen: boolean) => void;
  assignNodesToGroup: (ids: readonly string[], groupId: string | null) => void;
  createGroupFromNodes: (ids: readonly string[], name?: string, titleGeneration?: Group['titleGeneration']) => string;
  setSelection: (ids: string[]) => void;
  setViewport: (v: Project['viewport']) => void;
  /**
   * Transient request to smoothly pan the camera to a node. Lives OUTSIDE
   * `project` so it doesn't get recorded in undo history or persisted.
   * The Canvas listens for changes (object identity) and runs an animation;
   * once done it acknowledges the captured request via `completePanTo`.
   *
   * `includeId` (optional): a second node that should also remain in
   * frame. The Canvas pan loop pans to fit the union bbox of both nodes
   * and zooms OUT only as a last resort (never zooms in). Used by
   * spawnTermClick/spawnFollowUp so the freshly-created child stays
   * visible alongside its parent.
   */
  panTo: PanRequest | null;
  panRequestNonce: number;
  requestPanTo: (
    id: string | null,
    includeId?: string,
    automatic?: CameraPanTrigger,
  ) => void;
  /** Reveal fixed chrome attached to a node without changing zoom or vertical position. */
  requestPanelReveal: (id: string) => void;
  /** Focus one node and fit it at the center of the usable workspace. */
  requestFitNode: (id: string) => void;
  requestFitNodes: (ids: readonly string[], automatic?: CameraPanTrigger) => void;
  panArrival: PanArrival | null;
  completePanTo: (requestId: number) => void;
  highlight: Highlight | null;
  highlightNonce: number;
  flashHighlight: (h: Omit<Highlight, 'nonce'>) => void;
  clearHighlight: () => void;

  /** Transient — the sidebar search query. NOT persisted, NOT in undo
   *  (partialize tracks only `project`). Lifted here so node text can
   *  highlight matches and a canvas click can reset it. */
  searchQuery: string;
  setSearchQuery: (q: string) => void;

  /** Transient origin of a node selection made through a group row/label.
   * Members live in project.selection, just like a manual multi-selection.
   * This only keeps the group's row active and the batch UI for a solo group. */
  selectedGroupId: string | null;
  selectGroup: (id: string | null) => void;
  /** Runtime UI preference, persisted separately from project files. */
  lastInteractedGroupIds: LastGroupMemory;
  touchGroup: (id: string) => void;

  /** Groups MVP — see Part B of plans/golden-singing-tarjan.md.
   *  All actions go through `set()` so they participate in the zundo
   *  temporal stack (group create/rename/recolor/delete + membership
   *  changes are undoable). Bumps `updatedAt` so the autosave layer
   *  picks them up. */
  createGroup: (name?: string, color?: GroupColor) => string;
  renameGroup: (id: string, name: string) => void;
  recolorGroup: (id: string, color: GroupColor) => void;
  /** Recolor the project's base color (root + ungrouped nodes). Undoable,
   *  same as recolorGroup. */
  recolorProject: (color: GroupColor) => void;
  /** Atomically rebuild the active project's base + group colors. */
  reassignProjectColors: (
    assignment: GroupColorAssignment,
    rng?: () => number,
  ) => void;
  /** Reorder groups by moving `fromId` to `toId`'s position (drag-reorder). */
  reorderGroup: (fromId: string, toId: string) => void;
  deleteGroup: (id: string) => void;
  assignNodeToGroup: (nodeId: string, groupId: string | null) => void;
  assignSubtreeToGroup: (rootNodeId: string, groupId: string | null) => void;
  /** Creates a group named after the node's current header and assigns
   *  the node (or the whole auto-subtree rooted at it). Returns the new
   *  group id. Picks a rotating color. */
  createGroupFromNode: (nodeId: string, spread: 'self' | 'subtree') => string;
  /** Bulk frozen toggle for every member of a group. Canvas.tsx's
   *  existing per-node frozen-diff effect propagates the change down
   *  to the physics worker — no extra worker wiring needed. */
  setGroupFrozen: (groupId: string, frozen: boolean) => void;
  /** Project-source choices are semantic and intentionally enter app-level
   * undo/redo. Import/delete publication bypasses these actions and pauses
   * temporal history in the source coordinator. */
  setSourceMode: (mode: ProjectSourceMode) => void;
  setSourceChecked: (sourceId: string, checked: boolean) => void;
  setAllSourcesChecked: (checked: boolean) => void;
  reorderSources: (sourceId: string, beforeSourceId: string) => void;
}

export const useGraphStore = create<GraphState>()(
  temporal(
    (set, get) => ({
      project: null,
      projectLoadRevision: 0,
      setProject: (project, options) => set((state) => ({
        project: project
          ? { ...project, viewport: clampViewportZoom(project.viewport) }
          : null,
        projectLoadRevision: state.projectLoadRevision + (options?.resetRuntime ? 1 : 0),
        ...(project?.id !== state.project?.id || (state.selectedGroupId && !project?.groups[state.selectedGroupId])
          ? { selectedGroupId: null } : {}),
      })),
      projectList: [],
      activeProjectId: null,
      setProjectList: (list) => set({ projectList: list }),
      setActiveProjectId: (id) => set({ activeProjectId: id }),
      pickerOpen: false,
      setPickerOpen: (v) => set({ pickerOpen: v }),
      addNode: (node) => set((s) => {
        if (!s.project) return s;
        return { project: { ...s.project, nodes: { ...s.project.nodes, [node.id]: node }, updatedAt: Date.now() } };
      }),
      updateNode: (id, patch) => set((s) => {
        if (!s.project) return s;
        const cur = s.project.nodes[id];
        if (!cur) return s;
        // Store actions are also used by layout observers and generation
        // coordinators. Treat an identical patch as a real no-op so a
        // measurement/effect cannot keep notifying React merely by writing
        // the value it just read.
        const changed = (Object.keys(patch) as Array<keyof ScatterNode>)
          .some((key) => !Object.is(cur[key], patch[key]));
        if (!changed) return s;
        return { project: { ...s.project, nodes: { ...s.project.nodes, [id]: { ...cur, ...patch } }, updatedAt: Date.now() } };
      }),
      setVersionSize: (id, patch) => set((s) => {
        if (!s.project) return s;
        const cur = s.project.nodes[id];
        if (!cur) return s;
        const idx = cur.currentVersionIndex;
        const ver = cur.versions[idx];
        if (!ver) return s;
        const changed = (Object.keys(patch) as Array<keyof typeof patch>)
          .some((key) => !Object.is(ver[key], patch[key]));
        if (!changed) return s;
        const versions = cur.chat
          ? cur.versions.map((version) => ({ ...version, ...patch }))
          : cur.versions.map((version, i) => i === idx ? { ...version, ...patch } : version);
        return { project: { ...s.project, nodes: { ...s.project.nodes, [id]: { ...cur, versions } }, updatedAt: Date.now() } };
      }),
      setNodePositions: (positions) => set((s) => {
        if (!s.project) return s;
        // Clone the nodes record ONCE; mutate in place during the
        // walk. Pre-R1 the per-node updateNode loop did N clones.
        let changed = false;
        const newNodes = { ...s.project.nodes };
        for (const p of positions) {
          const cur = newNodes[p.id];
          if (!cur) continue;
          if (Math.abs(cur.position.x - p.x) > 0.01 || Math.abs(cur.position.y - p.y) > 0.01) {
            newNodes[p.id] = { ...cur, position: { x: p.x, y: p.y } };
            changed = true;
          }
        }
        if (!changed) return s;
        return { project: { ...s.project, nodes: newNodes, updatedAt: Date.now() } };
      }),
      addArrow: (arrow) => set((s) => {
        if (!s.project) return s;
        return { project: { ...s.project, arrows: { ...s.project.arrows, [arrow.id]: arrow }, updatedAt: Date.now() } };
      }),
      addNodeWithArrow: (node, arrow, references = []) => set((s) => {
        if (!s.project) return s;
        return {
          project: {
            ...s.project,
            nodes: { ...s.project.nodes, [node.id]: node },
            arrows: { ...s.project.arrows, [arrow.id]: arrow, ...Object.fromEntries(references.map((reference) => [reference.id, reference])) },
            updatedAt: Date.now(),
          },
        };
      }),
      popBulletToChild: (parentId, newParentBody, child, arrow) => set((s) => {
        if (!s.project) return s;
        const parent = s.project.nodes[parentId];
        if (!parent) return s;
        const pv = parent.versions[parent.currentVersionIndex];
        if (!pv) return s;
        const versions = [...parent.versions];
        versions[parent.currentVersionIndex] = { ...pv, body: newParentBody };
        return {
          project: {
            ...s.project,
            nodes: {
              ...s.project.nodes,
              [parentId]: { ...parent, versions },
              [child.id]: child,
            },
            arrows: { ...s.project.arrows, [arrow.id]: arrow },
            selection: [child.id],
            updatedAt: Date.now(),
          },
        };
      }),
      deleteNodeCascade: (id) => set((s) => {
        if (!s.project) return s;
        const arrows = Object.values(s.project.arrows);
        // Find the parent of the deleted node BEFORE we mutate, so we can
        // pan the camera there afterwards. Skip if the parent is also
        // about to be deleted (cascade scenarios).
        const parentArrow = arrows.find(
          (a) => a.kind === 'auto' && a.toNodeId === id,
        );
        const parentId = parentArrow?.fromNodeId ?? null;
        const { deletedIds: toDelete, promotedArrowIds } = planNodeDeletion(s.project, id);
        const nodes = { ...s.project.nodes };
        for (const nid of toDelete) delete nodes[nid];
        const remainingArrows: Record<string, Arrow> = {};
        for (const a of arrows) {
          if (!toDelete.has(a.fromNodeId) && !toDelete.has(a.toNodeId)) {
            remainingArrows[a.id] = promotedArrowIds.has(a.id) ? { ...a, kind: 'auto' } : a;
          }
        }
        const returnToParent = parentId && nodes[parentId] && useSettingsStore.getState().cameraAutoPan.delete;
        const nextPanRequestNonce = returnToParent
          ? s.panRequestNonce + 1
          : s.panRequestNonce;
        const panTarget = returnToParent
          ? { kind: 'node' as const, id: parentId!, requestId: nextPanRequestNonce, automatic: 'delete' as const }
          : s.panTo;
        return {
          project: { ...s.project, nodes, arrows: remainingArrows, selection: [], updatedAt: Date.now() },
          selectedGroupId: null,
          panTo: panTarget,
          panRequestNonce: nextPanRequestNonce,
        };
      }),
      deleteNodesCascade: (ids) => set((s) => {
        if (!s.project) return s;
        const { deletedIds, promotedArrowIds } = planNodesDeletion(s.project, ids);
        if (!deletedIds.size) return s;
        const nodes = { ...s.project.nodes };
        for (const id of deletedIds) delete nodes[id];
        const arrows: Record<string, Arrow> = {};
        for (const arrow of Object.values(s.project.arrows)) {
          if (!deletedIds.has(arrow.fromNodeId) && !deletedIds.has(arrow.toNodeId)) {
            arrows[arrow.id] = promotedArrowIds.has(arrow.id) ? { ...arrow, kind: 'auto' } : arrow;
          }
        }
        return {
          project: { ...s.project, nodes, arrows, selection: [], updatedAt: Date.now() },
          selectedGroupId: null,
          panTo: null,
        };
      }),
      setNodesFrozen: (ids, frozen) => set((s) => {
        if (!s.project) return s;
        const nodes = { ...s.project.nodes };
        let changed = false;
        for (const id of ids) {
          const node = nodes[id];
          if (node && node.frozen !== frozen) {
            nodes[id] = { ...node, frozen };
            changed = true;
          }
        }
        return changed ? { project: { ...s.project, nodes, updatedAt: Date.now() } } : s;
      }),
      assignNodesToGroup: (ids, groupId) => set((s) => {
        if (!s.project || (groupId && !s.project.groups[groupId])) return s;
        const nodes = { ...s.project.nodes };
        let changed = false;
        for (const id of ids) {
          const node = nodes[id];
          if (!node || (groupId && id === s.project.rootNodeId) || (node.groupId ?? null) === groupId) continue;
          const { groupId: _previous, ...rest } = node;
          nodes[id] = groupId ? { ...rest, groupId } : rest;
          changed = true;
        }
        if (!changed) return s;
        return {
          project: { ...s.project, nodes, updatedAt: Date.now() },
          ...(s.selectedGroupId && s.project.selection.some((id) => ids.includes(id))
            ? { selectedGroupId: null } : {}),
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, groupId ?? undefined),
        };
      }),
      setSelection: (ids) => set((s) => {
        if (!s.project) return s;
        const next: Partial<GraphState> = {
          project: { ...s.project, selection: ids },
          selectedGroupId: null,
        };
        const focusedGroupId = ids.length > 0 ? s.project.nodes[ids[0]!]?.groupId : undefined;
        const memory = rememberGroup(s.lastInteractedGroupIds, s.project, focusedGroupId);
        if (memory !== s.lastInteractedGroupIds) next.lastInteractedGroupIds = memory;
        return next;
      }),
      setViewport: (v) => set((s) => {
        if (!s.project) return s;
        const viewport = clampViewportZoom(v);
        const before = s.project.viewport;
        if (before.x === viewport.x && before.y === viewport.y && before.zoom === viewport.zoom) return s;
        const live = useLiveViewportStore.getState();
        const liveTime = live.x === viewport.x && live.y === viewport.y && live.zoom === viewport.zoom ? live.editedAt : 0;
        return { project: { ...s.project, viewport,
          viewportUpdatedAt: Math.max(Date.now(), liveTime, (s.project.viewportUpdatedAt ?? 0) + 1) } };
      }),
      panTo: null,
      panRequestNonce: 0,
      // Each call creates a fresh object so React useEffect deps fire even
      // when the same id is requested twice in a row (e.g. two term-clicks
      // on the same node). Its requestId also makes stale completions harmless.
      requestPanTo: (id, includeId, automatic) => set((s) => {
        if (!id) return { panTo: null };
        if (automatic && !useSettingsStore.getState().cameraAutoPan[automatic]) return s;
        const requestId = s.panRequestNonce + 1;
        return {
          panRequestNonce: requestId,
          panTo: { kind: 'node', id, ...(includeId ? { includeId } : {}), ...(automatic ? { automatic } : {}), requestId },
        };
      }),
      requestPanelReveal: (id) => set((s) => {
        if (!useSettingsStore.getState().cameraAutoPan.panels) return s;
        // Auto-opening a review/outline during focus must not replace a full
        // fit with horizontal-only movement. That fit reads live panel sizes.
        if ((s.panTo?.kind === 'node' && s.panTo.id === id && s.panTo.axis !== 'x')
          || (s.panTo?.kind === 'nodes' && s.panTo.ids.includes(id))) return s;
        const requestId = s.panRequestNonce + 1;
        return {
          panRequestNonce: requestId,
          panTo: {
            kind: 'node',
            id,
            axis: 'x',
            announceArrival: false,
            automatic: 'panels',
            requestId,
          },
        };
      }),
      requestFitNode: (id) => set((s) => {
        const project = s.project;
        const node = project?.nodes[id];
        if (!project || !node) return s;
        const requestId = s.panRequestNonce + 1;
        // Publish focus and camera intent together. Focus may open chat/history
        // panels; their reveal requests must see and preserve the full fit.
        // Selection and navigation are transient, not semantic undo entries.
        return {
          project: project.selection.length === 1 && project.selection[0] === id
            ? project
            : { ...project, selection: [id] },
          selectedGroupId: null,
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, project, node.groupId),
          panRequestNonce: requestId,
          panTo: { kind: 'node', id, fit: 'centered', announceArrival: false, requestId },
        };
      }),
      requestFitNodes: (ids, automatic) => set((s) => {
        const uniqueIds = [...new Set(ids)];
        if (uniqueIds.length === 0) return { panTo: null };
        if (automatic && !useSettingsStore.getState().cameraAutoPan[automatic]) return s;
        const requestId = s.panRequestNonce + 1;
        return {
          panRequestNonce: requestId,
          panTo: { kind: 'nodes', ids: uniqueIds, ...(automatic ? { automatic } : {}), requestId },
        };
      }),
      panArrival: null,
      completePanTo: (requestId) => set((s) => {
        const active = s.panTo;
        if (!active || active.requestId !== requestId) return s;
        if (active.kind === 'nodes' || active.announceArrival === false) return { panTo: null };
        return {
          panTo: null,
          panArrival: {
            nodeId: active.id,
            requestId,
            nonce: (s.panArrival?.nonce ?? 0) + 1,
          },
        };
      }),
      highlight: null,
      highlightNonce: 0,
      flashHighlight: (h) => {
        // Event identity must outlive the visible highlight. The highlight
        // auto-clears after 1.5 s; deriving from it reused nonce 1 afterward,
        // so scene subscribers mistook a real later click for an old event.
        const nonce = get().highlightNonce + 1;
        set({ highlightNonce: nonce, highlight: { ...h, nonce } });
        // Auto-clear after 1500 ms unless a newer flash superseded us.
        setTimeout(() => {
          if (get().highlight?.nonce === nonce) set({ highlight: null });
        }, 1500);
      },
      clearHighlight: () => set({ highlight: null }),

      searchQuery: '',
      setSearchQuery: (q) => set({ searchQuery: q }),

      selectedGroupId: null,
      selectGroup: (id) => set((s) => {
        if (id === null) return {
          selectedGroupId: null,
          ...(s.selectedGroupId && s.project ? { project: { ...s.project, selection: [] } } : {}),
        };
        if (!s.project?.groups[id]) return s;
        const selection = Object.values(s.project.nodes)
          .filter((node) => node.groupId === id).map((node) => node.id);
        return {
          selectedGroupId: id,
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, id),
          project: { ...s.project, selection },
        };
      }),

      lastInteractedGroupIds: readLastGroupMemory(),
      touchGroup: (id) => set((s) => {
        if (!s.project) return s;
        const memory = rememberGroup(s.lastInteractedGroupIds, s.project, id);
        return memory === s.lastInteractedGroupIds ? s : { lastInteractedGroupIds: memory };
      }),

      createGroup: (name, color) => {
        const id = newId();
        set((s) => {
          if (!s.project) return s;
          const fallbackName = `Group ${Object.keys(s.project.groups).length + 1}`;
          const generated = color === undefined
            ? pickGroupColor(s.project, s.project.selection[0] ?? null)
            : null;
          const group: Group = {
            id,
            name: name ?? fallbackName,
            color: color ?? generated!.color,
            gravitate: false,
          };
          const project = {
              ...s.project,
              ...(generated?.goldenColorCursorHue !== undefined
                ? { goldenColorCursorHue: generated.goldenColorCursorHue }
                : {}),
              ...(generated?.oppositesColorBaseHue !== undefined
                ? { oppositesColorBaseHue: generated.oppositesColorBaseHue }
                : {}),
              ...(generated?.oppositesColorCursorIndex !== undefined
                ? { oppositesColorCursorIndex: generated.oppositesColorCursorIndex }
                : {}),
              // New groups appear at the TOP of the list.
              groups: { [id]: group, ...s.project.groups },
              updatedAt: Date.now(),
            };
          return {
            project,
            lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, project, id),
          };
        });
        return id;
      },

      renameGroup: (id, name) => set((s) => {
        if (!s.project) return s;
        const cur = s.project.groups[id];
        if (!cur) return s;
        return {
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, id),
          project: {
            ...s.project,
            groups: { ...s.project.groups, [id]: { ...cur, name, titleGeneration: undefined } },
            updatedAt: Date.now(),
          },
        };
      }),

      recolorGroup: (id, color) => set((s) => {
        if (!s.project) return s;
        const cur = s.project.groups[id];
        if (!cur) return s;
        return {
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, id),
          project: {
            ...s.project,
            groups: { ...s.project.groups, [id]: { ...cur, color } },
            updatedAt: Date.now(),
          },
        };
      }),

      recolorProject: (color) => set((s) => {
        if (!s.project) return s;
        return { project: { ...s.project, color, updatedAt: Date.now() } };
      }),

      reassignProjectColors: (assignment, rng) => set((s) => {
        if (!s.project) return s;
        const palette = reassignProjectPalette(s.project, assignment, rng);
        return {
          project: {
            ...s.project,
            color: palette.color,
            groups: palette.groups,
            goldenColorCursorHue: palette.goldenColorCursorHue,
            oppositesColorBaseHue: palette.oppositesColorBaseHue,
            oppositesColorCursorIndex: palette.oppositesColorCursorIndex,
            updatedAt: Date.now(),
          },
        };
      }),

      reorderGroup: (fromId, toId) => set((s) => {
        if (!s.project || fromId === toId) return s;
        const ids = Object.keys(s.project.groups);
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(toId);
        if (from < 0 || to < 0) return s;
        ids.splice(from, 1);
        ids.splice(to, 0, fromId);
        const groups: Record<string, Group> = {};
        for (const gid of ids) groups[gid] = s.project.groups[gid]!;
        return {
          project: { ...s.project, groups, updatedAt: Date.now() },
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, fromId),
        };
      }),

      deleteGroup: (id) => set((s) => {
        if (!s.project) return s;
        if (!s.project.groups[id]) return s;
        const groups = { ...s.project.groups };
        delete groups[id];
        // Clear groupId on every member node in the same set() call.
        const nodes = { ...s.project.nodes };
        let touchedNodes = false;
        for (const [nid, n] of Object.entries(nodes)) {
          if (n.groupId === id) {
            const { groupId: _unused, ...rest } = n;
            nodes[nid] = rest as ScatterNode;
            touchedNodes = true;
          }
        }
        const project = {
            ...s.project,
            groups,
            nodes: touchedNodes ? nodes : s.project.nodes,
            updatedAt: Date.now(),
          };
        const next: Partial<GraphState> = {
          project,
          lastInteractedGroupIds: forgetDeletedGroup(
            s.lastInteractedGroupIds,
            project,
            id,
          ),
        };
        if (s.selectedGroupId === id) next.selectedGroupId = null;
        return next;
      }),

      assignNodeToGroup: (nodeId, groupId) => set((s) => {
        if (!s.project) return s;
        // The root node is ungroupable (the origin of every branch).
        if (groupId !== null && nodeId === s.project.rootNodeId) return s;
        const cur = s.project.nodes[nodeId];
        if (!cur) return s;
        if (groupId !== null && !s.project.groups[groupId]) return s;
        let updated: ScatterNode;
        if (groupId === null) {
          if (cur.groupId === undefined) return s;
          const { groupId: _unused, ...rest } = cur;
          updated = rest as ScatterNode;
        } else {
          if (cur.groupId === groupId) return s;
          updated = { ...cur, groupId };
        }
        const touchedGroupId = groupId ?? cur.groupId;
        return {
          lastInteractedGroupIds: rememberGroup(
            s.lastInteractedGroupIds,
            s.project,
            touchedGroupId,
          ),
          project: {
            ...s.project,
            nodes: { ...s.project.nodes, [nodeId]: updated },
            updatedAt: Date.now(),
          },
        };
      }),

      assignSubtreeToGroup: (rootNodeId, groupId) => set((s) => {
        if (!s.project) return s;
        if (!s.project.nodes[rootNodeId]) return s;
        if (groupId !== null && !s.project.groups[groupId]) return s;
        const arrows = Object.values(s.project.arrows);
        const members = collectAutomaticBranchNodeIds(rootNodeId, arrows);
        const nodes = { ...s.project.nodes };
        let changed = false;
        for (const nid of members) {
          // Never group the project root (it's the ungroupable origin).
          if (groupId !== null && nid === s.project.rootNodeId) continue;
          const cur = nodes[nid];
          if (!cur) continue;
          if (groupId === null) {
            if (cur.groupId === undefined) continue;
            const { groupId: _unused, ...rest } = cur;
            nodes[nid] = rest as ScatterNode;
            changed = true;
          } else {
            if (cur.groupId === groupId) continue;
            nodes[nid] = { ...cur, groupId };
            changed = true;
          }
        }
        if (!changed) return s;
        const touchedGroupId = groupId ?? s.project.nodes[rootNodeId]?.groupId;
        return {
          lastInteractedGroupIds: rememberGroup(
            s.lastInteractedGroupIds,
            s.project,
            touchedGroupId,
          ),
          project: { ...s.project, nodes, updatedAt: Date.now() },
        };
      }),

      createGroupFromNode: (nodeId, spread) => {
        const project = get().project;
        const node = project?.nodes[nodeId];
        if (!project || !node || nodeId === project.rootNodeId) return '';
        const members = spread === 'subtree'
          ? [...collectAutomaticBranchNodeIds(nodeId, Object.values(project.arrows))]
          : [nodeId];
        return get().createGroupFromNodes(members, node.versions[node.currentVersionIndex]?.header.trim());
      },

      createGroupFromNodes: (ids, name, titleGeneration) => {
        const id = newId();
        set((s) => {
          if (!s.project) return s;
          const memberIds = ids.filter((nid) => nid !== s.project!.rootNodeId && s.project!.nodes[nid]);
          if (!memberIds.length) return s;
          const fallbackName = `Group ${Object.keys(s.project.groups).length + 1}`;
          const generated = pickGroupColor(s.project, memberIds[0]!);
          const group: Group = {
            id,
            name: name?.trim() || fallbackName,
            color: generated.color,
            gravitate: false,
            ...(titleGeneration ? { titleGeneration } : {}),
          };
          const nodes = { ...s.project.nodes };
          for (const nid of memberIds) {
            if (nid === s.project.rootNodeId) continue; // never group the root
            const cur = nodes[nid];
            if (cur) nodes[nid] = { ...cur, groupId: id };
          }
          const project = {
              ...s.project,
              ...(generated.goldenColorCursorHue !== undefined
                ? { goldenColorCursorHue: generated.goldenColorCursorHue }
                : {}),
              ...(generated.oppositesColorBaseHue !== undefined
                ? { oppositesColorBaseHue: generated.oppositesColorBaseHue }
                : {}),
              ...(generated.oppositesColorCursorIndex !== undefined
                ? { oppositesColorCursorIndex: generated.oppositesColorCursorIndex }
                : {}),
              groups: { [id]: group, ...s.project.groups },
              nodes,
              updatedAt: Date.now(),
            };
          return {
            project,
            ...(s.selectedGroupId && s.project.selection.some((nid) => memberIds.includes(nid))
              ? { selectedGroupId: null } : {}),
            lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, project, id),
          };
        });
        return id;
      },

      setGroupFrozen: (groupId, frozen) => set((s) => {
        if (!s.project) return s;
        if (!s.project.groups[groupId]) return s;
        const nodes = { ...s.project.nodes };
        let changed = false;
        for (const [nid, n] of Object.entries(nodes)) {
          if (n.groupId === groupId && n.frozen !== frozen) {
            nodes[nid] = { ...n, frozen };
            changed = true;
          }
        }
        if (!changed) return s;
        return {
          lastInteractedGroupIds: rememberGroup(s.lastInteractedGroupIds, s.project, groupId),
          project: { ...s.project, nodes, updatedAt: Date.now() },
        };
      }),

      setSourceMode: (mode) => set((s) => {
        if (!s.project) return s;
        const current = s.project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY;
        const sourceLibrary = withSourceMode(current, mode);
        if (sourceLibrary === current) return s;
        return { project: { ...s.project, sourceLibrary, updatedAt: Date.now() } };
      }),

      setSourceChecked: (sourceId, checked) => set((s) => {
        if (!s.project) return s;
        const current = s.project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY;
        const sourceLibrary = withSourceChecked(current, sourceId, checked);
        if (sourceLibrary === current) return s;
        return { project: { ...s.project, sourceLibrary, updatedAt: Date.now() } };
      }),

      setAllSourcesChecked: (checked) => set((s) => {
        if (!s.project) return s;
        const current = s.project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY;
        const sourceLibrary = withAllSourcesChecked(current, checked);
        if (sourceLibrary === current) return s;
        return { project: { ...s.project, sourceLibrary, updatedAt: Date.now() } };
      }),

      reorderSources: (sourceId, beforeSourceId) => set((s) => {
        if (!s.project) return s;
        const current = s.project.sourceLibrary ?? EMPTY_SOURCE_LIBRARY;
        const sourceLibrary = reorderSourceIds(current, sourceId, beforeSourceId);
        if (sourceLibrary === current) return s;
        return { project: { ...s.project, sourceLibrary, updatedAt: Date.now() } };
      }),
    }),
    {
      partialize: (state): GraphHistorySlice => ({ project: state.project }),
      limit: 100,
      equality: graphHistorySlicesEqual,
      onSave: (pastState, currentState) => {
        const past = pastState as unknown as GraphHistorySlice;
        const current = currentState as unknown as GraphHistorySlice;
        useHistoryMetaStore.getState().record(
          describeHistoryChange(past.project, current.project),
        );
      },
    },
  ),
);

/**
 * zundo restores complete project snapshots, which is valuable for deleted
 * subtrees and media references. Wrap its controls once so applying those
 * snapshots retains the user's present camera/layout and keeps the parallel
 * human-readable action stack in sync.
 */
const temporalStore = useGraphStore.temporal;
const rawUndo = temporalStore.getState().undo;
const rawRedo = temporalStore.getState().redo;
const rawClear = temporalStore.getState().clear;

function applyHistoryStep(direction: 'undo' | 'redo', steps = 1): void {
  const before = useGraphStore.getState().project;
  if (direction === 'undo') rawUndo(steps);
  else rawRedo(steps);
  const restored = useGraphStore.getState().project;
  const project = preserveProjectPresentation(before, restored);

  temporalStore.getState().pause();
  try {
    useGraphStore.setState((state) => ({
      project,
      // The sidebar keeps a lightweight mirror of the active project. Undoing
      // a color/name edit must update that row without turning the mirror write
      // into another history entry.
      projectList: project
        ? state.projectList.map((meta) => (
            meta.id === project.id
              ? {
                  ...meta,
                  name: project.name,
                  updatedAt: project.updatedAt,
                  color: project.color,
                }
              : meta
          ))
        : state.projectList,
    }));
  } finally {
    temporalStore.getState().resume();
  }

  if (direction === 'undo') useHistoryMetaStore.getState().undo(steps);
  else useHistoryMetaStore.getState().redo(steps);
}

temporalStore.setState({
  undo: (steps = 1) => applyHistoryStep('undo', steps),
  redo: (steps = 1) => applyHistoryStep('redo', steps),
  clear: () => {
    rawClear();
    useHistoryMetaStore.getState().clear();
  },
});
