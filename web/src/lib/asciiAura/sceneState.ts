/**
 * Shared interactive-background scene state.
 *
 * ⚠ ARCHITECTURE: Scatter has a SINGLE interactive-background renderer
 * (AsciiAuraLayerGL, WebGL2). A canvas-2D CPU renderer was REMOVED ON PURPOSE;
 * mentions of "the 2D path" / "2D renderer" below are HISTORICAL — they explain
 * why this contract is shaped as it is, not a live consumer to keep in parity
 * with. Do not re-add a 2D renderer.
 *
 * Owns everything about WHAT the aura field shows — which auras exist,
 * where they are, which are focused, what waves/ghosts are animating,
 * the current viewport, and the baseline palette membership. Knows
 * nothing about HOW it gets painted: the renderer consumes one instance
 * of this and turns the state into pixels.
 *
 * Renderer contract:
 *   - `onDirty(reason)` fires when anything paint-relevant changed.
 *     Reasons are granular (the old CPU renderer mapped some of them —
 *     'zoom' | 'recolor' | 'palette' — to a full canvas refresh); the GL
 *     renderer just re-renders next frame.
 *   - `subscribeStores()` wires the three zustand stores
 *     (graph / live positions / live viewport) and runs one initial
 *     sync; returns the combined unsubscribe.
 *   - `pruneExpired(now)` drops finished waves/ghosts — call it once
 *     per render tick before deciding whether anything is animating.
 *   - `evalIntensities(now)` advances every aura's focus-intensity
 *     tween (wall-clock anchored — see AuraEntry) and writes the
 *     result back into the entries. Returns true while any tween is
 *     still in flight. MUST be the single writer of `intensity`:
 *     handleGraph anchors new tweens FROM the current written value,
 *     so a renderer that computed intensity privately would break
 *     mid-flight reversals for the other renderer.
 */
import { useGraphStore } from '@/store/useGraphStore';
import { birthIsPending, useNodeBirthStore } from '@/store/useNodeBirthStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { currentContentType, isExplainContentType } from '@/lib/nodeContentType';
import { waveStillActive, WAVE_DURATION_MS, type Wave } from './wave';
import type { GroupColor, Project } from '@/store/types';

export const AURA_RADIUS_UNFOCUSED = 200;
export const AURA_RADIUS_FOCUSED = 300;
/** Arbitration weight multiplier for focused auras (≈ 70/30 split
 *  in contested cells). Used by the scene math + the GLSL port. */
export const FOCUS_BOOST = 2.33;
/** E.10 — wall-clock duration of the focus-IN alpha tween (snappy). */
export const FOCUS_TRANSITION_MS = 200;
/** R6 — slower fade-OUT when a node loses focus, so unselecting reads
 *  as a calm settle rather than a snap. */
export const UNFOCUS_TRANSITION_MS = 450;
/** Back-compat alias — the focus-in duration. */
export const INTENSITY_TRANSITION_MS = FOCUS_TRANSITION_MS;
/** R6 — how long a chip-flash (re-clicking an already-explored term)
 *  holds the target node at the focused tier before it fades back. */
export const FLASH_FOCUS_HOLD_MS = 1000;
/** R6.10 — max older focus ripples kept overlapping behind the latest
 *  one (so up to MAX_FOCUS_ECHOES + 1 ripples coexist on a node). Bounded
 *  by the GL record's 4 wave-time slots. */
export const MAX_FOCUS_ECHOES = 3;

export interface Rect { x: number; y: number; w: number; h: number }

export interface AuraEntry {
  id: string;
  rect: Rect;
  focused: boolean;
  /** B.8 — group's Catppuccin accent, or null when the node has no
   *  group. Renderers resolve it to concrete colors themselves. */
  accent: GroupColor | null;
  /** Runtime-only visual identity for prose explanation auras. */
  isExplain: boolean;
  /** Chats decorate their normal aura with outward rays, sparser in each row. */
  isChat: boolean;
  /** Stable 16-bit node-id seed used by the GPU glyph sampler. */
  glyphSeed: number;
  /** E.10 — currently displayed focus intensity in [0, 1], advanced
   *  by evalIntensities as
   *  `intensityFrom + progress * (target - intensityFrom)` where
   *  `target = focused ? 1 : 0` and
   *  `progress = clamp((now - intensityFlipAt) / DURATION, 0, 1)`. */
  intensity: number;
  /** E.10 / F.1-bis — intensity value at the moment focused last
   *  flipped. Re-set on every flip so a mid-transition reverse
   *  (focus → unfocus → focus) animates out from wherever the
   *  previous transition got to. */
  intensityFrom: number;
  /** E.10 / F.1-bis — `performance.now()` at the last focused flip. */
  intensityFlipAt: number;
}

/** Deterministic 16-bit FNV-1a seed; no persisted migration is needed. */
export function stableAuraGlyphSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0xffff;
}

export interface Ghost {
  id: string;
  rect: Rect;
  wave: Extract<Wave, { kind: 'collapse' }>;
}

/**
 * Why a renderer needs to repaint. (Historical: the old CPU renderer mapped
 * these to its repaint flags —
 *   zoom | recolor | palette → needsFullRefresh (+ repaint)
 *   pan | zoom               → urgentRepaint (+ repaint)
 *   geometry | wave          → needsRepaint
 * The GL renderer just re-renders next frame; the granularity is kept because
 * it's still cheap signal about what changed.)
 */
export type DirtyReason =
  | 'pan'        // viewport x/y moved
  | 'zoom'       // viewport zoom changed
  | 'geometry'   // aura added/removed/moved/resized/focus-flipped
  | 'recolor'    // an existing aura's accent changed
  | 'palette'    // baseline palette membership changed
  | 'wave';      // a wave/ghost was fired or expired

export interface AuraSceneState {
  auras: Map<string, AuraEntry>;
  waves: Map<string, Wave>;
  /** R6.10 — extra still-active focus-ripple start times PER NODE,
   *  behind the latest one in `waves`. Lets rapid chip re-clicks stack
   *  into overlapping ripples (the newest is the `waves` entry; these
   *  are the up-to-3 older echoes still expanding). Only ever holds
   *  'focus' starts; cleared when the node unfocuses or its primary
   *  wave turns non-focus. Pruned by pruneExpired. The GL renderer packs
   *  these alongside the primary. (The old CPU renderer drew the primary
   *  only — a single ripple.) */
  focusEchoes: Map<string, number[]>;
  ghosts: Map<string, Ghost>;
  viewport: { x: number; y: number; zoom: number };
  /** E.9 — distinct group accents in active use (≥ 1 member), sorted
   *  alphabetically so the per-cell hash → palette-index mapping stays stable
   *  across syncs. The renderer appends its own neutral entry when
   *  `anyUngrouped` is true. */
  baselineAccents: GroupColor[];
  anyUngrouped: boolean;
  /** Bumps whenever baselineAccents/anyUngrouped membership changes —
   *  renderers compare against their cached copy. */
  paletteVersion: number;
  /** Optional scene-specific cooldown speed. The ordinary graph scene omits
   *  this and uses the renderer's established 20 stages/second default. */
  coolStagesPerSecond?: number;
}

export interface AuraScene {
  state: AuraSceneState;
  subscribeStores(): () => void;
  pruneExpired(now: number): void;
  evalIntensities(now: number): boolean;
}

/** Optional runtime scene source for display-only consumers such as startup. */
export type AuraSceneFactory = (opts: {
  onDirty: (reason: DirtyReason) => void;
}) => AuraScene;

/** Walk project state once: distinct accents of groups with ≥ 1
 *  member (sorted), plus whether any ungrouped node exists. */
function collectBaselineAccents(project: Project): {
  accents: GroupColor[];
  anyUngrouped: boolean;
} {
  const colorsInUse = new Set<GroupColor>();
  let anyUngrouped = false;
  for (const node of Object.values(project.nodes)) {
    if (node.groupId) {
      const color = project.groups[node.groupId]?.color;
      if (color) colorsInUse.add(color);
    } else if (project.color) {
      // Ungrouped/root nodes wear the project base color — it's a palette
      // member like any group accent.
      colorsInUse.add(project.color);
    } else {
      anyUngrouped = true; // legacy color-less project → neutral grey baseline
    }
  }
  return { accents: Array.from(colorsInUse).sort(), anyUngrouped };
}

export function createAuraSceneState(opts: {
  onDirty: (reason: DirtyReason) => void;
}): AuraScene {
  const { onDirty } = opts;

  const state: AuraSceneState = {
    auras: new Map(),
    waves: new Map(),
    focusEchoes: new Map(),
    ghosts: new Map(),
    viewport: { x: 0, y: 0, zoom: 1 },
    baselineAccents: [],
    anyUngrouped: false,
    paletteVersion: 0,
  };

  // Internal sync bookkeeping (was closure state + stateRef fields in
  // the component).
  let knownNodeIds = new Set<string>();
  let lastFlashNonce = 0;
  let lastPanArrivalNonce = 0;
  let pendingChipRipple: {
    childNodeId: string;
    highlightNonce: number;
    panRequestId: number;
  } | null = null;
  let paletteKey = '';
  // R6 — transient chip-flash focus: id → wall-clock expiry. A node
  // re-clicked via an already-explored term lifts to the focused tier
  // for FLASH_FOCUS_HOLD_MS without touching selection, then fades
  // back with a receding ripple (expiry handled in pruneExpired).
  const flashFocus = new Map<string, number>();
  // Perf short-circuit caches: the graph store fires handleGraph on
  // EVERY mutation (basic subscribe has no selector); these refs skip
  // the O(N) node walk when nothing relevant changed.
  let lastNodesRef: object | null = null;
  let lastSelectionRef: object | null = null;
  let lastHighlightRef: object | null = null;
  let lastPanToRef: object | null = null;
  let lastPanArrivalRef: object | null = null;
  let lastGroupsRef: object | null = null;
  let lastBirthsRef: object | null = null;
  // recolorProject changes ONLY project.color — none of the four refs above
  // move, so without tracking it the walk (accents + palette) never re-runs.
  let lastProjectColor: string | undefined;

  const handleGraph = () => {
    const gs = useGraphStore.getState();
    const project = gs.project;
    if (!project) return;
    const now = performance.now();
    const births = useNodeBirthStore.getState().byNode;

    // Viewport — sourced from the live viewport store (PERF R4: the
    // runtime source of truth; project.viewport only updates at
    // commit boundaries). Zoom invalidates per-cell glyph state → distinct
    // reason (the old CPU path needed a full refresh; GL resets cooling history).
    const oldVp = state.viewport;
    const lv = useLiveViewportStore.getState();
    const vpPanned = oldVp.x !== lv.x || oldVp.y !== lv.y;
    const vpZoomed = oldVp.zoom !== lv.zoom;
    if (vpZoomed) onDirty('zoom');
    else if (vpPanned) onDirty('pan');
    state.viewport = { x: lv.x, y: lv.y, zoom: lv.zoom };

    // Perf short-circuit: skip the O(N) node + selection + highlight
    // walk when none of those refs changed. Pan-only ticks hit this
    // early-return and run in microseconds.
    if (
      project.nodes === lastNodesRef
      && project.selection === lastSelectionRef
      && gs.highlight === lastHighlightRef
      && gs.panTo === lastPanToRef
      && gs.panArrival === lastPanArrivalRef
      && project.groups === lastGroupsRef
      && project.color === lastProjectColor
      && births === lastBirthsRef
    ) {
      return;
    }
    // Headers and group names are rendered by the ASCII label pass even when
    // the aura geometry and colors are unchanged. Wake the renderer for those
    // graph-only edits so an idle scene refreshes immediately.
    if (project.nodes !== lastNodesRef || project.groups !== lastGroupsRef) {
      onDirty('geometry');
    }
    lastNodesRef = project.nodes;
    lastSelectionRef = project.selection;
    lastHighlightRef = gs.highlight;
    lastPanToRef = gs.panTo;
    lastPanArrivalRef = gs.panArrival;
    lastGroupsRef = project.groups;
    lastProjectColor = project.color;
    lastBirthsRef = births;

    const newKnown = new Set<string>();
    for (const id of Object.keys(project.nodes)) {
      if (birthIsPending(births[id])) continue;
      newKnown.add(id);
      if (!knownNodeIds.has(id)) {
        state.waves.set(id, { kind: 'spawn', t0: now });
        onDirty('wave');
      }
    }
    for (const id of knownNodeIds) {
      if (!newKnown.has(id)) {
        const aura = state.auras.get(id);
        if (aura) {
          const startRadius = aura.focused ? AURA_RADIUS_FOCUSED : AURA_RADIUS_UNFOCUSED;
          state.ghosts.set(id, {
            id, rect: { ...aura.rect },
            wave: { kind: 'collapse', t0: now, startRadius },
          });
        }
        state.auras.delete(id);
        state.waves.delete(id);
        state.focusEchoes.delete(id);
        if (pendingChipRipple?.childNodeId === id) pendingChipRipple = null;
        onDirty('geometry');
      }
    }
    knownNodeIds = newKnown;

    const startChipRipple = (id: string) => {
      // Arrival refreshes the lift so a long pan never consumes the visible
      // portion of the one-second focus hold.
      flashFocus.set(id, now + FLASH_FOCUS_HOLD_MS);
      const active = state.waves.get(id);
      if (active?.kind === 'focus' && waveStillActive(active, now)) {
        const echoes = state.focusEchoes.get(id) ?? [];
        state.focusEchoes.set(id, [active.t0, ...echoes].slice(0, MAX_FOCUS_ECHOES));
      }
      state.waves.set(id, { kind: 'focus', t0: now });
      onDirty('wave');
    };

    // Release a queued chip ripple before cancellation cleanup. A successful
    // `completePanTo` atomically publishes the arrival and clears `panTo`, so
    // processing in this order distinguishes arrival from plain cancellation.
    let chipRippleTarget: string | null = null;
    const arrival = gs.panArrival;
    const hasNewArrival = !!arrival && arrival.nonce !== lastPanArrivalNonce;
    if (hasNewArrival) {
      lastPanArrivalNonce = arrival.nonce;
      if (
        pendingChipRipple?.childNodeId === arrival.nodeId
        && pendingChipRipple.panRequestId === arrival.requestId
      ) {
        chipRippleTarget = arrival.nodeId;
        pendingChipRipple = null;
        startChipRipple(arrival.nodeId);
      }
    }

    // Register a chip-flash BEFORE the aura loop so the target's `focused`
    // calculation picks up its transient lift on this same tick. If Canvas is
    // moving to that child, queue only the wave; the arrow/term highlight and
    // focused aura tier remain immediate.
    const flash = gs.highlight;
    if (flash && flash.nonce !== lastFlashNonce) {
      lastFlashNonce = flash.nonce;
      // Node-origin flashes accompany a real selection transition, whose
      // false→true focus path below already owns the ripple. Chip flashes are
      // explicit repeatable events: restart even if the aura is already focused.
      if (flash.source !== 'node') {
        const id = flash.childNodeId;
        flashFocus.set(id, now + FLASH_FOCUS_HOLD_MS);
        chipRippleTarget = id;
        if (gs.panTo?.id === id) {
          pendingChipRipple = {
            childNodeId: id,
            highlightNonce: flash.nonce,
            panRequestId: gs.panTo.requestId,
          };
        } else {
          pendingChipRipple = null;
          startChipRipple(id);
        }
      }
    }

    // A request that disappears or changes target without a matching arrival
    // was cancelled/invalid. Never play its queued ripple later.
    if (
      pendingChipRipple
      && (
        !gs.panTo
        || gs.panTo.id !== pendingChipRipple.childNodeId
        || gs.panTo.requestId !== pendingChipRipple.panRequestId
      )
    ) {
      pendingChipRipple = null;
    }

    const selection = new Set(project.selection);
    const lps = useLivePositionsStore.getState().positions;
    for (const id of newKnown) {
      const node = project.nodes[id]!;
      const lp = lps[id];
      const x = lp?.x ?? node.position.x;
      const y = lp?.y ?? node.position.y;
      const w = nodeWidth(node);
      const h = nodeRenderedH(node);
      // Group and manual selections share the same selected-node set.
      // R6 — a live chip-flash lifts the node to the focused tier too.
      // R6.10 — `focusedHard` = focus from selection/group (the node is
      // already in view, so it ripples immediately). A chip-flash lift is
      // focus WITHOUT focusedHard: its ripple is deferred to the focus
      // pulse so it plays when the camera lands, not during the fly-over.
      const focusedHard = selection.has(id);
      const focused = focusedHard || (flashFocus.get(id) ?? 0) > now;
      // B.8 — resolve the node's accent: group color when grouped, else the
      // project base color (null only on legacy color-less data → neutral
      // grey); recolorGroup / assignNodeToGroup / deleteGroup /
      // recolorProject all flow through here on the next sync.
      const gid = node.groupId;
      const accent: GroupColor | null =
        (gid && project.groups[gid]?.color) || project.color || null;
      const contentType = currentContentType(node);
      const isExplain = isExplainContentType(contentType);
      const isChat = contentType === 'chat';
      const existing = state.auras.get(id);
      if (existing && !existing.focused && focused) {
        // Selection/group focus ripples immediately. Chip focus is suppressed
        // here because its explicit event either started the wave immediately
        // (no pan) or queued it until Canvas reports arrival.
        if (chipRippleTarget !== id) {
          state.waves.set(id, { kind: 'focus', t0: now });
          onDirty('wave');
        }
      } else if (existing && existing.focused && !focused) {
        // R6 — focus lost → receding ripple (water draining back).
        // R6.10 — drop any stacked focus echoes: the node is receding
        // now, so leftover expanding ripples must not keep playing.
        state.focusEchoes.delete(id);
        const w0 = state.waves.get(id);
        if (!w0 || !waveStillActive(w0, now)) {
          state.waves.set(id, { kind: 'unfocus', t0: now });
          onDirty('wave');
        }
      }
      if (
        !existing
        || existing.rect.x !== x || existing.rect.y !== y
        || existing.rect.w !== w || existing.rect.h !== h
        || existing.focused !== focused
        || existing.isExplain !== isExplain
        || existing.isChat !== isChat
      ) {
        onDirty('geometry');
      }
      // D.1 — a color-only change didn't perturb the old CPU diff cache's
      // (stage, focused) fingerprint, so it maps to the full-refresh
      // reason. Cheap — these are user-driven events.
      if (existing && existing.accent !== accent) {
        onDirty('recolor');
      }
      // E.10 / F.1-bis — wall-clock tween anchored at focused-flip:
      // new aura starts AT target (no spawn tween); unchanged focus
      // preserves the in-flight tween; a flip re-anchors from the
      // current displayed intensity so mid-flight reversals animate
      // out from the partial value.
      let intensity: number;
      let intensityFrom: number;
      let intensityFlipAt: number;
      if (!existing) {
        intensity = focused ? 1 : 0;
        intensityFrom = intensity;
        intensityFlipAt = now;
      } else if (existing.focused === focused) {
        intensity = existing.intensity;
        intensityFrom = existing.intensityFrom;
        intensityFlipAt = existing.intensityFlipAt;
      } else {
        intensity = existing.intensity;
        intensityFrom = existing.intensity;
        intensityFlipAt = now;
      }
      state.auras.set(id, {
        id,
        rect: { x, y, w, h },
        focused,
        accent,
        isExplain,
        isChat,
        glyphSeed: stableAuraGlyphSeed(id),
        intensity,
        intensityFrom,
        intensityFlipAt,
      });
    }

    // E.9 — baseline palette MEMBERSHIP (accents, not resolved color
    // strings — each renderer formats its own colors).
    const { accents, anyUngrouped } = collectBaselineAccents(project);
    const key = accents.join('|') + (anyUngrouped ? '|~' : '');
    if (key !== paletteKey) {
      paletteKey = key;
      state.baselineAccents = accents;
      state.anyUngrouped = anyUngrouped;
      state.paletteVersion++;
      onDirty('palette');
    }
  };

  const handleLive = () => {
    const lps = useLivePositionsStore.getState().positions;
    let changed = false;
    for (const aura of state.auras.values()) {
      const lp = lps[aura.id];
      if (lp && (lp.x !== aura.rect.x || lp.y !== aura.rect.y)) {
        aura.rect.x = lp.x;
        aura.rect.y = lp.y;
        changed = true;
      }
    }
    if (changed) onDirty('geometry');
  };

  return {
    state,

    subscribeStores() {
      const unsub1 = useGraphStore.subscribe(handleGraph);
      const unsub2 = useLivePositionsStore.subscribe(handleLive);
      // Pan ticks bypass useGraphStore entirely (PERF R4), so the
      // live viewport store needs its own subscription. The perf
      // short-circuit keeps per-tick work microscopic.
      const unsub3 = useLiveViewportStore.subscribe(handleGraph);
      const unsub4 = useNodeBirthStore.subscribe(handleGraph);
      handleGraph();
      return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
    },

    pruneExpired(now: number) {
      let expired = false;
      for (const [id, wave] of state.waves) {
        if (!waveStillActive(wave, now)) {
          state.waves.delete(id);
          expired = true;
        }
      }
      for (const [id, ghost] of state.ghosts) {
        if (!waveStillActive(ghost.wave, now)) {
          state.ghosts.delete(id);
          expired = true;
        }
      }
      // R6.10 — drop overlapping focus echoes once each has run its full
      // ripple lifetime; remove the node's entry when none remain.
      if (state.focusEchoes.size > 0) {
        for (const [id, echoes] of state.focusEchoes) {
          for (let i = echoes.length - 1; i >= 0; i--) {
            if (now - echoes[i]! >= WAVE_DURATION_MS) {
              echoes.splice(i, 1);
              expired = true;
            }
          }
          if (echoes.length === 0) state.focusEchoes.delete(id);
        }
      }
      // R6 — expire chip-flash holds. When the 1 s hold ends, the node
      // unfocuses UNLESS it's also held by selection/group; that flip
      // re-anchors the fade tween and fires the receding ripple.
      if (flashFocus.size > 0) {
        const gs = useGraphStore.getState();
        const project = gs.project;
        for (const [id, expiresAt] of flashFocus) {
          if (expiresAt > now) continue;
          flashFocus.delete(id);
          const aura = state.auras.get(id);
          if (!aura || !aura.focused) continue;
          const stillFocused = !!project?.selection.includes(id);
          if (stillFocused) continue;
          aura.focused = false;
          aura.intensityFrom = aura.intensity;
          aura.intensityFlipAt = now;
          state.focusEchoes.delete(id); // receding now — stop echoes
          const w0 = state.waves.get(id);
          if (!w0 || !waveStillActive(w0, now)) {
            state.waves.set(id, { kind: 'unfocus', t0: now });
          }
          expired = true;
        }
      }
      if (expired) onDirty('wave');
    },

    evalIntensities(now: number) {
      let anyTransitioning = false;
      for (const a of state.auras.values()) {
        const target = a.focused ? 1 : 0;
        if (a.intensityFrom === target) {
          // Already at target when the flip was registered — nothing
          // to animate. Lock the displayed value and move on.
          if (a.intensity !== target) a.intensity = target;
          continue;
        }
        // R6 — asymmetric: focus-IN is snappy (200 ms), focus-OUT is a
        // slow calm fade (450 ms).
        const duration = target === 1 ? FOCUS_TRANSITION_MS : UNFOCUS_TRANSITION_MS;
        const elapsed = now - a.intensityFlipAt;
        const progress = elapsed <= 0
          ? 0
          : elapsed >= duration ? 1 : elapsed / duration;
        a.intensity = a.intensityFrom + progress * (target - a.intensityFrom);
        if (progress < 1) anyTransitioning = true;
      }
      return anyTransitioning;
    },
  };
}
