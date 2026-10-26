'use client';
import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { NodeView } from './NodeView';
import { NodeSidePanel, PANEL_W, PANEL_GAP } from './NodeSidePanel';
import { NodeCitationsPanel, rightPanelFallbackWidth } from './NodeCitationsPanel';
import { WikimediaDiscoveryCoordinator } from './WikimediaDiscoveryCoordinator';
import { ArrowLayer } from './ArrowLayer';
import { AsciiAuraLayer } from './AsciiAuraLayer';
import { SearchHighlighter } from './SearchHighlighter';
import { ReadingHighlighter } from './ReadingHighlighter';
import { SelectionToolbar } from './SelectionToolbar';
import { NodeSelectionToolbar } from './NodeSelectionToolbar';
import { useNodeMultiSelection, toggleNodeSelection } from './useNodeMultiSelection';
import { RelationHoverPreview } from './RelationHoverPreview';
import { NodeOverviewController } from './NodeOverviewController';
import { CanvasToolbar } from './CanvasToolbar';
import { PixelRuler } from '@/components/dev/PixelRuler';
import { PhysicsClient, type SizeWake } from '@/physics/physicsClient';
import { retryGeneration, hasRetryArgs } from '@/lib/generate';
import { hasImageRetryArgs, retryImageGeneration } from '@/lib/imageGeneration';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { extendBBoxForPanels, fitBBoxInViewport, NODE_BOTTOM_PANEL_GAP } from '@/lib/fitBBox';
import { FIT_MARGIN_PX, SIDEBAR_WIDTH } from '@/lib/nodeVisibility';
import { currentContentType } from '@/lib/nodeContentType';
import { isStillImageMedia } from '@/lib/imageEditActions';
import { computeEdgePan } from '@/lib/edgePan';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useNodeSelectionDismiss } from '@/lib/useNodeSelectionDismiss';
import { isBatchNodeSelection } from '@/lib/nodeSelection';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { compactRopeAnchors } from '@/physics/compactRopeAnchors';
import {
  centerDistance,
  directAutoRelativeIds,
  dragAwayExcessFromAny,
  pinArmStrength,
  shouldPinOnDragAwayFromAny,
} from '@/lib/dragAwayPin';
import { useDragHintStore } from '@/store/useDragHintStore';
import { useDragArmStore } from '@/store/useDragArmStore';
import type { Arrow, ScatterNode } from '@/store/types';
import { pinchZoomDelta } from './pinchZoomDelta';
import { useArrowLabelStore } from '@/store/useArrowLabelStore';
import { useGroupLabelStore } from '@/store/useGroupLabelStore';
import { hitTestGroupLabels } from '@/lib/asciiAura/groupLabelHit';
import { groupLabelMode, type GroupLabelTarget } from '@/lib/asciiAura/groupLabels';
import { MAX_CAMERA_ZOOM, MIN_CAMERA_ZOOM } from '@/lib/zoomLimits';
import { useImageGenerationAvailable } from '@/hooks/useImageGenerationAvailable';
import { wheelZoomLevel, zoomViewportAroundPoint } from '@/lib/viewportZoom';
import { revealRelationSource } from '@/lib/relationNavigation';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { isArrowVisible } from '@/lib/arrowPolicy';
import { hitTestArrowLabelEntry } from '@/lib/asciiAura/arrowLabelHit';
import { createImageArrowSourceSync } from '@/lib/imageArrowSourceSync';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';

type AsciiLabelTarget =
  | { kind: 'node'; nodeId: string; arrowId?: string }
  | GroupLabelTarget;

/** Zoom-around-cursor target viewport for one wheel tick. Keeps the world point
 *  under the cursor fixed; returns null when the zoom clamps (no change).
 *  Shared by the normal wheel-zoom and the Ctrl/⌘+wheel "force scroll" zoom so
 *  the two can't drift. */
function wheelZoomTarget(
  cur: { x: number; y: number; zoom: number },
  clientX: number,
  clientY: number,
  deltaY: number,
  rect: DOMRect | undefined,
): { x: number; y: number; zoom: number } | null {
  const z0 = cur.zoom;
  const z1 = wheelZoomLevel(z0, deltaY, MIN_CAMERA_ZOOM, MAX_CAMERA_ZOOM);
  if (z1 === z0) return null;
  if (!rect) return { x: cur.x, y: cur.y, zoom: z1 };
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  return zoomViewportAroundPoint(cur, { x: mx, y: my }, z1);
}

/** Node↔relative center-to-center distance, preferring live (physics) positions
 *  over committed ones. Used by the drag-away auto-pin. */
function relativeDistance(
  node: ScatterNode,
  relative: ScatterNode,
  live: Record<string, { x: number; y: number }>,
): number {
  const rect = (n: ScatterNode) => ({
    x: live[n.id]?.x ?? n.position.x,
    y: live[n.id]?.y ?? n.position.y,
    w: nodeWidth(n),
    h: nodeRenderedH(n),
  });
  return centerDistance(rect(node), rect(relative));
}

type PhysicsNodeState = {
  width: number;
  height: number;
  frozen: boolean;
};

function sizeWakeForNode(
  node: ScatterNode,
  prev: PhysicsNodeState | undefined,
  next: PhysicsNodeState,
): SizeWake {
  if (!prev) return 'normal';
  const widthChanged = Math.abs(prev.width - next.width) > 0.01;
  const heightChanged = Math.abs(prev.height - next.height) > 0.01;
  if (!heightChanged) return 'normal';
  if (node.generating || widthChanged) return 'normal';
  // Shrink must stay 'normal': the worker's arrow reroute (marked in its
  // set-size handler) only executes during simulation ticks, and neighbors
  // only close in over the freed space while the sim is awake. 'none' here
  // left arrows anchored to the old taller rect and a permanent vacuum
  // around a collapsed node. The delta-scaled alpha already whispers for
  // tiny corrections, so 'normal' does not reintroduce the reload nudge.
  return next.height < prev.height ? 'normal' : 'gentle';
}

const STARTUP_NODE_BATCH_SIZE = 1;
const STARTUP_IDLE_TIMEOUT_MS = 100;

interface Props {
  /** Mount startup node cards as low-priority browser work while the restoration
   *  overlay remains visible, then report when the full canvas is committed. */
  progressiveStartup?: boolean;
  onStartupReady?: () => void;
  /** The restoration overlay owns the visible ASCII field during startup;
   *  avoid running the graph-backed renderer invisibly underneath it. */
  suppressAuraLayer?: boolean;
  sidebarCollapsed: boolean;
  /** Sidebar is peeking open (transient hover reveal) — suppresses the
   *  top-right toolbar's duplicate model picker. */
  sidebarPeeking?: boolean;
  onOpenSettings: () => void;
  onReferenceClick: (nodeId: string, term: string, opts: { withModifier: boolean }) => void;
  // The action wiring (ask/modify/edit/regen) used to live here but moved to
  // SidebarNodeActions. These remain so page.tsx's wiring stays explicit and
  // we can re-attach in-node controls if we ever want them again.
  onAskFollowUp: (nodeId: string, q: string) => void;
  onModify: (nodeId: string, instruction: string) => void;
  /** Optional tap into the physics tick stream. Used by the sandbox to
   *  record per-tick positions for replay. */
  onPhysicsTick?: (
    positions: { id: string; x: number; y: number }[],
    arrowAnchors: Record<string, { x: number; y: number }[]>,
  ) => void;
  /** Called once when the physics client is created, and again with null
   *  when it's destroyed. Used by the sandbox to pause the worker during
   *  replay. */
  onPhysicsReady?: (client: PhysicsClient | null) => void;
}

export function Canvas(props: Props) {
  const project = useGraphStore((s) => s.project);
  const batchSelected = useGraphStore((s) => isBatchNodeSelection(s.project?.selection, s.selectedGroupId));
  const projectLoadRevision = useGraphStore((s) => s.projectLoadRevision);
  const imageGenerationAvailable = useImageGenerationAvailable();
  const projectNodes = project ? Object.values(project.nodes) : [];
  const [startupNodeLimit, setStartupNodeLimit] = useState(() => (
    props.progressiveStartup
      ? Math.min(STARTUP_NODE_BATCH_SIZE, projectNodes.length)
      : projectNodes.length
  ));
  const startupReadySentRef = useRef(false);
  const onStartupReadyRef = useRef(props.onStartupReady);
  onStartupReadyRef.current = props.onStartupReady;

  useEffect(() => {
    if (!props.progressiveStartup) return;

    const afterPaint = (callback: () => void) => {
      // Hidden tabs throttle animation frames. They should still finish
      // restoring in the background rather than waiting to become visible.
      if (document.hidden) {
        const timer = window.setTimeout(callback, 0);
        return () => window.clearTimeout(timer);
      }
      const frame = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frame);
    };

    const scheduleNodeMount = (callback: () => void) => {
      const runAsBackgroundWork = () => startTransition(callback);
      // Hidden tabs do not receive dependable idle callbacks. Finish preparing
      // the project there instead of waiting until the tab becomes visible.
      if (document.hidden) {
        const timer = window.setTimeout(runAsBackgroundWork, 0);
        return () => window.clearTimeout(timer);
      }
      // requestIdleCallback runs after the browser has drawn the visible frame.
      // The timeout guarantees progress on a continuously busy canvas without
      // imposing the old fixed 50ms delay after every single node.
      if (typeof window.requestIdleCallback === 'function') {
        const idle = window.requestIdleCallback(runAsBackgroundWork, {
          timeout: STARTUP_IDLE_TIMEOUT_MS,
        });
        return () => window.cancelIdleCallback(idle);
      }
      // Safari/older-browser fallback: rAF chooses a frame boundary and the
      // zero-delay task runs after that frame has had its chance to paint.
      let timer: number | null = null;
      const frame = requestAnimationFrame(() => {
        timer = window.setTimeout(runAsBackgroundWork, 0);
      });
      return () => {
        cancelAnimationFrame(frame);
        if (timer !== null) window.clearTimeout(timer);
      };
    };

    if (startupNodeLimit < projectNodes.length) {
      return scheduleNodeMount(() => {
        setStartupNodeLimit((current) => Math.min(
          projectNodes.length,
          current + STARTUP_NODE_BATCH_SIZE,
        ));
      });
    }
    if (!startupReadySentRef.current) {
      return afterPaint(() => {
        if (startupReadySentRef.current) return;
        startupReadySentRef.current = true;
        onStartupReadyRef.current?.();
      });
    }
  }, [projectNodes.length, props.progressiveStartup, startupNodeLimit]);

  const setSelection = useGraphStore((s) => s.setSelection);
  const selectGroup = useGraphStore((s) => s.selectGroup);
  const setViewport = useGraphStore((s) => s.setViewport);

  const physicsConfig = useSettingsStore((s) => s.physicsConfig);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useNodeSelectionDismiss(containerRef);
  const multiSelection = useNodeMultiSelection(containerRef);
  const physicsRef = useRef<PhysicsClient | null>(null);
  const imageSourceSyncRef = useRef<ReturnType<typeof createImageArrowSourceSync> | null>(null);
  // Held in a ref so prop changes don't force a physics re-init.
  const onPhysicsTickRef = useRef(props.onPhysicsTick);
  onPhysicsTickRef.current = props.onPhysicsTick;
  const onPhysicsReadyRef = useRef(props.onPhysicsReady);
  onPhysicsReadyRef.current = props.onPhysicsReady;
  // Latest sidebar-open state, read by the camera-fit math (which mustn't
  // re-run its pan animation just because the sidebar toggled).
  const sidebarCollapsedRef = useRef(props.sidebarCollapsed);
  sidebarCollapsedRef.current = props.sidebarCollapsed;
  const knownNodesRef = useRef<Set<string>>(new Set());
  const knownArrowsRef = useRef<Map<string, Arrow>>(new Map());
  const lastPhysicsNodeStateRef = useRef<Record<string, PhysicsNodeState>>({});
  // Drag-tracking: the kind of in-flight drag (so we know whether to apply
  // edge-pan), and the accumulated camera pan during this drag — used to
  // adjust NodeView's drag-target so the dragged node stays under the
  // cursor even as the viewport scrolls to follow it.
  const dragKindRef = useRef<'drag' | 'resize' | null>(null);
  // While a resize is in progress, NodeView owns that node's live position
  // (it computes x/y coupled to the size). Hold the id here so the physics
  // tick can SKIP echoing a competing position for it — otherwise the
  // worker's slightly-different, one-frame-late position fights NodeView's
  // and the card shakes (only on corners that move x/y; bottom-right is fine).
  const resizingNodeIdRef = useRef<string | null>(null);
  const dragPanAccumRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Previous frame's raw drag target (the un-compensated x/y from NodeView).
  // Used to measure which way the user is moving the node, so edge-pan only
  // follows an edge the node is actually heading toward. `null` between drags.
  const dragPrevPosRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Shared selection/group drag cache.
   *
   * A multi-selection takes precedence over the active group. Header
   * drags (never resizing) store each participating node's offset from the
   * dragged node's starting position, so onDragMove can drive the
   * whole pack with a single delta per frame.
   *
   * `null` means "no group fan-out" — drag handlers fall back to the
   * single-node code path.
   */
  const groupDragRef = useRef<{
    memberIds: string[];
    offsets: Map<string, { x: number; y: number }>;
  } | null>(null);
  // Auto-pin-on-drag-away: at drag-start record every directly connected
  // parent/child and its center-to-center distance. Pulling far enough away
  // from ANY one of them pins on release. `null` when the gesture isn't an
  // eligible single-node header drag or the node has no automatic relatives.
  const dragAwayRef = useRef<{
    relatives: { nodeId: string; distStart: number }[];
  } | null>(null);
  // PERF R4: vRef removed. Pre-R4 we kept a viewport ref on Canvas so
  // memoized NodeView closures could read the camera without forcing
  // a re-render. Post-R4 the live viewport store IS that ref — node
  // callbacks call `useLiveViewportStore.getState()` inline (see
  // onDragMove edge-pan below).
  // PERF R2: per-node project-position snapshot taken at the end of
  // each project-change effect run. The next run uses it to detect
  // which nodes' project.position actually changed (vs unrelated
  // edits like text/frozen) and only syncs THOSE into the live store.
  // Without this, every project mutation (e.g. text edit on node B
  // while node A is physics-settling) would clobber A's live position
  // back to whatever was in project — visible as a jump-back.
  const lastProjectPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  // Mirrors lastProjectPositionsRef for the viewport: tracks the last
  // project.viewport so we only reseed the live camera when it ACTUALLY
  // changed (undo/redo/load) — not on every per-chunk project re-mint.
  const lastViewportRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const wheelZoomCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleWheelZoomCommit = useCallback(() => {
    if (wheelZoomCommitTimerRef.current !== null) clearTimeout(wheelZoomCommitTimerRef.current);
    wheelZoomCommitTimerRef.current = setTimeout(() => {
      wheelZoomCommitTimerRef.current = null;
      const lv = useLiveViewportStore.getState();
      setViewport({ x: lv.x, y: lv.y, zoom: lv.zoom });
    }, 140);
  }, [setViewport]);
  useEffect(() => () => {
    if (wheelZoomCommitTimerRef.current !== null) clearTimeout(wheelZoomCommitTimerRef.current);
  }, []);
  // PERF R2: deferred flush of all live positions → project, scheduled
  // by drag-end. Pauses temporal so the flush doesn't add an extra
  // undo step on top of the drag-end commit, but still triggers the
  // persist subscriber so autosave captures the settled positions.
  const settleFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSettleFlush = () => {
    if (settleFlushTimerRef.current !== null) clearTimeout(settleFlushTimerRef.current);
    const scheduledProjectId = useGraphStore.getState().project?.id;
    const scheduledRevision = useGraphStore.getState().projectLoadRevision;
    settleFlushTimerRef.current = setTimeout(() => {
      settleFlushTimerRef.current = null;
      const proj = useGraphStore.getState().project;
      // Node IDs are intentionally reused when a branch is copied into a new
      // project. A drag-settle callback from the previous canvas must never
      // interpret the next project's same IDs as its own.
      if (!proj || proj.id !== scheduledProjectId || useGraphStore.getState().projectLoadRevision !== scheduledRevision) return;
      const live = useLivePositionsStore.getState().positions;
      // Build a positions array for nodes whose project position
      // differs from live by more than the 0.01 px dead zone.
      const toCommit: { id: string; x: number; y: number }[] = [];
      for (const [id, n] of Object.entries(proj.nodes)) {
        const lp = live[id];
        if (!lp) continue;
        if (Math.abs(lp.x - n.position.x) > 0.01 || Math.abs(lp.y - n.position.y) > 0.01) {
          toCommit.push({ id, x: lp.x, y: lp.y });
        }
      }
      if (toCommit.length === 0) return;
      useGraphStore.temporal.getState().pause();
      try {
        useGraphStore.getState().setNodePositions(toCommit);
      } finally {
        useGraphStore.temporal.getState().resume();
      }
    }, 1500);
  };
  useEffect(() => () => {
    if (settleFlushTimerRef.current !== null) {
      clearTimeout(settleFlushTimerRef.current);
      settleFlushTimerRef.current = null;
    }
  }, []);

  // Initialize physics on first project load.
  useEffect(() => {
    if (!project || physicsRef.current) return;
    const physicsProjectId = project.id;
    const physicsRevision = projectLoadRevision;
    const isCurrentSnapshot = () => {
      const state = useGraphStore.getState();
      return state.project?.id === physicsProjectId && state.projectLoadRevision === physicsRevision;
    };
    const phx = new PhysicsClient();
    const initialPhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG, ...(physicsConfig ?? {}) };
    const restoredAnchors: Record<string, { x: number; y: number }[]> = {};
    for (const [id, arrow] of Object.entries(project.arrows)) {
      const compact = compactRopeAnchors(
        arrow.anchors,
        initialPhysicsConfig.ropeMaxSegmentLength,
        initialPhysicsConfig.ropeMaxAnchorCount,
      );
      if (compact) restoredAnchors[id] = compact;
    }
    phx.init(
      Object.values(project.nodes).map(n => ({ id: n.id, x: n.position.x, y: n.position.y, frozen: n.frozen })),
      Object.values(project.arrows).map(a => ({
        source: a.fromNodeId, target: a.toNodeId,
        kind: a.kind, gravitates: !!a.gravitates,
        arrowId: a.id,
        // Restore persisted chain shape on reload — undefined for newly
        // created arrows, the worker seeds a straight line in that case.
        anchors: restoredAnchors[a.id],
      })),
      initialPhysicsConfig,
    );
    // Pre-populate the runtime anchor store so ArrowLayer can render the
    // persisted shape on the very first frame, before the worker has had
    // a chance to emit its first tick.
    if (project.arrows) {
      const initial: Record<string, { x: number; y: number }[]> = {};
      for (const id of Object.keys(project.arrows)) {
        if (restoredAnchors[id]) initial[id] = restoredAnchors[id]!;
      }
      if (Object.keys(initial).length > 0) {
        useArrowAnchorsStore.getState().setAnchors(initial);
      }
    }
    knownNodesRef.current = new Set(Object.keys(project.nodes));
    knownArrowsRef.current = new Map(Object.entries(project.arrows));
    lastPhysicsNodeStateRef.current = {};
    // PERF R2: seed live positions from the just-loaded project so the
    // first paint has the right transforms before the worker has had a
    // chance to emit its first tick (mirror of the arrow-anchor
    // pre-population a few lines below).
    {
      const entries: [string, { x: number; y: number }][] = [];
      for (const [id, n] of Object.entries(project.nodes)) {
        entries.push([id, { x: n.position.x, y: n.position.y }]);
      }
      useLivePositionsStore.getState().seedFromMap(entries);
    }
    // PERF R4: seed live viewport too — same reason. CameraTransform
    // reads from the live store, so we need it populated before first
    // paint or the camera flashes to identity (0,0,1) for a frame.
    useLiveViewportStore.getState().seedFrom(project.viewport, project.viewportUpdatedAt);
    // PERF R6: rAF-throttled tick handler. The physics worker can emit
    // faster than the display refreshes — on a 144 Hz monitor with a
    // light scene that means 2.4 main-thread tasks per visible frame,
    // each doing store-write + subscriber dispatch. Coalescing to one
    // commit per rAF caps main-thread work at "display refresh rate",
    // independent of worker emit rate.
    //
    // The held tick is always the LATEST one (we overwrite on each
    // arrival). Intermediate ticks are dropped — fine for physics
    // visualization, since interpolating to the latest is more correct
    // than rendering stale intermediates.
    //
    // For SSR-safety / Node tests we fall back to immediate dispatch
    // when `requestAnimationFrame` isn't available.
    type TickPayload = {
      positions: { id: string; x: number; y: number }[];
      arrowAnchors: Record<string, { x: number; y: number }[]>;
      removedArrowIds: string[];
    };
    let pendingTick: TickPayload | null = null;
    let rafId: number | null = null;
    const hasRaf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
    const flushPendingTick = () => {
      rafId = null;
      if (!pendingTick) return;
      // Project switching is asynchronous relative to worker messages. Branch
      // projects preserve node IDs but translate their coordinates, so a
      // queued tick from the old worker would otherwise overwrite the newly
      // loaded project's nodes (and autosave those wrong coordinates).
      if (!isCurrentSnapshot()) {
        pendingTick = null;
        return;
      }
      const { positions, arrowAnchors, removedArrowIds } = pendingTick;
      pendingTick = null;
      // PERF R2: physics ticks write to the LIVE position store only;
      // `project.nodes[id].position` is no longer mutated on every
      // tick. NodeView subscribes per-node to the live store, so only
      // moved nodes re-render. Canvas itself stops re-rendering on
      // physics motion entirely (it subscribes to `project`, which now
      // doesn't change on tick). `project.position` is committed at
      // drag-end and folded in at save time — see onDragEnd below and
      // persist.ts.
      // While a node is being resized, NodeView writes that node's live
      // position synchronously every frame; the worker's echo for the SAME
      // node is one rAF behind and re-clamped, so applying it here makes the
      // card alternate between the two values = the resize shake. Skip just
      // that one node (others still update so neighbours visibly make room).
      const skip = resizingNodeIdRef.current;
      const live = skip ? positions.filter((p) => p.id !== skip) : positions;
      useLivePositionsStore.getState().setPositions(live);
      // Anchor chains: runtime-only, no temporal. Worker already shapes the
      // payload as Record<arrowId, AnchorPos[]> so we forward it directly.
      const anchorStore = useArrowAnchorsStore.getState();
      anchorStore.mergeAnchors(arrowAnchors);
      anchorStore.removeAnchors(removedArrowIds);
      // The sandbox recorder asks for complete frames. Normal app canvases
      // have no callback and retain the worker/main-thread delta path.
      if (onPhysicsTickRef.current) {
        const allPositions = Object.entries(useLivePositionsStore.getState().positions)
          .map(([id, p]) => ({ id, x: p.x, y: p.y }));
        onPhysicsTickRef.current(allPositions, useArrowAnchorsStore.getState().anchors);
      }
    };
    const unsubscribeTick = phx.onTick((positions, arrowAnchors, removedArrowIds) => {
      if (!isCurrentSnapshot()) return;
      pendingTick = pendingTick
        ? {
            positions: [...pendingTick.positions, ...positions],
            arrowAnchors: { ...pendingTick.arrowAnchors, ...arrowAnchors },
            removedArrowIds: [...new Set([...pendingTick.removedArrowIds, ...removedArrowIds])],
          }
        : { positions, arrowAnchors, removedArrowIds };
      if (!hasRaf) { flushPendingTick(); return; }
      if (rafId === null) rafId = window.requestAnimationFrame(flushPendingTick);
    });
    physicsRef.current = phx;
    const syncImageSources = createImageArrowSourceSync(phx, (id) => knownArrowsRef.current.has(id));
    imageSourceSyncRef.current = syncImageSources;
    const unsubscribeImageGeometry = useImageGeometryStore.subscribe(() => {
      const current = useGraphStore.getState().project;
      if (current?.id === physicsProjectId) syncImageSources.sync(current);
    });
    onPhysicsReadyRef.current?.(phx);
    return () => {
      // PERF R6: cancel any pending rAF before terminating the worker
      // so we don't try to flush against a torn-down store.
      if (rafId !== null && hasRaf) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
        pendingTick = null;
      }
      onPhysicsReadyRef.current?.(null);
      unsubscribeTick();
      unsubscribeImageGeometry();
      imageSourceSyncRef.current = null;
      phx.terminate();
      physicsRef.current = null;
      knownNodesRef.current.clear();
      knownArrowsRef.current.clear();
      lastPhysicsNodeStateRef.current = {};
      lastProjectPositionsRef.current = {};
      lastViewportRef.current = null;
      if (settleFlushTimerRef.current !== null) clearTimeout(settleFlushTimerRef.current);
      if (wheelZoomCommitTimerRef.current !== null) clearTimeout(wheelZoomCommitTimerRef.current);
      settleFlushTimerRef.current = null;
      wheelZoomCommitTimerRef.current = null;
      useArrowAnchorsStore.getState().clear();
      useLivePositionsStore.getState().clear();
    };
  }, [project?.id, projectLoadRevision]);

  // Diff nodes and arrows against what physics already knows; propagate changes.
  useEffect(() => {
    const phx = physicsRef.current;
    if (!phx || !project) return;
    // PERF R2: when a node is added (spawn, undo of a delete), seed
    // its live position from the project so NodeView has the right
    // transform before the worker emits its first tick covering it.
    for (const id in project.nodes) {
      if (!knownNodesRef.current.has(id)) {
        const n = project.nodes[id]!;
        phx.addNode({ id: n.id, x: n.position.x, y: n.position.y, frozen: n.frozen });
        knownNodesRef.current.add(id);
        useLivePositionsStore.getState().setPosition(id, n.position.x, n.position.y);
      }
    }
    const toRemove: string[] = [];
    for (const id of knownNodesRef.current) {
      if (!project.nodes[id]) toRemove.push(id);
    }
    if (toRemove.length > 0) {
      phx.removeNodes(toRemove);
      for (const id of toRemove) knownNodesRef.current.delete(id);
      for (const id of toRemove) delete lastPhysicsNodeStateRef.current[id];
      // PERF R2: drop live positions for nodes that disappeared from
      // the project (cascade-delete, undo-redo of an add, etc.).
      useLivePositionsStore.getState().removePositions(toRemove);
    }
    for (const id in project.arrows) {
      const a = project.arrows[id]!;
      const previous = knownArrowsRef.current.get(id);
      if (!previous || previous.kind !== a.kind || previous.fromNodeId !== a.fromNodeId || previous.toNodeId !== a.toNodeId) {
        // Promotion (and its undo) changes physics even though the arrow ID
        // survives. Preserve the routed shape while replacing its link type.
        if (previous) phx.removeLinks([id]);
        const currentPhysicsConfig = {
          ...DEFAULT_PHYSICS_CONFIG,
          ...(useSettingsStore.getState().physicsConfig ?? {}),
        };
        const compactAnchors = compactRopeAnchors(
          (previous && useArrowAnchorsStore.getState().anchors[id]) || a.anchors,
          currentPhysicsConfig.ropeMaxSegmentLength,
          currentPhysicsConfig.ropeMaxAnchorCount,
        );
        phx.addLink({
          source: a.fromNodeId, target: a.toNodeId,
          kind: a.kind, gravitates: !!a.gravitates,
          arrowId: a.id,
          anchors: compactAnchors,
        });
        imageSourceSyncRef.current?.forget(id);
        if (compactAnchors) {
          useArrowAnchorsStore.getState().mergeAnchors({ [a.id]: compactAnchors });
        }
        knownArrowsRef.current.set(id, a);
      }
    }
    const removedArrowIds: string[] = [];
    for (const id of knownArrowsRef.current.keys()) {
      if (!project.arrows[id]) {
        knownArrowsRef.current.delete(id);
        removedArrowIds.push(id);
      }
    }
    if (removedArrowIds.length > 0) {
      phx.removeLinks(removedArrowIds);
      useArrowAnchorsStore.getState().removeAnchors(removedArrowIds);
    }
    const lastPhysics = lastPhysicsNodeStateRef.current;
    const nextPhysics: Record<string, PhysicsNodeState> = {};
    for (const id in project.nodes) {
      const n = project.nodes[id]!;
      const state: PhysicsNodeState = {
        width: nodeWidth(n),
        height: nodeRenderedH(n),
        frozen: !!n.frozen,
      };
      const prev = lastPhysics[id];
      const sizeChanged = !prev
        || Math.abs(prev.width - state.width) > 0.01
        || Math.abs(prev.height - state.height) > 0.01;
      if (sizeChanged) {
        phx.setSize(id, state.width, state.height, { wake: sizeWakeForNode(n, prev, state) });
      }
      if (prev && prev.frozen !== state.frozen) {
        phx.setFrozen(id, state.frozen);
      }
      nextPhysics[id] = state;
    }
    lastPhysicsNodeStateRef.current = nextPhysics;
    imageSourceSyncRef.current?.sync(project);
    // PERF R2: project → live position sync, but ONLY for nodes whose
    // project.position actually changed in THIS update. We track the
    // per-node project position from the previous run in
    // lastProjectPositionsRef; a diff here means the change came from
    // a user-initiated mutation (drag-end commit, settle-flush, undo,
    // redo, manual updateNode) — so we propagate that authoritative
    // value into live. Unrelated mutations (text edits, frozen
    // toggles) don't touch position and are skipped, preserving any
    // physics motion that has advanced live without committing back
    // to project yet. Without this guard, every project change would
    // snap settled nodes back to their last committed positions.
    const last = lastProjectPositionsRef.current;
    const newLast: Record<string, { x: number; y: number }> = {};
    for (const id in project.nodes) {
      const n = project.nodes[id]!;
      const prev = last[id];
      if (!prev || prev.x !== n.position.x || prev.y !== n.position.y) {
        useLivePositionsStore.getState().setPosition(id, n.position.x, n.position.y);
      }
      newLast[id] = { x: n.position.x, y: n.position.y };
    }
    lastProjectPositionsRef.current = newLast;
    // PERF R4 + flicker fix: project → live viewport sync. Mirrors the
    // position logic above — only reseed when project.viewport ACTUALLY
    // changed (undo, redo, file load) so CameraTransform shows the restored
    // camera. We must NOT seed just because the effect re-ran: streaming
    // re-mints `project` on every chunk, and during a drag the live store
    // holds the in-progress pan while project.viewport stays at the last
    // commit. An unconditional seed then snapped the camera back to that
    // stale value every chunk — the flicker. seedFrom's own dead-zone can't
    // catch this because live and project legitimately differ mid-drag.
    const pv = project.viewport;
    const lvp = lastViewportRef.current;
    if (!lvp || lvp.x !== pv.x || lvp.y !== pv.y || lvp.zoom !== pv.zoom) {
      useLiveViewportStore.getState().seedFrom(pv, project.viewportUpdatedAt);
    }
    lastViewportRef.current = { x: pv.x, y: pv.y, zoom: pv.zoom };
  }, [project]);

  // When physicsConfig changes (e.g. after slider drag or revertPhysicsSnapshot),
  // push the new values to the worker. Skip the first mount because init
  // already received the hydrated configuration.
  useEffect(() => {
    if (isFirstConfigRun.current) { isFirstConfigRun.current = false; return; }
    const phx = physicsRef.current;
    if (!phx) return;
    phx.setConfig({ ...DEFAULT_PHYSICS_CONFIG, ...(physicsConfig ?? {}) });
  }, [physicsConfig]);

  const isFirstConfigRun = useRef(true);

  // Smooth-pan the camera onto a node when generate.ts requests it after a
  // spawn. Each call to `requestPanTo` creates a fresh `{id}` object so the
  // effect's dep change fires even when the same id is requested twice.
  // Runs ease-out-cubic over PAN_DURATION_MS, pausing the temporal store so
  // the per-frame setViewport doesn't pollute undo history.
  const panTo = useGraphStore((s) => s.panTo);
  const requestPanTo = useGraphStore((s) => s.requestPanTo);
  const completePanTo = useGraphStore((s) => s.completePanTo);
  // Set by user input (wheel zoom, empty-canvas drag-pan). The pan/follow
  // animation loop checks this each frame and aborts if the user has taken
  // control of the camera.
  const userPannedRef = useRef(false);
  const initialRootGeneration = useRef<{ id: string; createdAt: number } | null>(null);
  useEffect(() => {
    if (!panTo) return;
    const container = containerRef.current;
    if (!container) { requestPanTo(null); return; }
    if (panTo.kind === 'node' && panTo.automatic === 'rootGeneration') {
      const node = useGraphStore.getState().project?.nodes[panTo.id];
      const version = node?.versions[node.generatingVersionIndex ?? node.currentVersionIndex];
      if (version) initialRootGeneration.current = { id: panTo.id, createdAt: version.createdAt };
    }
    userPannedRef.current = false;
    let raf: number | null = null;
    let startRaf: number | null = null;

    const PAN_DURATION_MS = 850;
    const FOLLOW_LERP = 0.12;
    // Use the same screen-space inset as the arrow-click visibility check.
    // Panel gaps remain world-space dimensions, matching their CSS layout.
    let phase: 'init' | 'animate' | 'follow' = 'init';
    let startV = { x: 0, y: 0, zoom: 1 };
    let startTime = 0;

    const posOf = (n: { id: string; position: { x: number; y: number } }) => {
      const lp = useLivePositionsStore.getState().positions[n.id];
      return { x: lp?.x ?? n.position.x, y: lp?.y ?? n.position.y };
    };

    const requestedNodes = () => {
      const project = useGraphStore.getState().project;
      if (!project) return [];
      const ids = panTo.kind === 'nodes'
        ? panTo.ids
        : [panTo.id, ...(panTo.includeId ? [panTo.includeId] : [])];
      return ids.flatMap((id) => project.nodes[id] ? [project.nodes[id]!] : []);
    };

    /** Camera target for one node, a pair, or a complete group. */
    const computeTarget = (): { x: number; y: number; zoom: number } | null => {
      const proj = useGraphStore.getState().project;
      if (!proj) return null;
      const nodes = requestedNodes();
      if (nodes.length === 0) return null;
      const v = useLiveViewportStore.getState();

      const first = nodes[0]!;
      const firstPosition = posOf(first);
      let wMinX = firstPosition.x;
      let wMinY = firstPosition.y;
      let wMaxX = firstPosition.x + nodeWidth(first);
      let wMaxY = firstPosition.y + nodeRenderedH(first);
      // Keep the node body horizontally centered, independent of side panels.
      // Vertically fit the real node + panel bounds below: centering the body
      // alone would mirror the bottom bar as unused space above the node.
      const center = panTo.kind === 'node' && (panTo.fit === 'centered' || panTo.automatic === 'rootGeneration')
        ? { x: (wMinX + wMaxX) / 2 }
        : undefined;
      for (const node of nodes.slice(1)) {
        const position = posOf(node);
        wMinX = Math.min(wMinX, position.x);
        wMinY = Math.min(wMinY, position.y);
        wMaxX = Math.max(wMaxX, position.x + nodeWidth(node));
        wMaxY = Math.max(wMaxY, position.y + nodeRenderedH(node));
      }

      // When the target node is the focused single selection, its floating
      // panels are showing (or about to): the side action panel to its left,
      // the follow-up bar below (text and still images), and whichever mutually
      // exclusive review panel is open on its right. Grow the bbox so the fit
      // frames them too. offsetHeight/offsetWidth = layout px = world px; the
      // fallbacks inside extendBBoxForPanels cover the pre-mount frames —
      // this runs every tick, so real measurements take over once mounted.
      const sel = proj.selection;
      const panelTarget = sel.length === 1 && nodes.some((candidate) => candidate.id === sel[0])
        ? proj.nodes[sel[0]!]
        : undefined;
      if (panelTarget) {
        const node = panelTarget;
        const position = posOf(node);
        const nH = nodeRenderedH(node);
        const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${node.id}"]`);
        const barEl = nodeEl?.querySelector<HTMLElement>('.node-followup-bar') ?? null;
        const panelEl = document.querySelector<HTMLElement>('.node-actions-panel');
        const rightPanelState = useCitationPanelStore.getState();
        const hasRightPanel = rightPanelState.mode != null && rightPanelState.nodeId === node.id;
        const rightPanelEl = hasRightPanel
          ? document.querySelector<HTMLElement>('[data-canvas-right-panel]')
          : null;
        const ext = extendBBoxForPanels(
          {
            minX: position.x,
            minY: position.y,
            maxX: position.x + nodeWidth(node),
            maxY: position.y + nH,
          },
          {
            hasSidePanel: true,
            hasFollowUpBar: currentContentType(node) !== 'media'
              || isStillImageMedia(node.versions[node.currentVersionIndex]?.media),
            panelW: PANEL_W,
            panelGap: PANEL_GAP,
            panelH: panelEl?.offsetHeight ?? null,
            barH: barEl?.offsetHeight ?? null,
            barGap: NODE_BOTTOM_PANEL_GAP,
            nodeH: nH,
            hasRightPanel,
            rightPanelW: rightPanelEl?.offsetWidth
              ?? rightPanelFallbackWidth(rightPanelState.mode),
            rightPanelGap: PANEL_GAP,
          },
        );
        wMinX = Math.min(wMinX, ext.minX);
        wMinY = Math.min(wMinY, ext.minY);
        wMaxX = Math.max(wMaxX, ext.maxX);
        wMaxY = Math.max(wMaxY, ext.maxY);
      }

      const cw = container.clientWidth;
      const ch = container.clientHeight;
      // Reserve the Sidebar's strip on the LEFT when it's open, so the fit
      // never frames a node underneath it. It's fixed screen-space chrome, so
      // the inset is constant px (NOT scaled by zoom). A transient hover-peek
      // is intentionally ignored so it can't jolt the camera.
      return fitBBoxInViewport(
        { minX: wMinX, minY: wMinY, maxX: wMaxX, maxY: wMaxY },
        v,
        {
          canvasWidth: cw,
          canvasHeight: ch,
          leftInset: sidebarCollapsedRef.current ? 0 : SIDEBAR_WIDTH,
          margin: FIT_MARGIN_PX,
          minZoom: MIN_CAMERA_ZOOM,
          axis: panTo.kind === 'node' ? panTo.axis : undefined,
          center,
          // Explicit node/group fits may zoom in as well as out.
          // Ordinary node navigation keeps the established zoom-out-only
          // behavior by omitting this ceiling override.
          ...(panTo.kind === 'nodes' || center ? { maxZoom: panTo.automatic === 'rootGeneration' ? Math.min(1, v.zoom) : 1 } : {}),
        },
      );
    };

    // Successful settle paths publish an arrival acknowledgement. Scene state
    // uses that event to start a chip-sourced ripple only once the target is
    // visible; cancellation paths intentionally publish no arrival.

    const tick = (now: number) => {
      // React may not have run the previous effect's cleanup yet when a new
      // request is published. Never let that stale rAF move the viewport or
      // complete/cancel the newer request.
      if (useGraphStore.getState().panTo?.requestId !== panTo.requestId) return;
      if (userPannedRef.current) { requestPanTo(null); return; }
      const autoPan = useSettingsStore.getState().cameraAutoPan;
      const followEnabled = panTo.automatic === 'rootGeneration' ? autoPan.rootGeneration : autoPan.generation;
      if ((panTo.automatic && !autoPan[panTo.automatic]) || (phase === 'follow' && !followEnabled)) {
        const live = useLiveViewportStore.getState();
        setViewport({ x: live.x, y: live.y, zoom: live.zoom });
        requestPanTo(null);
        return;
      }
      const nodes = requestedNodes();
      if (nodes.length === 0) { requestPanTo(null); return; }
      const anyGenerating = nodes.some((node) => node.generating);
      // A header click can issue an ordinary focus request after cancelling
      // initial-root following. Fit once, but do not restart that follow loop.
      // New versions (regeneration) retain the ordinary generation preference.
      const followableGeneration = nodes.some(node => node.generating && (panTo.automatic === 'rootGeneration'
        || initialRootGeneration.current?.id !== node.id
        || initialRootGeneration.current.createdAt !== node.versions[node.generatingVersionIndex ?? node.currentVersionIndex]?.createdAt));
      const shouldFollow = followEnabled && followableGeneration && !(panTo.kind === 'node' && panTo.axis === 'x');
      const target = computeTarget();
      if (!target) { requestPanTo(null); return; }
      // PERF R4: read CURRENT viewport from the live store. project's
      // viewport may be behind by the duration of this tween (which
      // commits to project only on completion).
      const v = useLiveViewportStore.getState();

      if (phase === 'init') {
        startV = { ...v };
        startTime = now;
        // Fast-path: with the minimum-pan target math, MOST clicks
        // land on a node that's already in frame → target equals
        // current viewport → animating produces no visual change.
        // Skip directly to follow (for streaming nodes) or done.
        const dxStart = target.x - startV.x;
        const dyStart = target.y - startV.y;
        const dzStart = target.zoom - startV.zoom;
        const atTarget = Math.abs(dxStart) < 0.5
          && Math.abs(dyStart) < 0.5
          && Math.abs(dzStart) < 0.001;
        if (atTarget) {
          if (shouldFollow) {
            phase = 'follow';
            raf = requestAnimationFrame(tick);
          } else {
            completePanTo(panTo.requestId);
            raf = null;
          }
          return;
        }
        phase = 'animate';
      }

      if (phase === 'animate') {
        const t = Math.min(1, (now - startTime) / PAN_DURATION_MS);
        // Quintic ease-in-out — markedly slower at start and end than the
        // previous cubic; the camera "drifts in" and "settles" smoothly.
        const eased = t < 0.5
          ? 16 * t * t * t * t * t
          : 1 - Math.pow(-2 * t + 2, 5) / 2;
        const nextX = startV.x + (target.x - startV.x) * eased;
        const nextY = startV.y + (target.y - startV.y) * eased;
        // Lerp zoom alongside x/y so the target world-point travels in
        // a straight screen-space line (the cross-terms cancel — see
        // the consistency proof in the change summary). startV.zoom is
        // captured ONCE at phase start; we don't re-anchor to current
        // mid-animation so easing stays smooth.
        const nextZoom = startV.zoom + (target.zoom - startV.zoom) * eased;
        // PERF R4: tween writes go to live store only — no project
        // mutation per frame. We commit once at completion below.
        useLiveViewportStore.getState().setViewport({ x: nextX, y: nextY, zoom: nextZoom });
        if (t < 1) {
          raf = requestAnimationFrame(tick);
        } else if (shouldFollow) {
          // Initial pan complete; node is still streaming. Switch to a
          // gentle follow loop that keeps the growing node centered.
          phase = 'follow';
          raf = requestAnimationFrame(tick);
        } else {
          // Tween done — commit live → project so autosave captures it.
          useGraphStore.temporal.getState().pause();
          try {
            setViewport({ x: nextX, y: nextY, zoom: nextZoom });
          } finally {
            useGraphStore.temporal.getState().resume();
          }
          raf = null;
          completePanTo(panTo.requestId);
        }
        return;
      }

      // phase === 'follow' — lerp toward the (moving) target each frame.
      // Recompute target each frame too: as the child streams in, its
      // renderedHeight grows, the bbox grows, and the fit-zoom shrinks
      // monotonically (we only ever clamp downward). The camera pulls
      // back as needed; never zooms back in.
      const dx = target.x - v.x;
      const dy = target.y - v.y;
      const dz = target.zoom - v.zoom;
      const close = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.001;
      if (close && !anyGenerating) {
        // Follow loop is winding down — commit final live → project.
        useGraphStore.temporal.getState().pause();
        try {
          setViewport({ x: v.x, y: v.y, zoom: v.zoom });
        } finally {
          useGraphStore.temporal.getState().resume();
        }
        completePanTo(panTo.requestId);
        raf = null;
        return;
      }
      // PERF R4: follow-loop writes go to live only.
      useLiveViewportStore.getState().setViewport({
        x: v.x + dx * FOLLOW_LERP,
        y: v.y + dy * FOLLOW_LERP,
        zoom: v.zoom + dz * FOLLOW_LERP,
      });
      raf = requestAnimationFrame(tick);
    };

    // Defer one frame so a freshly-spawned node has a chance to mount
    // and ResizeObserver can publish its real `renderedHeight` before
    // the first target is computed.
    startRaf = requestAnimationFrame(() => {
      startRaf = null;
      raf = requestAnimationFrame(tick);
    });
    return () => {
      if (startRaf !== null) cancelAnimationFrame(startRaf);
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [completePanTo, panTo, requestPanTo, setViewport]);

  // Pointer drag on EMPTY canvas pans the viewport. We track the start to
  // distinguish a tap (deselect) from a drag (pan). Shift+drag is owned by
  // the multi-selection capture handlers, before nodes can start dragging.
  const dragRef = useRef<{
    x: number; y: number;            // pointer-down clientX/Y
    vx: number; vy: number;          // viewport at down-time
    onEmpty: boolean;                // a tap on the background clears selection
    moved: boolean;                  // crossed the click→drag threshold
  } | null>(null);
  const labelPressRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    target: AsciiLabelTarget;
    moved: boolean;
  } | null>(null);
  const PAN_TAP_THRESHOLD_PX = 4;
  // Render-time flag for the .panning CSS class (closed-hand cursor while
  // dragging the empty canvas).
  const [panning, setPanning] = useState(false);
  const [asciiLabelHovered, setAsciiLabelHovered] = useState(false);

  // Ctrl/⌘+wheel "force scroll": a native, non-passive listener so it can
  // preventDefault the browser's page-zoom (React's onWheel is passive and
  // can't). It zooms regardless of what's under the cursor — including the
  // focused node whose body would otherwise step through its bullets.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onForceZoom = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Pinch / modifier-wheel always belongs to the camera, including over
      // chat and table scrollports. Ordinary wheel input still scrolls them.
      e.preventDefault();
      userPannedRef.current = true;
      const viewport = useLiveViewportStore.getState();
      const effectiveDeltaY = pinchZoomDelta({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      });
      const next = wheelZoomTarget(
        viewport,
        e.clientX, e.clientY, effectiveDeltaY,
        el.getBoundingClientRect(),
      );
      if (!next) return;
      useLiveViewportStore.getState().setViewport(next);
      scheduleWheelZoomCommit();
    };
    el.addEventListener('wheel', onForceZoom, { passive: false });
    return () => el.removeEventListener('wheel', onForceZoom);
  }, [scheduleWheelZoomCommit]);

  if (!project) return null;

  const onWheel = (e: React.WheelEvent) => {
    // Ctrl/⌘+wheel = "force scroll": always zoom, even over the focused node.
    // Owned by a native non-passive listener (see the effect above) so it can
    // also cancel the browser's own page-zoom — skip it here to avoid zooming
    // twice.
    if (e.ctrlKey || e.metaKey) return;
    // Zoom over empty canvas AND over any unselected node — the user
    // expects scroll-to-zoom regardless of where the cursor is hovering,
    // *unless* they're hovering over the currently-selected node (whose
    // body may need to scroll its own content / accept text-edit input).
    // The toolbar etc. live outside this canvas-host's DOM subtree, so
    // they never reach this handler at all.
    const tgt = e.target as Element | null;
    // Scrollports remain usable without focusing their node. Over those, the
    // selected node's body or either floating panel, ordinary wheel input
    // belongs to that UI rather than the canvas camera.
    if (tgt?.closest('.chat-scroll, .interactive-build, .node.selected, .side-panel, .citations-panel')) return;
    // User took camera control — cancel any active pan/follow loop.
    userPannedRef.current = true;
    e.preventDefault();
    // PERF R4: read CURRENT viewport from the live store (project may
    // be behind by the duration of an active pan that hasn't committed).
    const next = wheelZoomTarget(
      useLiveViewportStore.getState(),
      e.clientX, e.clientY, e.deltaY,
      containerRef.current?.getBoundingClientRect(),
    );
    if (!next) return;
    // Write live for immediate paint, then debounce the persisted project
    // viewport. A wheel gesture can deliver many events; committing each one
    // wakes every project subscriber even though only the camera changed.
    useLiveViewportStore.getState().setViewport(next);
    scheduleWheelZoomCommit();
  };
  const asciiLabelTargetAt = (clientX: number, clientY: number): AsciiLabelTarget | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const now = performance.now();
    const currentProject = useGraphStore.getState().project;
    const targetEntry = hitTestArrowLabelEntry(
      Object.fromEntries(Object.entries(useArrowLabelStore.getState().entries)
        .filter(([id]) => !currentProject?.arrows[id]
          || isArrowVisible(currentProject.arrows[id]!, currentProject.selection))),
      x,
      y,
      now,
    );
    const targetNodeId = targetEntry?.targetNodeId;
    const groupTarget = hitTestGroupLabels(
      useGroupLabelStore.getState().entries,
      x,
      y,
      now,
    );

    // During the type-on/delete crossover, the label type intended for the
    // current zoom wins an overlap. A lone outgoing label stays clickable
    // until its final glyph disappears, matching arrow-label behavior.
    if (groupLabelMode(useLiveViewportStore.getState().zoom) === 'group') {
      if (groupTarget) return groupTarget;
      if (targetNodeId) return { kind: 'node', nodeId: targetNodeId, arrowId: targetEntry?.arrowId };
    } else {
      if (targetNodeId) return { kind: 'node', nodeId: targetNodeId, arrowId: targetEntry?.arrowId };
      if (groupTarget) return groupTarget;
    }
    return null;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 0) {
      const target = asciiLabelTargetAt(e.clientX, e.clientY);
      if (target) {
        labelPressRef.current = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          target,
          moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const onEmpty = e.target === e.currentTarget;
    if (!onEmpty || e.button !== 0) return; // nodes/handles own their pointers
    // PERF R4: capture viewport from the live store (the runtime source
    // of truth). project.viewport may be stale here if a panTo tween or
    // a previous edge-pan hasn't committed yet.
    const lv = useLiveViewportStore.getState();
    dragRef.current = { x: e.clientX, y: e.clientY, vx: lv.x, vy: lv.y, onEmpty, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const labelPress = labelPressRef.current;
    if (labelPress && labelPress.pointerId === e.pointerId) {
      const dx = e.clientX - labelPress.x;
      const dy = e.clientY - labelPress.y;
      if (Math.abs(dx) >= PAN_TAP_THRESHOLD_PX || Math.abs(dy) >= PAN_TAP_THRESHOLD_PX) {
        labelPress.moved = true;
        setAsciiLabelHovered(false);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const d = dragRef.current;
    if (!d) {
      setAsciiLabelHovered(!!asciiLabelTargetAt(e.clientX, e.clientY));
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) < PAN_TAP_THRESHOLD_PX && Math.abs(dy) < PAN_TAP_THRESHOLD_PX) return;
    if (!d.moved) {
      setPanning(true);
      // User started a manual pan — cancel any active pan/follow loop.
      userPannedRef.current = true;
    }
    d.moved = true;
    // PERF R4: write to the live viewport store (not project) so the
    // Canvas subscriber doesn't fire on every pointermove. Pan-end
    // (onPointerUp) commits the final value back to project.
    useLiveViewportStore.getState().setPan(d.vx + dx, d.vy + dy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const labelPress = labelPressRef.current;
    if (labelPress && labelPress.pointerId === e.pointerId) {
      labelPressRef.current = null;
      setAsciiLabelHovered(!!asciiLabelTargetAt(e.clientX, e.clientY));
      if (!labelPress.moved) {
        if (labelPress.target.kind === 'node') {
          if (e.ctrlKey || e.metaKey) {
            toggleNodeSelection(labelPress.target.nodeId);
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          const arrow = labelPress.target.arrowId
            ? useGraphStore.getState().project?.arrows[labelPress.target.arrowId] : undefined;
          if (arrow) revealRelationSource(arrow);
          setSelection([labelPress.target.nodeId]);
          useGraphStore.getState().requestPanTo(labelPress.target.nodeId);
        } else if (labelPress.target.kind === 'group') {
          const store = useGraphStore.getState();
          const currentProject = store.project;
          const groupId = labelPress.target.groupId;
          if (currentProject?.groups[groupId]) {
            const memberIds = Object.values(currentProject.nodes)
              .filter((node) => node.groupId === groupId)
              .map((node) => node.id);
            // This is intentionally the same pair of actions as a group-row
            // click: selectGroup also remembers the collapsed-preview group.
            store.selectGroup(groupId);
            store.requestFitNodes(memberIds, 'groups');
          }
        } else {
          const store = useGraphStore.getState();
          const currentProject = store.project;
          if (currentProject) {
            const memberIds = Object.values(currentProject.nodes)
              .filter((node) => !node.groupId)
              .map((node) => node.id);
            store.setSelection([]);
            store.selectGroup(null);
            store.requestFitNodes(memberIds, 'groups');
          }
        }
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    setPanning(false);
    if (!d) return;
    // PERF R4: commit the final live viewport to project for autosave.
    // Semantic history ignores it. Skipped if no
    // movement occurred (a tap, not a drag).
    if (d.moved) {
      const lv = useLiveViewportStore.getState();
      setViewport({ x: lv.x, y: lv.y, zoom: lv.zoom });
    }
    // No drag movement on empty canvas → treat as a click. Deselect
    // any selected node AND any selected group so the empty canvas
    // is the universal "back out" gesture (C.5). Also clears the search
    // query (a click — not a drag/pan — dismisses search + its highlights).
    if (!d.moved && d.onEmpty) {
      setSelection([]);
      selectGroup(null);
      useGraphStore.getState().setSearchQuery('');
    }
  };
  const onPointerCancel = (e: React.PointerEvent) => {
    if (labelPressRef.current?.pointerId === e.pointerId) {
      labelPressRef.current = null;
      setAsciiLabelHovered(false);
    }
  };

  const selected = new Set(project.selection);
  const stopInitialRootFollow = () => {
    if (useGraphStore.getState().panTo?.automatic !== 'rootGeneration') return;
    const live = useLiveViewportStore.getState();
    setViewport({ x: live.x, y: live.y, zoom: live.zoom });
    userPannedRef.current = true;
    requestPanTo(null);
  };

  return (
    <div
      ref={containerRef}
      className={'canvas-host' + (panning ? ' panning' : '') + (asciiLabelHovered ? ' ascii-label-hover' : '')}
      data-node-multiselect={batchSelected ? '' : undefined}
      style={{
        '--node-selection-sidebar-inset': props.sidebarCollapsed && !props.sidebarPeeking ? '0px' : '240px',
      } as React.CSSProperties}
      {...multiSelection.handlers}
      onPointerDownCapture={event => { stopInitialRootFollow(); multiSelection.handlers.onPointerDownCapture(event); }}
      onWheelCapture={stopInitialRootFollow}
      onKeyDownCapture={stopInitialRootFollow}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => { if (!labelPressRef.current) setAsciiLabelHovered(false); }}
      onWheel={onWheel}
    >
      <NodeOverviewController containerRef={containerRef} />
      <CanvasToolbar
        containerRef={containerRef}
        sidebarCollapsed={props.sidebarCollapsed}
        peeking={props.sidebarPeeking}
        onOpenSettings={props.onOpenSettings}
      />
      {/* Scatter ASCII aura layer — OUTSIDE the world transform.
          Canvas has no parent transform of its own to re-composite on
          pan/zoom, which is the main perf win for screen-locked mode. */}
      {!props.suppressAuraLayer && <AsciiAuraLayer containerRef={containerRef} />}
      {/* Highlights the search phrase inside node cards (CSS Highlight API) */}
      <SearchHighlighter containerRef={containerRef} />
      {/* Exit watcher for the arrow-key reading ruler (also CSS Highlight API) */}
      <ReadingHighlighter />
      {/* Floating Copy / Check / Explain bar above a text selection. */}
      <SelectionToolbar />
      <NodeSelectionToolbar />
      {/* One screen-space opening-paragraph preview shared by every explored
          term and selected-text relation on the canvas. */}
      <RelationHoverPreview containerRef={containerRef} />
      <CameraTransform>
        {/* Canvas-tracked pixel ruler — pans/zooms with everything.
            Renders only when pixelRulerMode === 'canvas'. */}
        <PixelRuler attachment="canvas" />
        <ArrowLayer project={project} />
        {projectNodes
          .slice(0, props.progressiveStartup ? startupNodeLimit : projectNodes.length)
          .map((n) => (
          <NodeView
            key={n.id}
            node={n}
            selected={selected.has(n.id)}
            multiSelected={batchSelected && selected.has(n.id)}
            onSelect={() => {
              const graph = useGraphStore.getState();
              if (isBatchNodeSelection(graph.project?.selection, graph.selectedGroupId)
                && graph.project?.selection.includes(n.id)) return;
              setSelection([n.id]);
              // Bringing a node into focus pans the camera to it.
              useGraphStore.getState().requestPanTo(n.id, undefined, 'focus');
              // Clicking a child node records the relation back to its parent
              // (drives the on-arrival aura ripple + term context) but is tagged
              // source:'node' so it does NOT light up the connecting arrow — the
              // arrow only flashes from a chip click (you're already at the node
              // here). Skipped for the root / nodes with no labelled incoming arrow.
              const proj = useGraphStore.getState().project;
              if (!proj) return;
              const incoming = Object.values(proj.arrows).find(
                (a) => a.kind === 'auto'
                  && a.toNodeId === n.id
                  && (!!a.label || !!a.sourceSelection),
              );
              if (incoming) {
                revealRelationSource(incoming);
                useGraphStore.getState().flashHighlight({
                  parentNodeId: incoming.fromNodeId,
                  childNodeId: n.id,
                  arrowId: incoming.id,
                  ...(incoming.label ? { term: incoming.label } : {}),
                  source: 'node',
                });
              }
            }}
            onReferenceClick={(term, opts) => props.onReferenceClick(n.id, term, opts)}
            onRetry={n.generationError && hasImageRetryArgs(n.id)
              ? () => { void retryImageGeneration(n.id); }
              : n.generationError && hasRetryArgs(n.id)
                ? () => { void retryGeneration(n.id); }
                : undefined}
            imageGenerationAvailable={imageGenerationAvailable}
            retryDisabled={!!n.generationError && hasImageRetryArgs(n.id) && !imageGenerationAvailable}
            onDragStart={(x, y, kind) => {
              physicsRef.current?.dragStart(n.id, x, y);
              dragKindRef.current = kind;
              // A resize means NodeView owns this node's live position — tell
              // the physics tick to stop echoing a competing one for it.
              resizingNodeIdRef.current = kind === 'resize' ? n.id : null;
              dragPanAccumRef.current = { x: 0, y: 0 };
              dragPrevPosRef.current = null;
              // Dragging a node is an explicit camera-control gesture
              // from the user's perspective — abort any active pan/follow
              // loop so the camera stops chasing the node the user is
              // now positioning by hand.
              userPannedRef.current = true;

              // Groups and manual selections share the same drag path.
              // Resizing stays single-node.
              groupDragRef.current = null;
              if (kind === 'drag') {
                const proj = useGraphStore.getState().project;
                const selectedIds = proj && proj.selection.length > 1 && proj.selection.includes(n.id)
                  ? new Set(proj.selection) : null;
                if (proj && selectedIds) {
                  const live = useLivePositionsStore.getState().positions;
                  const draggedX = live[n.id]?.x ?? proj.nodes[n.id]!.position.x;
                  const draggedY = live[n.id]?.y ?? proj.nodes[n.id]!.position.y;
                  const memberIds: string[] = [];
                  const offsets = new Map<string, { x: number; y: number }>();
                  for (const m of Object.values(proj.nodes)) {
                    if (!selectedIds.has(m.id)) continue;
                    const mx = live[m.id]?.x ?? m.position.x;
                    const my = live[m.id]?.y ?? m.position.y;
                    memberIds.push(m.id);
                    offsets.set(m.id, { x: mx - draggedX, y: my - draggedY });
                    if (m.id !== n.id) {
                      physicsRef.current?.dragStart(m.id, mx, my);
                    }
                  }
                  if (memberIds.length > 1) {
                    groupDragRef.current = { memberIds, offsets };
                  } else {
                    // Group of 1 (only the dragged node belongs to it) —
                    // no point fanning out; fall through to single path.
                    groupDragRef.current = null;
                  }
                }
              }

              // Auto-pin-on-drag-away: remember every direct automatic-arrow
              // relative and its starting distance — but only for an eligible
              // single-node header drag (not a resize, not a group fan-out).
              dragAwayRef.current = null;
              useDragArmStore.getState().setArmed(null);
              useDragHintStore.setState({ hint: null });
              if (kind === 'drag' && !groupDragRef.current) {
                const proj = useGraphStore.getState().project;
                if (proj) {
                  const live = useLivePositionsStore.getState().positions;
                  const dragged = proj.nodes[n.id];
                  const relatives = directAutoRelativeIds(n.id, Object.values(proj.arrows))
                    .flatMap((nodeId) => {
                      const relative = proj.nodes[nodeId];
                      return dragged && relative
                        ? [{ nodeId, distStart: relativeDistance(dragged, relative, live) }]
                        : [];
                    });
                  if (relatives.length > 0) dragAwayRef.current = { relatives };
                }
              }
              if (kind === 'drag' && !groupDragRef.current) {
                const dragged = useGraphStore.getState().project?.nodes[n.id];
                if (dragged?.frozen) {
                  useDragHintStore.getState().show(n.id, 'SHAKE TO UNPIN');
                } else if (dragAwayRef.current) {
                  useDragHintStore.getState().show(n.id, 'DRAG AWAY TO PIN');
                }
              }
            }}
            onDragMove={(x, y, gesture) => {
              // PERF R4: read viewport from the live store (the single
              // source of truth at runtime). Pre-R4 this used vRef, which
              // we no longer maintain — Canvas doesn't re-render on pan.
              const v = useLiveViewportStore.getState();
              // NodeView computes (x, y) assuming the camera is still at its
              // drag-start position. If we've already panned the camera to
              // follow the node, subtract that accumulated pan so the node's
              // actual world position tracks the cursor's CURRENT world
              // position (which has shifted under it).
              const accum = dragPanAccumRef.current;
              let adjX = x - accum.x / v.zoom;
              let adjY = y - accum.y / v.zoom;

              // Which way the user is moving the node this frame. Measured from
              // the RAW (un-compensated) target so the camera's own follow-
              // motion can't pollute the direction signal. `null` prev (first
              // move of a drag) reads as "not moving" → no pan yet.
              const prev = dragPrevPosRef.current;
              const dxMove = prev ? x - prev.x : 0;
              const dyMove = prev ? y - prev.y : 0;
              dragPrevPosRef.current = { x, y };

              // Edge-pan applies only to header-drags. During resize we
              // don't want the camera to chase the resize handle.
              if (dragKindRef.current === 'drag' && useSettingsStore.getState().cameraAutoPan.dragEdges) {
                const container = containerRef.current;
                if (container) {
                  const cw = container.clientWidth;
                  const ch = container.clientHeight;
                  const nW = nodeWidth(n);
                  const screenLeft = adjX * v.zoom + v.x;
                  const screenTop = adjY * v.zoom + v.y;
                  const screenRight = screenLeft + nW * v.zoom;
                  // margin = how close to an edge before the camera follows;
                  // rate = pan per px of overshoot (gentle at the threshold,
                  // stronger past it). Only follows an edge the node is
                  // actually heading toward — see computeEdgePan.
                  const { panX, panY } = computeEdgePan({
                    screenLeft, screenRight, screenTop,
                    cw, ch, margin: 40, rate: 0.08, dxMove, dyMove,
                  });

                  if (panX !== 0 || panY !== 0) {
                    // PERF R4: edge-pan writes go to live only — it
                    // commits with the drag-end's setNodePositions flush.
                    useLiveViewportStore.getState().setPan(v.x + panX, v.y + panY);
                    accum.x += panX;
                    accum.y += panY;
                    // Compensate the target so the node stays under cursor
                    // after this pan (same math as above).
                    adjX -= panX / v.zoom;
                    adjY -= panY / v.zoom;
                  }
                }
              }

              // Single-node case (no group, or solo group): direct call.
              // Selection/group case: fan the same delta out to every member using
              // the offsets snapshotted at drag-start.
              const gd = groupDragRef.current;
              if (gd) {
                for (const memberId of gd.memberIds) {
                  const off = gd.offsets.get(memberId)!;
                  physicsRef.current?.dragMove(memberId, adjX + off.x, adjY + off.y);
                }
              } else {
                physicsRef.current?.dragMove(n.id, adjX, adjY);
              }

              // Live "armed to pin" indicator: while this drag is past the
              // auto-pin threshold (a release now would pin), light up the node's
              // pin button. Mirrors onDragEnd's decision exactly — same helper,
              // same live distance — so the indicator can't disagree with the
              // result. Already-frozen nodes don't arm (nothing to pin).
              const da = dragAwayRef.current;
              if (da) {
                const proj = useGraphStore.getState().project;
                const node = proj?.nodes[n.id];
                let excessPx = 0;
                if (proj && node && !node.frozen) {
                  const live = useLivePositionsStore.getState().positions;
                  const distances = da.relatives.flatMap(({ nodeId, distStart }) => {
                    const relative = proj.nodes[nodeId];
                    return relative
                      ? [{ distStart, distEnd: relativeDistance(node, relative, live) }]
                      : [];
                  });
                  excessPx = dragAwayExcessFromAny({
                    distances,
                    suppressed: gesture.unpinnedByShake,
                  });
                }
                useDragArmStore.getState().setArmed(
                  excessPx > 0 ? n.id : null,
                  pinArmStrength(excessPx),
                );
              }
            }}
            onDragEnd={(result) => {
              // PERF R2: commit live positions to `project` so autosave
              // captures the new resting positions. Semantic history ignores
              // movement. For a single-node drag we commit just the dragged
              // node; for a group drag we bulk-commit every member.
              const livePositions = useLivePositionsStore.getState().positions;
              const gd = groupDragRef.current;
              if (gd) {
                physicsRef.current?.dragEndMany(gd.memberIds);
                const updates: { id: string; x: number; y: number }[] = [];
                for (const memberId of gd.memberIds) {
                  const lp = livePositions[memberId];
                  if (lp) updates.push({ id: memberId, x: lp.x, y: lp.y });
                }
                if (updates.length > 0) {
                  useGraphStore.getState().setNodePositions(updates);
                }
              } else {
                physicsRef.current?.dragEnd(n.id);
                const live = livePositions[n.id];
                // Auto-pin-on-drag-away: if this node ended up far enough
                // farther from any direct parent/child than where the drag
                // began, pin it so physics stops pulling it back. Folded into
                // the same updateNode as the position. Semantic history
                // records only the pin-state change and preserves position.
                let pinFrozen = false;
                const da = dragAwayRef.current;
                if (da && !result?.unpinnedByShake) {
                  const proj = useGraphStore.getState().project;
                  const node = proj?.nodes[n.id];
                  if (proj && node) {
                    pinFrozen = shouldPinOnDragAwayFromAny({
                      distances: da.relatives.flatMap(({ nodeId, distStart }) => {
                        const relative = proj.nodes[nodeId];
                        return relative
                          ? [{ distStart, distEnd: relativeDistance(node, relative, livePositions) }]
                          : [];
                      }),
                      suppressed: !!result?.unpinnedByShake,
                    });
                  }
                }
                if (live || pinFrozen) {
                  const patch: Partial<ScatterNode> = {};
                  if (live) patch.position = { x: live.x, y: live.y };
                  if (pinFrozen) patch.frozen = true;
                  useGraphStore.getState().updateNode(n.id, patch);
                }
              }
              // PERF R4: if edge-panning ran during this drag, the live
              // viewport has the camera's final position but project does
              // not. Commit it here so autosave captures the camera motion.
              const accum = dragPanAccumRef.current;
              if (accum.x !== 0 || accum.y !== 0) {
                const lv = useLiveViewportStore.getState();
                useGraphStore.temporal.getState().pause();
                try {
                  setViewport({ x: lv.x, y: lv.y, zoom: lv.zoom });
                } finally {
                  useGraphStore.temporal.getState().resume();
                }
              }
              dragKindRef.current = null;
              // Resize over: let the worker's tick echo this node again so it
              // settles normally.
              resizingNodeIdRef.current = null;
              dragPanAccumRef.current = { x: 0, y: 0 };
              dragPrevPosRef.current = null;
              groupDragRef.current = null;
              dragAwayRef.current = null;
              useDragArmStore.getState().setArmed(null);
              useDragHintStore.getState().clear(n.id);
              // Schedule a deferred flush of ALL live positions into
              // `project` ~1500 ms later — enough time for physics to
              // settle (alpha 0.3 → alphaMin 0.005 takes ~30 ticks /
              // 0.5 s at default config, with a safety buffer). This
              // run is wrapped in temporal.pause() so it doesn't
              // pollute undo history (physics settle isn't user-
              // intent), but it still triggers autosave so saved files
              // capture the final positions.
              scheduleSettleFlush();
            }}
          />
          ))}
        {/* Floating action panel for the selected node — NOT a physics body. */}
        {!batchSelected && <NodeSidePanel />}
        {/* Web-search citations panel — right-side twin, opened per-node. */}
        <WikimediaDiscoveryCoordinator enabled={!props.progressiveStartup && !props.suppressAuraLayer} />
        {!batchSelected && <NodeCitationsPanel />}
      </CameraTransform>
    </div>
  );
}

/**
 * PERF R4: subscribes to the live viewport store and applies the world
 * transform style to a wrapper div. By isolating the viewport read
 * here, Canvas itself does not re-render on every pan tick — only this
 * tiny component does, and its children are passed by reference so
 * they do not reconcile either.
 *
 * The `transform-origin: 0 0` matches the pre-R4 inline style so
 * world-coordinate math stays identical.
 */
function CameraTransform({ children }: { children: React.ReactNode }) {
  const x = useLiveViewportStore((s) => s.x);
  const y = useLiveViewportStore((s) => s.y);
  const zoom = useLiveViewportStore((s) => s.zoom);
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})`, transformOrigin: '0 0' }}
    >
      {children}
    </div>
  );
}

// R5: BackgroundGrid deleted — it wrote backgroundSize/Position onto
// .canvas-host, which has no background-image (the ASCII aura layer
// replaced the CSS dot grid long ago; see globals.css). The styles
// were a no-op carried forward from pre-R4 inline JSX.
