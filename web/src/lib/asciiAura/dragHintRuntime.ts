import {
  useDragHintPresentationStore,
  type DesiredDragHintPresentation,
  type DragHintPresentationEntry,
} from '@/store/useDragHintPresentationStore';
import { useDragHintStore, type DragHintEntry } from '@/store/useDragHintStore';

/** Wake the renderer whenever the logical gesture changes, even after its cool tail. */
export function subscribeDragHintRendererInvalidation(markDirty: () => void): () => void {
  return useDragHintStore.subscribe(markDirty);
}

/** Reconcile one rendered frame and prune a cleared logical hint after deletion. */
export function reconcileDragHintPresentationFrame(
  desired: DesiredDragHintPresentation | null,
  logicalHint: DragHintEntry | null,
  now: number,
): DragHintPresentationEntry | null {
  useDragHintPresentationStore.getState().reconcile(desired, now);
  const presented = useDragHintPresentationStore.getState().entry;
  if (logicalHint?.clearedAt != null && !presented) {
    useDragHintStore.getState().remove(logicalHint.nodeId);
  }
  return presented;
}
