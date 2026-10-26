import { create } from 'zustand';
import type { GroupColor } from './types';

export interface ProjectSyncLabelEntry {
  projectId: string;
  text: string;
  accent: GroupColor | null;
  /** Viewport-space row centre; the renderer converts it into canvas space. */
  anchorViewportY: number;
  startedAt: number;
  clearedAt: number | null;
}

type ShowInput = Pick<ProjectSyncLabelEntry, 'projectId' | 'text' | 'accent' | 'anchorViewportY'>;

interface State {
  entries: Record<string, ProjectSyncLabelEntry>;
  show: (input: ShowInput) => void;
  clear: (projectId: string) => void;
  remove: (projectId: string) => void;
}

const nowMs = (): number => typeof performance !== 'undefined' ? performance.now() : Date.now();

export const useProjectSyncLabelStore = create<State>((set, get) => ({
  entries: {},
  show: (input) => {
    const now = nowMs();
    const previous = get().entries;
    const current = previous[input.projectId];
    const next: Record<string, ProjectSyncLabelEntry> = {};
    for (const [projectId, entry] of Object.entries(previous)) {
      if (projectId === input.projectId) continue;
      next[projectId] = { ...entry, clearedAt: entry.clearedAt ?? now };
    }
    next[input.projectId] = {
      ...input,
      startedAt: current && current.clearedAt == null && current.text === input.text
        ? current.startedAt
        : now,
      clearedAt: null,
    };
    set({ entries: next });
  },
  clear: (projectId) => {
    const current = get().entries[projectId];
    if (!current || current.clearedAt != null) return;
    set((state) => ({
      entries: {
        ...state.entries,
        [projectId]: { ...current, clearedAt: nowMs() },
      },
    }));
  },
  remove: (projectId) => {
    set((state) => {
      if (!state.entries[projectId]) return state;
      const entries = { ...state.entries };
      delete entries[projectId];
      return { entries };
    });
  },
}));
