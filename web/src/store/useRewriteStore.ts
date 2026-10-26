/**
 * Transient (not persisted) state for the per-node REWRITE BURST model.
 *
 * A "burst" is everything that happens between the user starting their
 * first rewrite on an idle node and the last rewrite in flight finishing.
 * During a burst:
 *
 *  - The node's DISPLAYED body comes from `workingBody[nodeId]` (with
 *    markers stripped). A real provisional version row is created at the
 *    start and mirrors model output so version navigation/autosave remain
 *    truthful while generation is active.
 *
 *  - Multiple PARTIAL rewrites can run concurrently if they target
 *    different sections. Each owns a marker pair (see
 *    `lib/rewriteMarkers`) that delimits its slice of the working
 *    body; every chunk replaces the text between this rewrite's
 *    markers, leaving other rewrites' slices untouched.
 *
 *  - A WHOLE rewrite (regenerate/modify/elaborate/header-regen)
 *    cancels ALL in-flight rewrites for the node on start, then owns
 *    the full body for its duration.
 *
 *  - When the LAST in-flight rewrite finishes (no others remain),
 *    that rewrite finalizes the ONE provisional row with the marker-
 *    stripped working body, and the snapshot is cleared.
 *
 *  - If a rewrite is aborted by a subsequent whole AND it was the
 *    last partial in flight (i.e. only the whole remains), the
 *    abort just discards its in-progress text — the whole will
 *    overwrite the body anyway.
 *
 * The store is consumed by:
 *  - `lib/generate.ts` — mutates the registry and the working body
 *    from the rewrite functions.
 *  - `components/node/NodeBody.tsx` + `AdaptiveBullets.tsx` — read the
 *    working body so the UI shows in-flight content; read the active
 *    rewrite list so cursors render at the right sections and buttons
 *    disable under conflict.
 *  - `components/canvas/NodeSidePanel.tsx`,
 *    `components/node/NodeFollowUpBar.tsx`,
 *    `components/node/NodeHeader.tsx` — read predicates
 *    (`isWholeActive`, `isPartialActiveOn`) to disable trigger buttons.
 */

import { create } from 'zustand';
import { stripMarkers } from '@/lib/rewriteMarkers';
import type { ExpandPartTarget } from '@/lib/generate';

export type RewriteKind = 'partial' | 'whole';

export interface RewriteRecord {
  /** Unique within a node — used as the marker id for partials. */
  id: string;
  nodeId: string;
  kind: RewriteKind;
  /** Set for partial rewrites — identifies which section the rewrite owns. */
  target?: ExpandPartTarget;
  /** For partials only — the original text of the section before this
   *  rewrite ran. Held so an abort can restore the section instead of
   *  leaving the half-streamed text in the working body. */
  originalSectionText?: string;
  /** AbortController.signal is read by the streaming loop in
   *  generate.ts. A whole rewrite calls .abort() on all existing
   *  records before starting. */
  abortController: AbortController;
}

export interface RewriteBurstSnapshot {
  /** The version body that was being displayed when the burst began.
   *  Restored to the workingBody if the burst is fully aborted with
   *  nothing to commit. */
  preBurstBody: string;
  preBurstVersionIndex: number;
  /** Real version row created when the burst starts. Streaming/finalization
   *  targets this fixed row even if the user browses another version. */
  draftVersionIndex: number;
  /** Runtime generation session owning the draft and every provider pass. */
  generationSessionId: number;
  preBurstBodyMaxHeight: number | null;
  preBurstMinBodyHeight: number | null;
  /** Exact visible prose/body height at burst start. Whole rewrites use this
   * as a grow-only floor while their draft is temporarily empty. */
  preBurstBodyHeightFloor: number | null;
  preBurstFreeTextHeight: number | null;
  preBurstHadBullets: boolean;
  /** True if the user had the node at its minimum body height
   *  (bodyMaxHeight === minBodyHeight) when the burst started. Drives
   *  the snap-down sizing rule when the new version is smaller. */
  preBurstWasAtMin: boolean;
}

interface RewriteStoreState {
  activeByNode: Record<string, RewriteRecord[]>;
  workingBody: Record<string, string>;
  snapshot: Record<string, RewriteBurstSnapshot>;
  /** Set by `markCommit` after committing a new version when the burst
   *  started at min size. Read + cleared by the NodeView snap-down
   *  effect once the AdaptiveBullets re-measurement has updated the
   *  node's minBodyHeight for the new version. */
  /** Set by `finishRewrite` after committing a new version when the
   *  burst started with the node at its minimum body height. Carries
   *  the pre-burst minBodyHeight so the snap-down effect can verify
   *  the NEW minBodyHeight is actually smaller before shrinking. */
  pendingSnapDown: Record<string, { preBurstMinBodyHeight: number }>;

  // ── mutators (called by generate.ts) ─────────────────────────────
  addRecord: (record: RewriteRecord) => void;
  removeRecord: (nodeId: string, rewriteId: string) => void;
  setWorkingBody: (nodeId: string, body: string) => void;
  setSnapshot: (nodeId: string, snap: RewriteBurstSnapshot) => void;
  clearBurst: (nodeId: string) => void;
  setPendingSnapDown: (nodeId: string, payload: { preBurstMinBodyHeight: number }) => void;
  clearPendingSnapDown: (nodeId: string) => void;
}

export const useRewriteStore = create<RewriteStoreState>((set) => ({
  activeByNode: {},
  workingBody: {},
  snapshot: {},
  pendingSnapDown: {},

  addRecord: (record) => set((s) => {
    const list = s.activeByNode[record.nodeId] ?? [];
    return {
      activeByNode: { ...s.activeByNode, [record.nodeId]: [...list, record] },
    };
  }),

  removeRecord: (nodeId, rewriteId) => set((s) => {
    const list = s.activeByNode[nodeId] ?? [];
    const next = list.filter((r) => r.id !== rewriteId);
    if (next.length === list.length) return s;
    const out = { ...s.activeByNode };
    if (next.length === 0) delete out[nodeId];
    else out[nodeId] = next;
    return { activeByNode: out };
  }),

  setWorkingBody: (nodeId, body) => set((s) => ({
    workingBody: { ...s.workingBody, [nodeId]: body },
  })),

  setSnapshot: (nodeId, snap) => set((s) => ({
    snapshot: { ...s.snapshot, [nodeId]: snap },
  })),

  clearBurst: (nodeId) => set((s) => {
    const active = { ...s.activeByNode };
    const wb = { ...s.workingBody };
    const sn = { ...s.snapshot };
    delete active[nodeId];
    delete wb[nodeId];
    delete sn[nodeId];
    return { activeByNode: active, workingBody: wb, snapshot: sn };
  }),

  setPendingSnapDown: (nodeId, payload) => set((s) => ({
    pendingSnapDown: { ...s.pendingSnapDown, [nodeId]: payload },
  })),

  clearPendingSnapDown: (nodeId) => set((s) => {
    if (!s.pendingSnapDown[nodeId]) return s;
    const out = { ...s.pendingSnapDown };
    delete out[nodeId];
    return { pendingSnapDown: out };
  }),
}));

// ── Read helpers (free functions, not hooks) ───────────────────────
// These read the latest store state synchronously. They're for non-
// reactive callers — primarily generate.ts. Components that need to
// re-render when these predicates change should subscribe with the
// hook form via `useRewriteStore((s) => ...)`.

export function hasAnyActive(nodeId: string): boolean {
  const list = useRewriteStore.getState().activeByNode[nodeId];
  return !!list && list.length > 0;
}

export function isWholeActive(nodeId: string): boolean {
  const list = useRewriteStore.getState().activeByNode[nodeId];
  if (!list) return false;
  return list.some((r) => r.kind === 'whole');
}

/** Same-section conflict check used by the side panel's
 *  "Expand selected" button. Returns true if a partial rewrite is
 *  already running for THIS specific target on THIS node. */
export function isPartialActiveOn(nodeId: string, target: ExpandPartTarget): boolean {
  const list = useRewriteStore.getState().activeByNode[nodeId];
  if (!list) return false;
  return list.some((r) => r.kind === 'partial' && targetsEqual(r.target, target));
}

export function getActiveRecords(nodeId: string): RewriteRecord[] {
  return useRewriteStore.getState().activeByNode[nodeId] ?? [];
}

/** Returns the body the UI should display: the stripped working body
 *  if a burst is in flight for the node, otherwise `fallback` (the
 *  current version's body). Free function — use the reactive form
 *  `useDisplayBody` in components. */
export function getDisplayBody(nodeId: string, versionIndex: number, fallback: string): string {
  const state = useRewriteStore.getState();
  const wb = state.workingBody[nodeId];
  const draftVersionIndex = state.snapshot[nodeId]?.draftVersionIndex;
  if (wb == null || draftVersionIndex !== versionIndex) return fallback;
  return stripMarkers(wb);
}

/** Equality on ExpandPartTarget — kind plus its stable target coordinates. */
export function targetsEqual(a: ExpandPartTarget | undefined, b: ExpandPartTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'freetext') return true;
  if (a.kind === 'selection') {
    const other = b as Extract<ExpandPartTarget, { kind: 'selection' }>;
    if (a.start !== other.start || a.end !== other.end) return false;
    const aParts = a.parts ?? [];
    const bParts = other.parts ?? [];
    if (aParts.length !== bParts.length) return false;
    return aParts.every((part, index) => {
      const candidate = bParts[index];
      return candidate?.sourceField === part.sourceField
        && candidate.start === part.start
        && candidate.end === part.end;
    });
  }
  return a.index === (b as { kind: 'bullet'; index: number }).index;
}

// ── Reactive hooks for components ──────────────────────────────────
// Each hook returns a primitive or a reference-stable value so React
// re-renders only when the relevant slice of the store actually
// changes. Default Zustand `Object.is` comparison handles this — we
// never construct a new object/array on each call for these.

/** True if a WHOLE rewrite is in flight for the node. */
export function useIsWholeActive(nodeId: string): boolean {
  return useRewriteStore((s) => {
    const list = s.activeByNode[nodeId];
    if (!list) return false;
    for (const r of list) if (r.kind === 'whole') return true;
    return false;
  });
}

/** True if ANY rewrite (whole or partial) is in flight. Used by the
 *  bottom-cursor visibility logic — when no rewrites are active, the
 *  cursor follows the node's `generating` flag (spawn paths). */
export function useHasAnyActive(nodeId: string): boolean {
  return useRewriteStore((s) => {
    const list = s.activeByNode[nodeId];
    return !!list && list.length > 0;
  });
}

/** The raw working body for the node, or undefined if no burst is in
 *  flight. Marker stripping is the caller's job (see
 *  `useDisplayBody`). */
export function useWorkingBody(nodeId: string): string | undefined {
  return useRewriteStore((s) => s.workingBody[nodeId]);
}

/** Display body: the marker-stripped working body if a burst is in
 *  flight, otherwise `fallback` (the version body). Reactive — re-
 *  renders the caller whenever the working body changes. */
export function useDisplayBody(nodeId: string, versionIndex: number, fallback: string): string {
  const wb = useWorkingBody(nodeId);
  const draftVersionIndex = useRewriteStore((s) => s.snapshot[nodeId]?.draftVersionIndex);
  if (wb == null || draftVersionIndex !== versionIndex) return fallback;
  return stripMarkers(wb);
}

/** All in-flight rewrite records for the node, or undefined if none.
 *  Returns the SAME array reference between renders when the list
 *  membership hasn't changed (Zustand bails on Object.is) — safe to
 *  use as a hook dependency. */
export function useActiveRecords(nodeId: string): RewriteRecord[] | undefined {
  return useRewriteStore((s) => s.activeByNode[nodeId]);
}
