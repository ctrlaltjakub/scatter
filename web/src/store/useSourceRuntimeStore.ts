import { create } from 'zustand';
import type { SourceStagingRecord } from '@/opfs/sourceStagingIO';

export type EmbeddingRuntimeStatus = 'idle' | 'loading' | 'downloading' | 'ready' | 'failed';

interface SourceRuntimeState {
  jobs: Record<string, SourceStagingRecord>;
  embeddingStatus: EmbeddingRuntimeStatus;
  embeddingProgress: number;
  embeddingError?: string;
  upsertJob: (job: SourceStagingRecord) => void;
  removeJob: (jobId: string) => void;
  replaceProjectJobs: (projectId: string, jobs: SourceStagingRecord[]) => void;
  setEmbedding: (status: EmbeddingRuntimeStatus, progress?: number, error?: string) => void;
}

export const useSourceRuntimeStore = create<SourceRuntimeState>((set) => ({
  jobs: {},
  embeddingStatus: 'idle',
  embeddingProgress: 0,
  upsertJob: (job) => set((state) => ({ jobs: { ...state.jobs, [job.id]: job } })),
  removeJob: (jobId) => set((state) => {
    if (!state.jobs[jobId]) return state;
    const jobs = { ...state.jobs };
    delete jobs[jobId];
    return { jobs };
  }),
  replaceProjectJobs: (projectId, incoming) => set((state) => {
    const jobs = Object.fromEntries(Object.entries(state.jobs).filter(([, job]) => job.projectId !== projectId));
    for (const job of incoming) jobs[job.id] = job;
    return { jobs };
  }),
  setEmbedding: (embeddingStatus, embeddingProgress = 0, embeddingError) => set({
    embeddingStatus,
    embeddingProgress,
    embeddingError,
  }),
}));
