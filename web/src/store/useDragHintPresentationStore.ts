import { create } from 'zustand';
import type { DragHintLayout } from '@/lib/asciiAura/dragHint';
import { statusFullyDeleted } from '@/lib/asciiAura/statusText';
import type { DragHintEntry } from './useDragHintStore';

export interface DesiredDragHintPresentation {
  nodeId: string;
  text: DragHintEntry['text'];
  layout: DragHintLayout;
}

export interface DragHintPresentationEntry extends DesiredDragHintPresentation {
  startedAt: number;
  clearedAt: number | null;
}

interface State {
  entry: DragHintPresentationEntry | null;
  reconcile: (desired: DesiredDragHintPresentation | null, now: number) => void;
}

export const useDragHintPresentationStore = create<State>((set, get) => ({
  entry: null,
  reconcile: (desired, now) => {
    const current = get().entry;
    if (desired) {
      const startedAt = !current
        || current.clearedAt != null
        || current.nodeId !== desired.nodeId
        || current.text !== desired.text
        ? now
        : current.startedAt;
      set({
        entry: {
          ...desired,
          startedAt,
          clearedAt: null,
        },
      });
      return;
    }
    if (!current) return;
    const clearedAt = current.clearedAt ?? now;
    set({
      entry: statusFullyDeleted(current.text, clearedAt, now)
        ? null
        : { ...current, clearedAt },
    });
  },
}));
