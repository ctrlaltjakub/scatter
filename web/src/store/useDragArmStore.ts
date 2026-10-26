/**
 * Transient "this node is armed to pin" state, for the drag-away auto-pin.
 *
 * While the user drags a node, Canvas's onDragMove sets `armedNodeId` when the
 * drag passes the auto-pin threshold and continuously updates `strength` from
 * the excess distance. The pin icon uses the ID for its one React transition,
 * then applies strength through a direct store subscription so the drag hot
 * path does not re-render the card for every pointer sample.
 *
 * Runtime-only (never persisted or included in undo history).
 */
import { create } from 'zustand';

interface DragArmState {
  armedNodeId: string | null;
  strength: number;
  setArmed: (id: string | null, strength?: number) => void;
}

export const useDragArmStore = create<DragArmState>((set) => ({
  armedNodeId: null,
  strength: 0,
  setArmed: (id, strength = 0) => set((state) => {
    const nextStrength = id === null ? 0 : Math.max(0, Math.min(1, strength));
    return state.armedNodeId === id && state.strength === nextStrength
      ? state
      : { armedNodeId: id, strength: nextStrength };
  }),
}));
