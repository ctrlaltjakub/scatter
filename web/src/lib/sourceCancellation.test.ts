import { beforeEach, expect, it, vi } from 'vitest';
import type { SourceStagingRecord } from '@/opfs/sourceStagingIO';
import { saveSourceStagingRecord } from '@/opfs/sourceStagingIO';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { embedSourceTexts } from './graniteEmbeddings';
import { extractWebpage } from './sourceExtraction';
import { addPastedSource, addWebpageSources, permanentlyDeleteSource, removeSourceJob, restoreSourceProcessing, waitForProjectSources } from './sourceProcessing';

const records = vi.hoisted(() => new Map<string, SourceStagingRecord>());
vi.mock('@/opfs/sourceStagingIO', () => ({
  saveSourceStagingInput: vi.fn(), loadSourceStagingInput: async () => new Blob(['A passage for indexing.']),
  loadSourceStagingOcrPages: async () => new Map(), saveSourceStagingOcrPage: vi.fn(),
  saveSourceStagingRecord: vi.fn(async (job) => { records.set(job.id, { ...job }); }),
  deleteSourceStagingJob: async (_project: string, id: string) => { records.delete(id); },
  listSourceStagingRecords: async (project: string) => Array.from(records.values()).filter(job => job.projectId === project),
}));
vi.mock('./graniteEmbeddings', () => ({
  GRANITE_EMBEDDING_DIMENSIONS: 384, GRANITE_EMBEDDING_MODEL: 'model', GRANITE_EMBEDDING_REVISION: 'test',
  embedSourceTexts: vi.fn(), isGraniteEmbeddingModelCached: async () => true,
}));
vi.mock('./sourceExtraction', async (original) => ({
  ...await original<typeof import('./sourceExtraction')>(), extractWebpage: vi.fn(),
}));
vi.mock('@/opfs/sourceAssetsIO', () => ({
  saveSourceAsset: vi.fn(), deleteSourceAsset: vi.fn(), loadSourceAsset: async () => new Blob(['asset']),
}));

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { open, promise };
}

beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  const project = createBlankProject('Cancellation', 'root');
  useGraphStore.setState({ project, activeProjectId: project.id });
  useSourceRuntimeStore.setState({ jobs: {}, embeddingStatus: 'ready' });
});

it('ignores late indexing callbacks and a result after cancellation, including after restoring the project', async () => {
  const projectId = useGraphStore.getState().project!.id;
  const started = gate(), finish = gate();
  let progress!: (n: number, total: number) => void | Promise<void>;
  vi.mocked(embedSourceTexts).mockImplementationOnce(async (_texts, options) => {
    progress = options!.onBatchProgress!;
    started.open();
    await finish.promise; // simulate an in-flight inference batch that cannot be interrupted
    return new Float32Array(384);
  });
  const id = await addPastedSource(projectId, 'Cancel me', 'A passage for indexing.');
  await started.promise;
  const waiting = waitForProjectSources(projectId, [id]);
  try {
    await removeSourceJob(id);
    await waiting;
    await progress(1, 1);
    expect(useSourceRuntimeStore.getState().jobs[id]).toBeUndefined();
    expect(records.has(id)).toBe(false);
    await restoreSourceProcessing(projectId);
    expect(useSourceRuntimeStore.getState().jobs[id]).toBeUndefined();
  } finally { finish.open(); }
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(Object.keys(useGraphStore.getState().project!.sourceLibrary?.sources ?? {})).toHaveLength(0);
  expect(useSourceRuntimeStore.getState().embeddingStatus).toBe('ready');
});

it('deletes staging after an already-started progress write, without waiting for inference', async () => {
  const projectId = useGraphStore.getState().project!.id;
  const started = gate(), finish = gate(), writing = gate(), disk = gate();
  let progress!: (n: number, total: number) => void | Promise<void>;
  vi.mocked(embedSourceTexts).mockImplementationOnce(async (_texts, options) => {
    progress = options!.onBatchProgress!;
    started.open();
    await finish.promise;
    return new Float32Array(384);
  });
  const id = await addPastedSource(projectId, 'Delayed write', 'Text.');
  await started.promise;
  vi.mocked(saveSourceStagingRecord).mockImplementationOnce(async job => {
    writing.open();
    await disk.promise;
    records.set(job.id, { ...job });
  });
  const write = progress(1, 2);
  await writing.promise;
  const remove = removeSourceJob(id);
  disk.open();
  try {
    await Promise.all([write, remove, restoreSourceProcessing(projectId)]);
    expect(records.has(id)).toBe(false);
    expect(useSourceRuntimeStore.getState().jobs[id]).toBeUndefined();
  } finally { finish.open(); }
  await new Promise(resolve => setTimeout(resolve, 0));
});

it('deleting a saved webpage cancels its refreshing revision but leaves unrelated sources alone', async () => {
  const project = useGraphStore.getState().project!;
  const url = 'https://example.org/source';
  const source = { id: 'page', title: 'Page', kind: 'webpage' as const, originalUrl: url, checked: true,
    createdAt: 1, contentHash: 'old', activeRevisionId: 'old', revisions: {} };
  const other = { ...source, id: 'other', originalUrl: 'https://example.org/other' };
  useGraphStore.setState({ project: { ...project, sourceLibrary: {
    mode: 'use', order: ['page', 'other'], sources: { page: source, other },
  } } });
  const started = gate(), finish = gate();
  vi.mocked(extractWebpage).mockResolvedValueOnce({ finalUrl: url, retainOriginal: false,
    capturedTitle: 'Updated page', blocks: [{ id: 'a', text: 'Updated text.' }] });
  let signal: AbortSignal | undefined;
  vi.mocked(embedSourceTexts).mockImplementationOnce(async (_texts, options) => {
    signal = options?.signal;
    started.open(); await finish.promise;
    return new Float32Array(384);
  });
  // Redirected URL: the saved source ID must be recognized once extraction completes.
  const [id] = await addWebpageSources(project.id, ['https://example.org/redirect']);
  await started.promise;
  try {
    await permanentlyDeleteSource(project.id, 'page');
    expect(signal?.aborted).toBe(true);
    expect(records.has(id!)).toBe(false);
  } finally { finish.open(); }
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(useGraphStore.getState().project?.sourceLibrary?.sources).toEqual({ other });
});
