import { create } from 'zustand';

export interface FactCheckRuntimeTask {
  key: string;
  projectId: string;
  nodeId: string;
  versionCreatedAt: number;
  bodyFingerprint: string;
  completed: number;
  total: number;
  running: boolean;
}
interface FactCheckTaskState {
  tasks: Record<string, FactCheckRuntimeTask>;
  setTask: (task: FactCheckRuntimeTask) => void;
  patchTask: (key: string, patch: Partial<FactCheckRuntimeTask>) => void;
  removeTask: (key: string) => void;
}

export const useFactCheckTaskStore = create<FactCheckTaskState>((set) => ({
  tasks: {},
  setTask: (task) => set((state) => ({
    tasks: { ...state.tasks, [task.key]: task },
  })),
  patchTask: (key, patch) => set((state) => {
    const current = state.tasks[key];
    if (!current) return state;
    return { tasks: { ...state.tasks, [key]: { ...current, ...patch } } };
  }),
  removeTask: (key) => set((state) => {
    if (!(key in state.tasks)) return state;
    const tasks = { ...state.tasks };
    delete tasks[key];
    return { tasks };
  }),
}));

export function factCheckTaskKey(nodeId: string, versionCreatedAt: number): string {
  return `${nodeId}:${versionCreatedAt}`;
}
