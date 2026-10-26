import { create } from 'zustand';
import type { LabelCell } from '@/lib/asciiAura/arrowLabels';
import type { Rect } from '@/lib/asciiAura/sceneState';
import { statusFullyDeleted } from '@/lib/asciiAura/statusText';
import type { GroupLabelTarget } from '@/lib/asciiAura/groupLabels';

export interface GroupLabelEntry {
  text: string;
  groupId: string;
  target: GroupLabelTarget;
  colorSourceNodeId: string;
  rect: Rect;
  cells: LabelCell[];
  startedAt: number;
  clearedAt: number | null;
}

export interface DesiredGroupLabel {
  text: string;
  groupId: string;
  target: GroupLabelTarget;
  colorSourceNodeId: string;
  rect: Rect;
  cells: LabelCell[];
}

interface State {
  entries: Record<string, GroupLabelEntry>;
  reconcile: (desired: Map<string, DesiredGroupLabel>, now: number) => void;
}

export const useGroupLabelStore = create<State>((set, get) => ({
  entries: {},
  reconcile: (desired, now) => {
    const prev = get().entries;
    if (desired.size === 0 && Object.keys(prev).length === 0) return;
    const next: Record<string, GroupLabelEntry> = {};

    for (const [id, label] of desired) {
      const current = prev[id];
      next[id] = {
        ...label,
        startedAt: !current || current.clearedAt != null ? now : current.startedAt,
        clearedAt: null,
      };
    }

    for (const id in prev) {
      if (desired.has(id)) continue;
      const current = prev[id]!;
      const clearedAt = current.clearedAt ?? now;
      if (statusFullyDeleted(current.text, clearedAt, now)) continue;
      next[id] = { ...current, clearedAt };
    }
    set({ entries: next });
  },
}));
