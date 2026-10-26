/**
 * Transient animation state for the ASCII arrow header-labels.
 *
 * The pure layout module (`lib/asciiAura/arrowLabels.ts`) decides, each frame,
 * which arrows SHOULD show a label and where. This store holds the per-label
 * animation timestamps so the renderer can type a label on when it appears and
 * backspace-delete it when it leaves — while reflows (re-wrap on zoom, side
 * flips, header edits) update in place WITHOUT restarting the animation.
 *
 * Runtime-only — never persisted, never in undo. Mirrors useNodeStatusStore.
 * The single writer/reader is the active aura renderer's paint loop, which calls
 * `reconcile(desired, now)` then reads `entries`; nothing subscribes reactively.
 */
import { create } from 'zustand';
import type { GroupColor } from '@/store/types';
import type { LabelCell } from '@/lib/asciiAura/arrowLabels';
import type { Rect } from '@/lib/asciiAura/sceneState';
import { statusFullyDeleted } from '@/lib/asciiAura/statusText';

export interface ArrowLabelEntry {
  arrowId?: string;
  text: string;
  targetNodeId: string;
  hitRect: Rect;
  /** Timestamp (performance.now) when this label first appeared. */
  startedAt: number;
  /** Timestamp when the delete wipe began, or null while still shown. */
  clearedAt: number | null;
  /** Last computed layout — kept so a label that has begun deleting can finish
   *  its wipe at the last spot even after its arrow stops qualifying. */
  cells: LabelCell[];
  accents: (GroupColor | null)[];
}

export interface DesiredLabel {
  text: string;
  targetNodeId: string;
  hitRect: Rect;
  cells: LabelCell[];
  accents: (GroupColor | null)[];
}

interface State {
  entries: Record<string /* arrowId */, ArrowLabelEntry>;
  /**
   * Fold the live "desired" set into the entry map at time `now`:
   *  - new arrow → add with startedAt = now (types in)
   *  - present & still wanted → refresh text/cells in place, keep startedAt
   *    (re-wrap / word change reflows; the type-on does NOT replay)
   *  - wanted again after it began deleting → restart type-on
   *  - no longer wanted → stamp clearedAt (backspace-deletes), keep last cells
   *  - delete finished → prune
   */
  reconcile: (desired: Map<string, DesiredLabel>, now: number, hiddenIds?: ReadonlySet<string>) => void;
}

export const useArrowLabelStore = create<State>((set, get) => ({
  entries: {},
  reconcile: (desired, now, hiddenIds) => {
    const prev = get().entries;
    if (desired.size === 0 && Object.keys(prev).length === 0) return;

    const next: Record<string, ArrowLabelEntry> = {};

    // Desired labels: add (type-on) or refresh in place (no retype).
    for (const [id, d] of desired) {
      const cur = prev[id];
      if (!cur || cur.clearedAt != null) {
        next[id] = {
          arrowId: id,
          text: d.text, targetNodeId: d.targetNodeId, hitRect: d.hitRect,
          startedAt: now, clearedAt: null, cells: d.cells, accents: d.accents,
        };
      } else {
        next[id] = {
          arrowId: id,
          text: d.text, targetNodeId: d.targetNodeId, hitRect: d.hitRect,
          startedAt: cur.startedAt, clearedAt: null, cells: d.cells, accents: d.accents,
        };
      }
    }

    // Entries no longer desired: begin/continue the delete, prune when done.
    for (const id in prev) {
      if (hiddenIds?.has(id)) continue;
      if (desired.has(id)) continue;
      const cur = prev[id]!;
      const clearedAt = cur.clearedAt ?? now;
      if (statusFullyDeleted(cur.text, clearedAt, now)) continue; // prune
      next[id] = { ...cur, clearedAt };
    }

    set({ entries: next });
  },
}));
