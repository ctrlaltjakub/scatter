import { create } from 'zustand';
import type { FreeImageRecommendation, FreeImageSourceOutcome } from './types';

export interface WikimediaTask {
  running: boolean;
  loadingMore?: boolean;
  error?: string;
  /** Runtime results are used while a successful run is being committed. */
  results?: FreeImageRecommendation[];
  sourceOutcomes?: FreeImageSourceOutcome[];
  startedAt: number;
}

interface WikimediaTaskState {
  tasks: Record<string, WikimediaTask>;
  setTask: (key: string, task: WikimediaTask) => void;
  patchTask: (key: string, patch: Partial<WikimediaTask>) => void;
  clearTask: (key: string) => void;
}

export function wikimediaTaskKey(nodeId: string, versionCreatedAt: number): string {
  return `${nodeId}:${versionCreatedAt}`;
}

export const useWikimediaTaskStore = create<WikimediaTaskState>((set) => ({
  tasks: {},
  setTask: (key, task) => set((state) => ({ tasks: { ...state.tasks, [key]: task } })),
  patchTask: (key, patch) => set((state) => {
    const current = state.tasks[key];
    if (!current) return state;
    return { tasks: { ...state.tasks, [key]: { ...current, ...patch } } };
  }),
  clearTask: (key) => set((state) => {
    if (!(key in state.tasks)) return state;
    const tasks = { ...state.tasks };
    delete tasks[key];
    return { tasks };
  }),
}));
