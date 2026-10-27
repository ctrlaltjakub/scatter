/// <reference lib="webworker" />
import { forceSimulation, type Simulation } from 'd3-force';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';
import {
  rectCollide,
  arrowAvoid,
  pairwiseRepel,
  rectLink,
  velocityCap,
  edgeKey,
  type SimNode,
  type SimLink,
  type EdgeKey,
} from './forces';
import { VerletRopeSim, type RopeConfig, type RopeRealNode } from './verletRope';
import type { PhysicsConfig } from '@/store/types';
import type { SizeWake, NodeInsertion, LinkInsertion, PlacedNode } from './physicsClient';
import type { SourcePort } from './sourcePort';
import { localActivity, LAYOUT_ALPHA_MIN } from './localActivity';
import { findNodePlacement } from '@/lib/nodePlacement';

let cfg: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG };

// PERF #10: linked-edge membership lookup used to allocate a fresh
// string per pair (`edgeKey(a, b) = `${a}|${b}``) and hash it into a
// Set. At N=100 with two pairwiseRepel forces that's ~10k string
// allocations per tick. Bitset variant: assign each node a sequential
// index, pack edge membership into a Uint8Array indexed by ordered
// (i*N + j) with i<j. Hash → typed-array index. Zero per-call alloc.
//
// Both legacy and bitset paths are maintained for the rare cases
// where a string id appears that isn't in `nodeIdx` yet (during a
// rebuild transient between addNode and rebuild()'s nodes-array
// re-assignment). The fast path covers the common case.
let linkedEdges = new Set<EdgeKey>();
let nodeIdx: Map<string, number> = new Map();
let nodeCount = 0;
let linkedEdgesBitset: Uint8Array = new Uint8Array(0);
function rebuildLinkedEdges() {
  linkedEdges = new Set<EdgeKey>(
    links.filter(l => l.kind === 'auto').map(l => {
      const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
      const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
      return edgeKey(sId, tId);
    })
  );
  // Build / refresh the typed-array fast path.
  nodeIdx = new Map();
  nodeCount = nodes.length;
  for (let i = 0; i < nodes.length; i++) nodeIdx.set(nodes[i]!.id, i);
  linkedEdgesBitset = new Uint8Array(nodeCount * nodeCount);
  for (const l of links) {
    if (l.kind !== 'auto') continue;
    const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
    const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
    const i = nodeIdx.get(sId);
    const j = nodeIdx.get(tId);
    if (i == null || j == null) continue;
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    linkedEdgesBitset[lo * nodeCount + hi] = 1;
  }
}

/** PERF #10: O(1) bitset lookup used by both pairwiseRepel filters.
 *  Falls back to the legacy string-Set on a cache miss (covers the
 *  brief window between addNode and rebuild() refreshing nodeIdx). */
function isLinked(a: string, b: string): boolean {
  const i = nodeIdx.get(a);
  const j = nodeIdx.get(b);
  if (i == null || j == null) return linkedEdges.has(edgeKey(a, b));
  const lo = i < j ? i : j;
  const hi = i < j ? j : i;
  return linkedEdgesBitset[lo * nodeCount + hi] === 1;
}

/* -------------------------------------------------------------------------
 * Verlet rope state.
 *
 * Anchors are NOT d3-force sim nodes any more. They live entirely inside
 * `verletRope` and get integrated in the tick callback after d3 has updated
 * real-node positions. This keeps d3's solver focused on graph layout and
 * lets the rope use a stiff, position-based constraint solver for
 * rubber-band feel + hard collision.
 *
 * `draggingIds` tracks nodes currently under the user's pointer. The Verlet
 * rope treats them as invisible (no soft repel, no hard collision, no
 * segment-rect block) so arrows don't tangle around a moving body. A node
 * being frozen via the toolbar does NOT count as dragging — frozen nodes
 * stay as obstacles.
 * -------------------------------------------------------------------------*/
const verletRope = new VerletRopeSim();
const draggingIds = new Set<string>();

function ropeConfigFromPhysics(c: PhysicsConfig): RopeConfig {
  return {
    maxSegmentLength: c.ropeMaxSegmentLength,
    maxAnchorCount: c.ropeMaxAnchorCount,
    margin: c.ropeMargin,
    arrowRepelStrength: c.arrowRepelStrength,
    arrowRepelRange: c.arrowRepelRange,
    exemptDraggedNodes: c.ropeExemptDraggedNodes >= 0.5,
  };
}

function realNode(id: string): SimNode | undefined {
  return nodes.find(n => n.id === id);
}

function realRect(id: string): RopeRealNode | null {
  const n = realNode(id);
  if (!n || n.x == null || n.y == null) return null;
  return {
    id: n.id,
    x: n.x,
    y: n.y,
    width: n.width ?? 624,
    height: n.height ?? 120,
  };
}

/** Build a Map<id, RopeRealNode> snapshot for the Verlet rope sim. */
function buildRealsMap(): Map<string, RopeRealNode> {
  const m = new Map<string, RopeRealNode>();
  for (const n of nodes) {
    if (n.x == null || n.y == null) continue;
    m.set(n.id, {
      id: n.id,
      x: n.x,
      y: n.y,
      width: n.width ?? 624,
      height: n.height ?? 120,
      dragging: draggingIds.has(n.id),
    });
  }
  return m;
}

/** Add a chain for an arrow whose endpoints are both real nodes. */
function ensureRopeChainFor(
  sourceId: string,
  targetId: string,
  arrowId: string,
  initialAnchors?: { x: number; y: number }[],
) {
  const srcRect = realRect(sourceId);
  const tgtRect = realRect(targetId);
  if (!srcRect || !tgtRect) return;
  verletRope.ensureChain(
    { arrowId, sourceId, targetId },
    srcRect,
    tgtRect,
    0,
    cfg.ropeMaxSegmentLength,
    cfg.ropeMaxAnchorCount,
    initialAnchors,
  );
}

/**
 * Push a rect out of every POSITION-FIXED node's rectCollide floor along the
 * axis of least overlap (a few passes, so cascaded overlaps settle).
 * Obstacles are inflated by the full rectCollide floor (2 × collidePadding —
 * the force pads BOTH rects) so the nudged node lands at the exact resting
 * gap and rectCollide has nothing left to resolve.
 *
 * Dragging itself is EXEMPT from collision walls: the dragged node follows
 * the cursor exactly, gliding over pinned nodes (it paints on top via
 * NodeView's .dragging z-index; the old clampDragAgainstChain walls were
 * removed on user request). This resolver runs only when a node stops being
 * cursor-driven yet stays position-fixed — released while pinned, or freshly
 * pinned while overlapping — because two fixed rects could never separate on
 * their own. Unpinned releases need nothing: rectCollide slides them out
 * over the next few ticks.
 */
function resolveOverlapWithPinned(self: SimNode, startX: number, startY: number, ignore?: ReadonlySet<string>): { x: number; y: number } {
  const myW = self.width ?? 624;
  const myH = self.height ?? 120;
  const pad = cfg.collidePadding * 2;
  let tx = startX;
  let ty = startY;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const myLeft = tx;
    const myRight = tx + myW;
    const myTop = ty;
    const myBottom = ty + myH;
    for (const other of nodes) {
      if (other.id === self.id || ignore?.has(other.id)) continue;
      if (other.x == null || other.y == null) continue;
      if (other.fx == null || other.fy == null) continue;
      const oW = other.width ?? 624;
      const oH = other.height ?? 120;
      const oLeft = other.x - pad;
      const oRight = other.x + oW + pad;
      const oTop = other.y - pad;
      const oBottom = other.y + oH + pad;
      const overlapX = Math.min(myRight, oRight) - Math.max(myLeft, oLeft);
      const overlapY = Math.min(myBottom, oBottom) - Math.max(myTop, oTop);
      if (overlapX > 0 && overlapY > 0) {
        const myCx = (myLeft + myRight) / 2;
        const myCy = (myTop + myBottom) / 2;
        const oCx = (oLeft + oRight) / 2;
        const oCy = (oTop + oBottom) / 2;
        if (overlapX < overlapY) {
          tx += (myCx >= oCx ? 1 : -1) * overlapX;
        } else {
          ty += (myCy >= oCy ? 1 : -1) * overlapY;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  return { x: tx, y: ty };
}

type LinkInit = {
  source: string;
  target: string;
  kind: 'auto' | 'dotted';
  gravitates: boolean;
  arrowId: string;
  /** Optional persisted chain positions to seed the rope at last-saved shape. */
  anchors?: { x: number; y: number }[];
};

type InMsg =
  | { type: 'add-graph'; nodes: NodeInsertion[]; links: LinkInsertion[] }
  | { type: 'set-arrow-sources'; sources: { arrowId: string; sourcePort?: SourcePort }[] }
  | { type: 'init'; nodes: { id: string; x: number; y: number; frozen: boolean }[]; links: LinkInit[]; config?: PhysicsConfig }
  | { type: 'set-frozen'; id: string; frozen: boolean }
  | { type: 'set-size'; id: string; width: number; height: number; wake?: SizeWake }
  | { type: 'drag-start'; id: string; x: number; y: number }
  | { type: 'drag-move'; id: string; x: number; y: number }
  | { type: 'drag-end'; id: string }
  | { type: 'drag-end-many'; ids: string[] }
  | { type: 'arrow-drag-start'; arrowId: string; x: number; y: number }
  | { type: 'arrow-drag-move'; arrowId: string; x: number; y: number }
  | { type: 'arrow-drag-end'; arrowId: string }
  | { type: 'add-node'; node: { id: string; x: number; y: number; frozen: boolean } }
  | { type: 'add-link'; link: LinkInit }
  | { type: 'remove-links'; ids: string[] }
  | { type: 'remove-nodes'; ids: string[] }
  | { type: 'set-physics-config'; config: PhysicsConfig }
  | { type: 'pause' } | { type: 'resume' };

type OutMsg = {
  type: 'tick';
  nodes: { id: string; x: number; y: number }[];
  /** Per-arrow chain in order from source-port end to target-port end. */
  arrowAnchors: Record<string /* arrowId */, { x: number; y: number }[]>;
  /** Chains removed since the previous message. */
  removedArrowIds?: string[];
  placedNodes?: PlacedNode[];
};

let nodes: SimNode[] = [];
let links: SimLink[] = [];
let sim: Simulation<SimNode, SimLink> | null = null;

/**
 * R6.5 — post-load friction ramp (the reload "nudge" damper).
 *
 * On reload the app reconciles against the just-loaded state — it
 * pushes the user's saved physics config (which hydrates from disk a
 * moment after mount), re-measures node heights, syncs frozen flags —
 * and any of those wakes the simulation. The saved positions are
 * already the settled layout, so that wake drifts them: the "nudge"
 * (worse for nodes far from their parent, stretched link spring).
 *
 * Rather than block the wake, we briefly CRANK UP friction so the
 * woken sim barely moves, then ease friction back to normal:
 *   - first 0.5 s of the wake: friction doubled (clamped < 1)
 *   - next 0.5 s: linearly eased from doubled back to the base value
 *   - after 1.0 s: base value
 *
 * The ramp is anchored to the MOMENT THE SIM FIRST WAKES after a load,
 * NOT to the load instant. The hydrated-config push that triggers the
 * nudge arrives ~1 s after load, so a load-anchored ramp would already
 * be fading when the jerk fires. Anchoring to the wake lands the
 * doubled friction exactly on it. Armed on init, fires once per load,
 * then disarms — later user wakes (drags) run at normal friction.
 */
let frictionArmed = false;
let frictionWakeMs: number | null = null;
/** A real wake (vs the trailing alpha≈0 tick after init's alpha(0)). */
const FRICTION_WAKE_ALPHA = 0.05;
const FRICTION_FULL_MS = 500;   // doubled friction for this long
const FRICTION_EASE_MS = 500;   // then eased back over this long
/** Cap — velocityDecay must stay < 1 (1 would freeze all motion). */
const FRICTION_MAX = 0.97;

/** velocityDecay to use `elapsedMs` into the wake, given the config
 *  base. Pure + exported for unit testing the ramp shape. */
export function loadFrictionDecay(elapsedMs: number, base: number): number {
  const doubled = Math.min(FRICTION_MAX, base * 2);
  if (elapsedMs < 0 || elapsedMs >= FRICTION_FULL_MS + FRICTION_EASE_MS) return base;
  if (elapsedMs < FRICTION_FULL_MS) return doubled;
  const t = (elapsedMs - FRICTION_FULL_MS) / FRICTION_EASE_MS; // 0→1
  return doubled + t * (base - doubled);
}

/** Outgoing tick messages flow through this hook. In a worker context the
 *  bottom of this file wires it to `self.postMessage`. The headless Node
 *  replay harness overrides it via `setEmit`. */
let emit: (msg: OutMsg) => void = () => { /* no-op until wired */ };
export function setEmit(fn: (msg: OutMsg) => void) { emit = fn; }

/**
 * Per-tick side effects shared between the d3-timer path and the headless
 * manual-step path. d3-force's `simulation.tick()` advances state but
 * does NOT dispatch the 'tick' event — only the internal timer does. So
 * for headless we step + invoke side effects explicitly.
 */
/** Last-emitted positions per node and per anchor. Used to skip emit
 *  when nothing visible has changed (settled scene) — drops main-thread
 *  work from 60 frames/sec to ~0 when idle, the dominant performance
 *  win for live use. */
const lastEmittedNode = new Map<string, { x: number; y: number }>();
const lastEmittedAnchors = new Map<string, { x: number; y: number }[]>();
const POS_EMIT_THRESHOLD = 0.25; // px — below this, skip the emit
/** Headless harness needs every tick emitted so per-tick stability
 *  metrics aren't inflated by skipped emits. Browser worker leaves
 *  this false. Set via setForceEmitEveryTick. */
let forceEmitEveryTick = false;
export function setForceEmitEveryTick(v: boolean): void { forceEmitEveryTick = v; }

function runTickSideEffects(placedNodes?: PlacedNode[]): void {
  // R6.5 — apply the post-load friction ramp, anchored to the wake.
  if (sim && frictionArmed) {
    const now = (typeof performance !== 'undefined' ? performance.now() : 0);
    if (frictionWakeMs === null) {
      // First real wake after this load starts the ramp clock.
      if (sim.alpha() > FRICTION_WAKE_ALPHA) frictionWakeMs = now;
    }
    if (frictionWakeMs !== null) {
      const elapsed = now - frictionWakeMs;
      if (elapsed < FRICTION_FULL_MS + FRICTION_EASE_MS) {
        sim.velocityDecay(loadFrictionDecay(elapsed, cfg.velocityDecay));
      } else {
        sim.velocityDecay(cfg.velocityDecay); // restore, then disarm
        frictionArmed = false;
        frictionWakeMs = null;
      }
    }
  }

  // Run the Verlet rope sim AFTER d3 has updated real-node positions.
  const reals = buildRealsMap();
  verletRope.tick(reals, ropeConfigFromPhysics(cfg));
  const realNodes: { id: string; x: number; y: number }[] = [];
  for (const n of nodes) realNodes.push({ id: n.id, x: n.x ?? 0, y: n.y ?? 0 });
  const arrowAnchors = verletRope.snapshot();

  if (forceEmitEveryTick) {
    emit({ type: 'tick', nodes: realNodes, arrowAnchors, placedNodes } as OutMsg);
    return;
  }

  // Build a DELTA rather than cloning and transferring the whole project on
  // every active tick. Canvas merges these changed records into its runtime
  // stores; the full snapshot path above remains available to diagnostics.
  const changedNodes: { id: string; x: number; y: number }[] = [];
  const placements = new Set(placedNodes?.map(n => n.id));
  for (const n of realNodes) {
    const last = lastEmittedNode.get(n.id);
    if (!last || placements.has(n.id) || Math.abs(n.x - last.x) > POS_EMIT_THRESHOLD || Math.abs(n.y - last.y) > POS_EMIT_THRESHOLD) {
      changedNodes.push(n);
    }
  }
  const changedAnchors: Record<string, { x: number; y: number }[]> = {};
  for (const [aid, anchors] of Object.entries(arrowAnchors)) {
    const last = lastEmittedAnchors.get(aid);
    let changed = !last || last.length !== anchors.length;
    if (!changed && last) {
      for (let i = 0; i < anchors.length; i++) {
        const la = last[i]!, ca = anchors[i]!;
        if (Math.abs(ca.x - la.x) > POS_EMIT_THRESHOLD || Math.abs(ca.y - la.y) > POS_EMIT_THRESHOLD) {
          changed = true;
          break;
        }
      }
    }
    if (changed) changedAnchors[aid] = anchors;
  }
  const removedArrowIds: string[] = [];
  for (const aid of lastEmittedAnchors.keys()) {
    if (!(aid in arrowAnchors)) removedArrowIds.push(aid);
  }
  if (changedNodes.length === 0
    && Object.keys(changedAnchors).length === 0
    && removedArrowIds.length === 0 && !placedNodes?.length) return;

  for (const n of changedNodes) lastEmittedNode.set(n.id, { x: n.x, y: n.y });
  for (const [aid, anchors] of Object.entries(changedAnchors)) {
    lastEmittedAnchors.set(aid, anchors.map((p) => ({ x: p.x, y: p.y })));
  }
  for (const aid of removedArrowIds) lastEmittedAnchors.delete(aid);
  emit({
    type: 'tick',
    nodes: changedNodes,
    arrowAnchors: changedAnchors,
    removedArrowIds: removedArrowIds.length > 0 ? removedArrowIds : undefined,
    ...(placedNodes?.length ? { placedNodes } : {}),
  } as OutMsg);
}

/** Step the simulation exactly once and run the tick handler. Used by the
 *  headless replay so we can step in simulated time instead of wall time. */
export function tickOnce(): void {
  if (!sim) return;
  sim.tick(1);
  runTickSideEffects();
}

/** Debug: read raw SimNode state (x, y, fx, fy, frozen). Used by headless
 *  diagnostics to verify pinning is being applied correctly. */
export function inspectNode(id: string): { x: number | null; y: number | null; fx: number | null | undefined; fy: number | null | undefined; frozen: boolean } | null {
  const n = nodes.find((nn) => nn.id === id);
  if (!n) return null;
  return { x: n.x ?? null, y: n.y ?? null, fx: n.fx, fy: n.fy, frozen: !!n.frozen };
}
/** Kill any d3-timer that's running so we can step manually without
 *  competing with auto-stepping. Safe to call repeatedly. */
export function stopAutoTimer(): void { sim?.stop(); }

/** Debug/test: current simulation alpha (0 when parked/asleep). */
export function getAlpha(): number { return sim?.alpha() ?? 0; }

/** Debug/test: current friction (velocityDecay) on the live sim. */
export function getVelocityDecay(): number { return sim?.velocityDecay() ?? 0; }

/** Test-only: end the post-load friction ramp immediately, restoring
 *  base friction (as the natural ramp end does). */
export function endLoadFrictionForTest(): void {
  if (sim) sim.velocityDecay(cfg.velocityDecay);
  frictionArmed = false;
  frictionWakeMs = null;
}

/** Keep the timer alive without reheating unrelated layout forces. */
function scheduleTicks(alpha: number) {
  sim?.alpha(Math.max(sim.alpha(), alpha)).restart();
}

function wakeNodes(ids: Iterable<string>, alpha: number) {
  for (const id of ids) {
    const n = realNode(id);
    if (n) n.layoutAlpha = Math.max(n.layoutAlpha ?? 0, alpha);
  }
  scheduleTicks(alpha);
}

function rebuild(alpha: number | null = 1) {
  const previousDecay = sim?.velocityDecay();
  if (sim) sim.stop();
  // Topology edits rebuild force lookup tables without restarting distant
  // clusters or changing their cooling trajectories. Config changes/init may
  // still explicitly set every node's activity.
  if (alpha != null) for (const n of nodes) n.layoutAlpha = alpha;
  const timerAlpha = alpha ?? nodes.reduce((max, n) => Math.max(max, n.layoutAlpha ?? 0), .02);
  sim = forceSimulation(nodes)
    .force('activity', localActivity(links, cfg, draggingIds, isLinked))
    .force('linkedRepel', pairwiseRepel(
      cfg.linkedRepelStrength,
      cfg.repelRange,
      isLinked,
    ))
    .force('unlinkedRepel', pairwiseRepel(
      cfg.unlinkedRepelStrength,
      cfg.repelRange,
      (a, b) => !isLinked(a, b),
    ))
    .force('rectCollide', rectCollide(420, 120, cfg.collidePadding))
    // arrowAvoid (arrows repelling unrelated nodes) was disabled here as a
    // jitter-mitigation experiment — nodes still repel arrow anchors via
    // ropeNodeRepelStrength in the Verlet rope, which is the dominant
    // direction (arrow curves around node, not the other way). Re-enable
    // by uncommenting if visual piercing becomes a problem.
    // .force('arrowAvoid', arrowAvoid(links.filter(l => l.kind === 'auto'), cfg.arrowAvoidPadding))
    // Only structural arrows attract endpoints. Dotted references are visual,
    // including older project files that saved them with gravitates:true.
    // Structural links use border-to-border rectLink.
    // Previously auto links used ropePullLink — strength based on chain
    // arc length — which made rope shape feed back into node positions
    // (re-route changes chain length, which yanks nodes, which forces
    // another re-route). Switching to rectLink decouples rope shape
    // from node physics: nodes attract by straight-line border
    // distance, rope is purely a visual connector.
    .force('link', rectLink(
      links.filter(l => l.kind === 'auto'),
      cfg.linkDistance,
      cfg.linkStrength,
    ))
    // No origin-gravity (forceX/forceY toward (0, 0)). It was nudging
    // every unfrozen node toward origin whenever alpha > 0, with
    // magnitude PROPORTIONAL TO DISTANCE FROM ORIGIN — so far-away
    // nodes drifted noticeably on every drag and on refresh. Without
    // it the graph has no global pull; nodes only move via link
    // springs, rectCollide (hard overlap), and the user's drags.
    // Safety cap — must be registered last so it sees velocities from all
    // other forces. 1/4 default node width per tick; only fires on runaway.
    .force('velocityCap', velocityCap(420 / 4))
    .alphaDecay(cfg.alphaDecay)
    .velocityDecay(alpha == null ? previousDecay ?? cfg.velocityDecay : cfg.velocityDecay)
    .alpha(timerAlpha)
    .alphaMin(LAYOUT_ALPHA_MIN)
    .on('tick', () => runTickSideEffects());
  for (const n of nodes) {
    if (draggingIds.has(n.id)) continue;
    if (n.frozen) { n.fx = n.x; n.fy = n.y; } else { n.fx = null; n.fy = null; }
  }
}

export function dispatchMessage(m: InMsg): void {
  switch (m.type) {
    case 'set-arrow-sources': {
      for (const source of m.sources) verletRope.setSourcePort(source.arrowId, source.sourcePort);
      // Route and publish without advancing d3 or increasing alpha: measuring
      // an image must not disturb the rest of a settled project.
      runTickSideEffects();
      break;
    }
    case 'init': {
      draggingIds.clear();
      lastEmittedNode.clear();
      lastEmittedAnchors.clear();
      // Start each project (and each headless test) from a self-contained
      // configuration. Canvas supplies its hydrated settings here so restored
      // ropes are compacted and accepted under the same values the worker will
      // actually use; this avoids a second global reroute immediately after
      // loading projects with customized physics.
      cfg = { ...DEFAULT_PHYSICS_CONFIG, ...(m.config ?? {}) };
      nodes = m.nodes.map(n => ({
        id: n.id,
        x: n.x, y: n.y, frozen: n.frozen,
        fx: n.frozen ? n.x : null, fy: n.frozen ? n.y : null,
      }));
      // Hold on to anchors-per-arrow during init so we can pass them to
      // ensureRopeChainFor — `links` (the SimLink[] state) doesn't carry
      // anchors itself.
      const initialAnchorsByArrow = new Map<string, { x: number; y: number }[]>();
      for (const l of m.links) {
        if (l.anchors && l.anchors.length >= 2) {
          initialAnchorsByArrow.set(l.arrowId, l.anchors);
        }
      }
      links = m.links.map(l => ({
        source: l.source, target: l.target,
        kind: l.kind, gravitates: l.gravitates, arrowId: l.arrowId,
      }));
      // Every arrow keeps its visual routing. These ropes never pull nodes;
      // structural attraction is handled independently by rectLink above.
      verletRope.prune(new Set());
      for (const l of links) {
        const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
        ensureRopeChainFor(sId, tId, l.arrowId, initialAnchorsByArrow.get(l.arrowId));
      }
      // Canvas seeds these same persisted positions and compacted chains before
      // the worker starts. Seed the delta baseline too, so the first unrelated
      // interaction does not resend the entire restored project once.
      for (const n of nodes) lastEmittedNode.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      for (const [arrowId, anchors] of Object.entries(verletRope.snapshot())) {
        lastEmittedAnchors.set(arrowId, anchors.map((point) => ({ ...point })));
      }
      rebuildLinkedEdges();
      rebuild(0);
      // Start both the shared timer and local layout activity asleep so
      // restored positions stay exact until a relevant interaction wakes them.
      // R6.5 — arm the friction ramp; it starts when the sim next wakes.
      frictionArmed = true;
      frictionWakeMs = null;
      break;
    }
    case 'add-graph': {
      const placed: PlacedNode[] = [];
      for (const input of m.nodes) {
        if (realNode(input.id)) {
          // Idempotent acknowledgement: a reset/undo race must never leave a
          // measured card hidden merely because the worker already knows it.
          if (input.birth) placed.push({ id: input.id, token: input.birth.token });
          continue;
        }
        const n: SimNode = { id: input.id, x: input.x, y: input.y, frozen: input.frozen,
          width: input.width, height: input.height, vx: 0, vy: 0, layoutAlpha: .12 };
        const parent = input.birth?.parentId && realRect(input.birth.parentId);
        if (parent) {
          const rects = nodes.map(node => ({ id: node.id, x: node.fx ?? node.x ?? 0, y: node.fy ?? node.y ?? 0,
            width: node.width ?? 624, height: node.height ?? 120 }));
          const currentParent = rects.find(r => r.id === parent.id)!;
          Object.assign(n, findNodePlacement(currentParent, rects, input, {
            gap: cfg.collidePadding * 2, restGap: cfg.linkDistance, regions: input.birth?.regions,
            edges: links.map(l => ({ source: typeof l.source === 'string' ? l.source : l.source.id,
              target: typeof l.target === 'string' ? l.target : l.target.id })),
          }));
        }
        if (n.frozen) { n.fx = n.x; n.fy = n.y; }
        nodes.push(n);
        if (input.birth) placed.push({ id: n.id, token: input.birth.token });
      }
      for (const input of m.links) {
        if (links.some(l => l.arrowId === input.arrowId) || !realNode(input.source) || !realNode(input.target)) continue;
        links.push({ ...input, entranceTicks: 12 });
        ensureRopeChainFor(input.source, input.target, input.arrowId, input.anchors);
      }
      rebuildLinkedEdges();
      rebuild(null);
      // Publish final placement and routed arrows BEFORE the first force tick.
      // The main thread reveals the card and starts camera framing together.
      runTickSideEffects(placed);
      break;
    }
    case 'add-node':
      nodes.push({
        id: m.node.id,
        x: m.node.x, y: m.node.y, frozen: m.node.frozen,
        fx: m.node.frozen ? m.node.x : null, fy: m.node.frozen ? m.node.y : null,
        layoutAlpha: .12,
      });
      rebuildLinkedEdges();
      rebuild(null);
      break;
    case 'add-link':
      links.push({
        source: m.link.source, target: m.link.target,
        kind: m.link.kind, gravitates: m.link.gravitates, arrowId: m.link.arrowId,
      });
      ensureRopeChainFor(m.link.source, m.link.target, m.link.arrowId, m.link.anchors);
      rebuildLinkedEdges();
      rebuild(null);
      if (m.link.kind === 'auto') wakeNodes([m.link.source, m.link.target], .12);
      break;
    case 'remove-links': {
      const drop = new Set(m.ids);
      const affected = links.filter(l => drop.has(l.arrowId) && l.kind === 'auto')
        .flatMap(l => [typeof l.source === 'string' ? l.source : l.source.id, typeof l.target === 'string' ? l.target : l.target.id]);
      links = links.filter((l) => !drop.has(l.arrowId));
      for (const id of drop) verletRope.removeChain(id);
      rebuildLinkedEdges();
      rebuild(null);
      if (affected.length) wakeNodes(affected, .12);
      break;
    }
    case 'remove-nodes': {
      const drop = new Set(m.ids);
      for (const id of drop) draggingIds.delete(id);
      nodes = nodes.filter(n => !drop.has(n.id));
      const removedArrowIds = new Set<string>();
      const affected = new Set<string>();
      links = links.filter(l => {
        const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
        if (drop.has(sId) || drop.has(tId)) {
          removedArrowIds.add(l.arrowId);
          if (l.kind === 'auto') { affected.add(sId); affected.add(tId); }
          return false;
        }
        return true;
      });
      removedArrowIds.forEach(id => verletRope.removeChain(id));
      rebuildLinkedEdges();
      rebuild(null);
      if (affected.size) wakeNodes(affected, .12);
      break;
    }
    case 'set-frozen': {
      const n = realNode(m.id);
      if (n && n.frozen !== m.frozen) {
        n.frozen = m.frozen;
        if (m.frozen) {
          // Pin at the current spot — nudged out of any pinned overlap
          // (possible now that dragging is exempt from collision walls),
          // since two fixed rects could never separate on their own.
          const safe = resolveOverlapWithPinned(n, n.x ?? 0, n.y ?? 0);
          n.x = safe.x; n.y = safe.y;
          n.fx = safe.x; n.fy = safe.y;
        } else if (!draggingIds.has(m.id)) {
          // Only release the pin when no other reason holds it (active drag).
          n.fx = null; n.fy = null;
        }
        // Pin/unpin only wakes this node and its physical neighborhood.
        wakeNodes([m.id], 0.05);
      }
      break;
    }
    case 'set-size': {
      const n = realNode(m.id);
      if (n && (n.width !== m.width || n.height !== m.height)) {
        // Initial-assignment guard: Canvas calls setSize for every
        // node right after init (propagating measured sizes into the
        // worker that already match the saved positions). Without
        // this guard each of those calls evaluates `undefined !==
        // 624` and kicks `sim.alpha(0.5).restart()`, waking the
        // simulation N times before the user has touched anything —
        // visible on refresh as a small "settling" nudge of every
        // unfrozen node.
        const wasUnset = n.width == null && n.height == null;
        // R6.A4 — kick strength scales with how much the box actually
        // changed. Load-time measurement corrections (font-swap
        // re-wraps, zoom rounding) are ±1-4 px and only need a
        // whisper of alpha; streaming growth (50 px+) keeps the full
        // re-equilibration kick.
        const maxDelta = Math.max(
          Math.abs((n.width ?? m.width) - m.width),
          Math.abs((n.height ?? m.height) - m.height),
        );
        n.width = m.width;
        n.height = m.height;
        // Re-route arrows touching a node whose KNOWN rect changed shape.
        // The first size message merely fills dimensions the worker did not
        // receive during init; persisted anchors already describe the saved
        // shape and must not all be discarded during project restoration.
        if (!wasUnset) {
          for (const l of links) {
            const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
            const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
            if (sId === m.id || tId === m.id) {
              verletRope.markForReroute(l.arrowId);
            }
          }
        }
        // No rebuild() here — all forces read width/height from the
        // shared SimNode array on every tick.
        if (!wasUnset && m.wake !== 'none') {
          const normalAlpha = Math.min(0.5, Math.max(0.04, maxDelta / 150));
          const targetAlpha = m.wake === 'gentle'
            ? Math.min(0.08, Math.max(0.02, maxDelta / 600))
            : normalAlpha;
          wakeNodes([m.id], targetAlpha);
        }
      }
      break;
    }
    case 'drag-start':
    case 'drag-move': {
      const n = realNode(m.id);
      if (n) {
        // No clamping: the dragged node follows the cursor exactly, over
        // pinned nodes too (it paints on top — NodeView's .dragging rule).
        // Unpinned neighbors still get shoved aside by rectCollide; pinned
        // overlaps resolve at release (drag-end / set-frozen).
        n.fx = m.x;
        n.fy = m.y;
        // Mark as dragging so the rope sim treats this rect as invisible
        // until drag-end. Idempotent on repeat drag-move.
        draggingIds.add(m.id);
        // Reheat only this node's physical neighborhood. The timer is
        // shared, but remote clusters keep their own cooling schedule.
        wakeNodes([m.id], 0.15);
      }
      break;
    }
    case 'drag-end':
    case 'drag-end-many': {
      const ids = new Set(m.type === 'drag-end-many' ? m.ids : [m.id]);
      const released = [...ids].flatMap(id => { const n = realNode(id); return n ? [n] : []; });
      // Apply the latest pointer targets even if release arrives before a
      // simulation tick. All selected nodes must share the final drag delta.
      for (const n of released) { n.x = n.fx ?? n.x ?? 0; n.y = n.fy ?? n.y ?? 0; }
      // Resolve pinned overlaps as one rigid set. Resolving each selected
      // card independently would distort its spacing on release. Existing
      // overlaps inside the set are not new obstacles to this gesture.
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (const n of released) {
          if (!n.frozen) continue;
          const safe = resolveOverlapWithPinned(n, n.x!, n.y!, ids);
          const dx = safe.x - n.x!;
          const dy = safe.y - n.y!;
          if (!dx && !dy) continue;
          moved = true;
          for (const member of released) { member.x! += dx; member.y! += dy; }
        }
        if (!moved) break;
      }
      for (const n of released) {
        n.fx = n.frozen ? n.x : null;
        n.fy = n.frozen ? n.y : null;
        n.vx = 0; n.vy = 0;
        draggingIds.delete(n.id);
      }
      // Mark every chain incident to the released node for a fresh A*
      // route. With force-directed chain dynamics the rope's interior
      // shape doesn't re-route on its own during a drag — anchors get
      // pushed by the moving endpoints + obstacle re-projection but
      // can end up on the wrong side of an obstacle that moved into
      // the path. A* on drag-end picks the correct topology.
      for (const l of links) {
        const sId = typeof l.source === 'string' ? l.source : (l.source as SimNode).id;
        const tId = typeof l.target === 'string' ? l.target : (l.target as SimNode).id;
        if (ids.has(sId) || ids.has(tId)) {
          verletRope.markForReroute(l.arrowId);
        }
      }
      // No rebuild() — fx/fy live on the SimNode and forces read them by
      // reference each tick, same as size.
      wakeNodes(ids, 0.3);
      break;
    }
    case 'arrow-drag-start': {
      verletRope.startAnchorDrag(m.arrowId, m.x, m.y);
      scheduleTicks(0.3);
      break;
    }
    case 'arrow-drag-move': {
      verletRope.moveDraggedAnchor(m.arrowId, m.x, m.y);
      scheduleTicks(0.3);
      break;
    }
    case 'arrow-drag-end': {
      verletRope.endAnchorDrag(m.arrowId);
      scheduleTicks(0.2);
      break;
    }
    case 'set-physics-config': {
      // Refresh-drift guard: every page load pushes the hydrated
      // settings here, and for most users that config is IDENTICAL to
      // what the worker already runs. Rebuilding + kicking alpha for
      // a no-op push re-energized the freshly-loaded (alpha 0) sim,
      // crept every unfrozen node toward equilibrium, and autosave
      // persisted the drift — visibly compounding on every refresh.
      // Only rebuild + wake when a value actually changed.
      const next: PhysicsConfig = { ...m.config };
      const changed = (Object.keys({ ...cfg, ...next }) as (keyof PhysicsConfig)[])
        .some((k) => cfg[k] !== next[k]);
      if (changed) {
        cfg = next;
        verletRope.markAllForReroute();
        rebuild(0.3);
        // The load-time push of the user's saved (non-default) config
        // DOES wake the sim here — but the R6.5 post-load friction ramp
        // (applied per tick) keeps the woken nodes from visibly drifting
        // while it re-settles. A later slider edit kicks the same way,
        // after the ramp has ended, so it re-settles normally.
      }
      break;
    }
    case 'pause': sim?.stop(); break;
    case 'resume': wakeNodes(nodes.map(n => n.id), 0.1); break;
  }
}

// Bottom-of-file: wire the worker boundary only when we're actually in a
// Worker scope. In Node / test contexts `self` is undefined and this
// block is skipped, leaving the module callable via dispatchMessage().
declare const self: WorkerGlobalScope & { onmessage: ((e: MessageEvent<InMsg>) => void) | null } | undefined;
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  setEmit((msg) => (self as unknown as Worker).postMessage(msg));
  self.onmessage = (e: MessageEvent<InMsg>) => dispatchMessage(e.data);
}
