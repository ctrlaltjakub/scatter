'use client';

import { newId } from './ids';
import type {
  NormalizedSourceDocument,
  ProjectSource,
  ProjectSourceKind,
  ProjectSourceRevision,
  SourceBlock,
} from '@/store/types';
import {
  deleteSourceStagingJob,
  listSourceStagingRecords,
  loadSourceStagingInput,
  loadSourceStagingOcrPages,
  saveSourceStagingOcrPage,
  saveSourceStagingInput,
  saveSourceStagingRecord,
  type SourceStagingRecord,
  type SourceStagingStatus,
} from '@/opfs/sourceStagingIO';
import { deleteSourceAsset, loadSourceAsset, saveSourceAsset } from '@/opfs/sourceAssetsIO';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { extractSourceBlob, extractWebpage, sourceKindForFile } from './sourceExtraction';
import { buildKeywordIndex, chunkSourceBlocks } from './sourceIndexing';
import {
  encodeEmbeddingIndex,
  encodeKeywordIndex,
  encodeSourceDocument,
} from './sourceCodec';
import {
  GRANITE_EMBEDDING_DIMENSIONS,
  GRANITE_EMBEDDING_MODEL,
  GRANITE_EMBEDDING_REVISION,
  embedSourceTexts,
  isGraniteEmbeddingModelCached,
} from './graniteEmbeddings';
import {
  findDuplicateSource,
  sha256Blob,
  sha256Text,
  sourceAssetIds,
  sourceLibrary,
  uniqueSourceTitle,
} from './projectSources';
import {
  mutateSourceLibraryWithoutHistory,
  publishProjectSource,
  readProjectForSources,
  removeProjectSource,
} from './sourceProjectMutations';
import { withSourceMode } from './projectSources';

const activeJobs = new Map<string, AbortController>();
const queuedJobs: string[] = [];
const MAX_SOURCE_JOBS = 2;
let runningJobs = 0;
let embeddingWarmup: Promise<void> | null = null;
// Serialize only the small staging writes/reads, not extraction or inference.
// A delete must be the last disk operation for its job, including on reload.
const stagingTails = new Map<string, Promise<unknown>>();
const removingJobs = new Set<string>();
function inStagingOrder<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  const tail = stagingTails.get(projectId) ?? Promise.resolve();
  const next = tail.then(operation, operation);
  stagingTails.set(projectId, next);
  const release = () => { if (stagingTails.get(projectId) === next) stagingTails.delete(projectId); };
  void next.then(release, release);
  return next;
}

/** Don't hold an import slot while a cancelled job waits for a shared download. */
function waitForEmbeddingModel(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void prepareSourceEmbeddingModel().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Begin the browser-local Granite download as soon as a project with sources
 * is known. It is shared with indexing and intentionally never blocks UI. */
export function prepareSourceEmbeddingModel(): Promise<void> {
  if (useSourceRuntimeStore.getState().embeddingStatus === 'ready') return Promise.resolve();
  if (embeddingWarmup) return embeddingWarmup;
  embeddingWarmup = (async () => {
    const cached = await isGraniteEmbeddingModelCached();
    useSourceRuntimeStore.getState().setEmbedding(cached ? 'loading' : 'downloading', 0);
    try {
      await embedSourceTexts(['Scatter project source search'], {
        onProgress: (progress) => {
          if (!cached) useSourceRuntimeStore.getState().setEmbedding('downloading', progress);
        },
      });
      useSourceRuntimeStore.getState().setEmbedding('ready', 100);
    } catch (error) {
      useSourceRuntimeStore.getState().setEmbedding(
        'failed',
        0,
        error instanceof Error ? error.message : String(error),
      );
    }
  })().finally(() => { embeddingWarmup = null; });
  return embeddingWarmup;
}

function checkpoint(job: SourceStagingRecord, signal: AbortSignal, patch: Partial<SourceStagingRecord>, beforeSave?: () => Promise<void>) {
  if (signal.aborted) return Promise.resolve();
  const next = { ...job, ...patch };
  Object.assign(job, next);
  useSourceRuntimeStore.getState().upsertJob(next);
  return inStagingOrder(job.projectId, async () => {
    if (signal.aborted) return;
    if (beforeSave) await beforeSave();
    if (!signal.aborted) await saveSourceStagingRecord(next);
  });
}

function setJobStatus(job: SourceStagingRecord, signal: AbortSignal, status: SourceStagingStatus, error?: string) {
  return checkpoint(job, signal, {
    status,
    statusDetail: status === 'fetching' ? job.statusDetail : undefined,
    waitingForConnection: undefined,
    error,
  });
}

function browserIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function waitForConnection(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!browserIsOffline()) return;
  await new Promise<void>((resolve, reject) => {
    const online = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => {
      window.removeEventListener('online', online);
      signal.removeEventListener('abort', abort);
    };
    window.addEventListener('online', online, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function pauseJobForConnection(job: SourceStagingRecord, signal: AbortSignal): Promise<void> {
  await checkpoint(job, signal, {
    status: 'queued',
    statusDetail: undefined,
    waitingForConnection: true,
    error: undefined,
  });
  await waitForConnection(signal);
  job.waitingForConnection = undefined;
}

function enqueue(jobId: string): void {
  if (!queuedJobs.includes(jobId) && !activeJobs.has(jobId)) queuedJobs.push(jobId);
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  while (runningJobs < MAX_SOURCE_JOBS && queuedJobs.length > 0) {
    const jobId = queuedJobs.shift();
    if (!jobId) continue;
    const job = useSourceRuntimeStore.getState().jobs[jobId];
    if (!job || job.status === 'failed' || removingJobs.has(jobId)) continue;
    const controller = new AbortController();
    activeJobs.set(jobId, controller);
    runningJobs += 1;
    void processSourceJob(job, controller.signal).finally(() => {
      activeJobs.delete(jobId);
      runningJobs -= 1;
      void drainQueue();
    });
  }
}

function blocksText(blocks: readonly SourceBlock[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

async function processSourceJob(job: SourceStagingRecord, signal: AbortSignal): Promise<void> {
  const writtenAssets: string[] = [];
  const writeAsset = async (id: string, blob: Blob) => {
    signal.throwIfAborted();
    writtenAssets.push(id);
    await saveSourceAsset(job.projectId, id, blob);
  };
  try {
    if (job.waitingForConnection) await pauseJobForConnection(job, signal);
    let input = await loadSourceStagingInput(job.projectId, job.id);
    signal.throwIfAborted();
    let blocks: SourceBlock[];
    let retainOriginal = false;
    let pageCount: number | undefined;
    let title = job.title;
    let finalUrl = job.originalUrl;
    if (job.kind === 'webpage') {
      job.statusDetail = 'fetch-direct';
      await setJobStatus(job, signal, 'fetching');
      const extracted = await extractWebpage(job.originalUrl ?? '', signal, async (statusDetail) => {
        job.statusDetail = statusDetail;
        await setJobStatus(job, signal, 'fetching');
      });
      blocks = extracted.blocks;
      retainOriginal = false;
      pageCount = extracted.pageCount;
      title = extracted.capturedTitle || title;
      finalUrl = extracted.finalUrl;
      input = new Blob([blocksText(blocks)], { type: 'text/plain' });
    } else {
      if (!input) throw new Error('The local source file is no longer available. Add it again.');
      await setJobStatus(job, signal, job.kind === 'image' ? 'ocr' : 'extracting');
      const completedOcrPages = await loadSourceStagingOcrPages(job.projectId, job.id);
      const extracted = await extractSourceBlob(input, job.kind, signal, (progress) => {
        // Persist the transcription before marking the page done so resuming
        // does not pay for a completed page twice.
        return checkpoint(job, signal, {
          status: 'ocr', pageCount: progress.pageCount, completedPages: progress.completedPages, error: undefined,
        }, () => saveSourceStagingOcrPage(job.projectId, job.id, progress.page, progress.text));
      }, completedOcrPages);
      blocks = extracted.blocks;
      retainOriginal = extracted.retainOriginal;
      pageCount = extracted.pageCount;
    }
    signal.throwIfAborted();
    if (!blocks.some((block) => block.text.trim())) throw new Error('No readable text was found in this source.');

    const project = await readProjectForSources(job.projectId);
    if (!project) throw new Error('The destination project no longer exists.');
    const library = sourceLibrary(project);
    const contentHash = job.kind === 'webpage'
      ? await sha256Text(blocksText(blocks))
      : await sha256Blob(input!);
    const sameUrl = job.kind === 'webpage' && finalUrl
      ? Object.values(library.sources).find((source) => source.originalUrl === finalUrl)
      : undefined;
    const duplicate = findDuplicateSource(library, contentHash);
    // Re-adding a webpage is the deliberate refresh mechanism. Even unchanged
    // text receives a new immutable capture revision; exact duplicate local
    // files continue to collapse into the existing source.
    if (duplicate && !sameUrl) {
      await inStagingOrder(job.projectId, () => deleteSourceStagingJob(job.projectId, job.id));
      useSourceRuntimeStore.getState().removeJob(job.id);
      return;
    }

    signal.throwIfAborted();
    if (sameUrl) job.sourceId = sameUrl.id;
    await setJobStatus(job, signal, 'indexing');
    const revisionId = newId();
    const chunks = chunkSourceBlocks(blocks);
    if (!chunks.length) throw new Error('No searchable passages could be prepared from this source.');
    const document: NormalizedSourceDocument = {
      schemaVersion: 1,
      revisionId,
      title,
      blocks,
      chunks,
    };
    const keyword = buildKeywordIndex(chunks);
    let embeddingValues: Float32Array | null = null;
    try {
      await checkpoint(job, signal, { status: 'indexing', indexingCompleted: 0, indexingTotal: chunks.length });
      await waitForEmbeddingModel(signal);
      signal.throwIfAborted();
      if (useSourceRuntimeStore.getState().embeddingStatus !== 'ready') {
        throw new Error(useSourceRuntimeStore.getState().embeddingError ?? 'The embedding model is unavailable.');
      }
      embeddingValues = await embedSourceTexts(chunks.map((chunk) => chunk.text), {
        signal,
        onBatchProgress: (completed, total) => checkpoint(job, signal, { indexingCompleted: completed, indexingTotal: total }),
      });
    } catch (error) {
      signal.throwIfAborted(); // cancelling one import is not a shared embedding-model failure
      useSourceRuntimeStore.getState().setEmbedding(
        'failed',
        0,
        error instanceof Error ? error.message : String(error),
      );
    }

    signal.throwIfAborted();
    const contentAssetId = newId();
    const keywordIndexAssetId = newId();
    const embeddingIndexAssetId = embeddingValues ? newId() : undefined;
    const originalAssetId = retainOriginal ? newId() : undefined;
    await writeAsset(contentAssetId, await encodeSourceDocument(document));
    await writeAsset(keywordIndexAssetId, encodeKeywordIndex(keyword));
    if (embeddingValues && embeddingIndexAssetId) {
      await writeAsset(embeddingIndexAssetId, encodeEmbeddingIndex({
        schemaVersion: 1,
        model: GRANITE_EMBEDDING_MODEL,
        revision: GRANITE_EMBEDDING_REVISION,
        dimensions: GRANITE_EMBEDDING_DIMENSIONS,
        chunkIds: chunks.map((chunk) => chunk.id),
        values: embeddingValues,
      }));
    }
    if (originalAssetId && input) {
      await writeAsset(originalAssetId, input);
    }
    for (const assetId of writtenAssets) {
      signal.throwIfAborted();
      if (!await loadSourceAsset(job.projectId, assetId)) throw new Error('A prepared source asset could not be verified.');
    }

    const sourceId = sameUrl?.id ?? job.sourceId ?? newId();
    const revision: ProjectSourceRevision = {
      id: revisionId,
      createdAt: Date.now(),
      status: 'ready',
      captureDate: job.kind === 'webpage' ? Date.now() : undefined,
      mimeType: job.mimeType,
      pageCount,
      contentAssetId,
      keywordIndexAssetId,
      embeddingIndexAssetId,
      originalAssetId,
      index: {
        formatVersion: 1,
        embeddingModel: GRANITE_EMBEDDING_MODEL,
        embeddingRevision: GRANITE_EMBEDDING_REVISION,
        dimensions: GRANITE_EMBEDDING_DIMENSIONS,
      },
    };
    const source: ProjectSource = sameUrl ? {
      ...sameUrl,
      title,
      contentHash,
      activeRevisionId: revisionId,
      revisions: { ...sameUrl.revisions, [revisionId]: revision },
      checked: true,
    } : {
      id: sourceId,
      title: uniqueSourceTitle(library, title),
      kind: job.kind,
      checked: true,
      createdAt: Date.now(),
      contentHash,
      activeRevisionId: revisionId,
      revisions: { [revisionId]: revision },
      originalUrl: finalUrl,
    };
    signal.throwIfAborted();
    const published = await publishProjectSource(job.projectId, source, signal, Boolean(sameUrl));
    if (published?.sourceLibrary?.sources[sourceId]?.revisions[revisionId]) writtenAssets.length = 0;
    await inStagingOrder(job.projectId, () => deleteSourceStagingJob(job.projectId, job.id));
    useSourceRuntimeStore.getState().removeJob(job.id);
  } catch (error) {
    if (signal.aborted || (error as Error)?.name === 'AbortError') return;
    // Browsers can report a clean offline state without a useful network error.
    // Keep the row pending and resume invisibly when connectivity returns,
    // instead of asking the user to retry a healthy source by hand.
    if (browserIsOffline() && ['webpage', 'image', 'pdf'].includes(job.kind)) {
      try {
        await pauseJobForConnection(job, signal);
      } catch (pauseError) {
        if ((pauseError as Error)?.name === 'AbortError') return;
        throw pauseError;
      }
      if (!signal.aborted) await processSourceJob(job, signal);
      return;
    }
    await setJobStatus(job, signal, 'failed', error instanceof Error ? error.message : String(error));
  } finally {
    for (const assetId of writtenAssets) await deleteSourceAsset(job.projectId, assetId).catch(() => undefined);
  }
}

async function createJob(options: {
  projectId: string;
  title: string;
  kind: ProjectSourceKind;
  input?: Blob;
  originalUrl?: string;
  mimeType?: string;
}): Promise<string> {
  const record: SourceStagingRecord = {
    schemaVersion: 1,
    id: newId(),
    projectId: options.projectId,
    title: options.title,
    kind: options.kind,
    status: 'queued',
    createdAt: Date.now(),
    checkedOnSuccess: true,
    sourceId: newId(),
    originalUrl: options.originalUrl,
    mimeType: options.mimeType,
  };
  await inStagingOrder(record.projectId, async () => {
    if (options.input) await saveSourceStagingInput(record.projectId, record.id, options.input);
    await saveSourceStagingRecord(record);
    useSourceRuntimeStore.getState().upsertJob(record);
  });
  // The first queued source is already the user's explicit choice to use
  // project material. Set the remembered policy now rather than waiting until
  // extraction finishes, so a generation started in the meantime can wait for
  // this exact import instead of silently behaving as Ignore.
  await mutateSourceLibraryWithoutHistory(record.projectId, (library) => (
    Object.keys(library.sources).length === 0 && library.mode === 'ignore'
      ? withSourceMode(library, 'use')
      : library
  ));
  enqueue(record.id);
  return record.id;
}

export async function addSourceFiles(projectId: string, files: readonly File[]): Promise<string[]> {
  const jobs: string[] = [];
  for (const file of files) {
    const kind = sourceKindForFile(file);
    if (!kind) continue;
    jobs.push(await createJob({
      projectId,
      title: file.name,
      kind,
      input: file,
      mimeType: file.type,
    }));
  }
  return jobs;
}

export async function addPastedSource(projectId: string, title: string, text: string): Promise<string> {
  return createJob({
    projectId,
    title: title.trim() || 'Pasted text',
    kind: 'text',
    input: new Blob([text], { type: 'text/plain' }),
    mimeType: 'text/plain',
  });
}

export async function addWebpageSources(projectId: string, urls: readonly string[]): Promise<string[]> {
  const jobs: string[] = [];
  for (const value of urls.map((url) => url.trim()).filter(Boolean)) {
    let title = value;
    try { title = new URL(value).hostname; } catch { /* processing reports the useful URL error */ }
    jobs.push(await createJob({ projectId, title, kind: 'webpage', originalUrl: value }));
  }
  return jobs;
}

export async function restoreSourceProcessing(projectId: string): Promise<void> {
  await inStagingOrder(projectId, async () => {
    const jobs = (await listSourceStagingRecords(projectId)).filter(job => !removingJobs.has(job.id));
    const runtime = useSourceRuntimeStore.getState();
    runtime.replaceProjectJobs(projectId, jobs.map(job => runtime.jobs[job.id] ?? job));
    for (const job of jobs) if (job.status !== 'failed') enqueue(job.id);
  });
}

export async function waitForProjectSources(
  projectId: string,
  jobIds?: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const selected = jobIds?.length ? new Set(jobIds) : null;
  const unsettled = () => Object.values(useSourceRuntimeStore.getState().jobs).some((job) => (
    job.projectId === projectId
    && job.checkedOnSuccess
    && job.status !== 'failed'
    && (!selected || selected.has(job.id))
  ));
  if (!unsettled()) return;
  await new Promise<void>((resolve, reject) => {
    const unsubscribe = useSourceRuntimeStore.subscribe(() => {
      if (!unsettled()) {
        unsubscribe();
        signal?.removeEventListener('abort', abort);
        resolve();
      }
    });
    const abort = () => {
      unsubscribe();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function retrySourceJob(jobId: string): Promise<void> {
  const job = useSourceRuntimeStore.getState().jobs[jobId];
  if (!job) return;
  const next = {
    ...job,
    status: 'queued' as const,
    error: undefined,
    waitingForConnection: undefined,
    indexingCompleted: undefined,
    indexingTotal: undefined,
  };
  await inStagingOrder(job.projectId, async () => {
    if (removingJobs.has(jobId) || !useSourceRuntimeStore.getState().jobs[jobId]) return;
    await saveSourceStagingRecord(next);
    if (!removingJobs.has(jobId)) {
      useSourceRuntimeStore.getState().upsertJob(next);
      enqueue(jobId);
    }
  });
}

export async function removeSourceJob(jobId: string): Promise<void> {
  const job = useSourceRuntimeStore.getState().jobs[jobId];
  if (!job) return;
  removingJobs.add(jobId);
  activeJobs.get(jobId)?.abort();
  const index = queuedJobs.indexOf(jobId);
  if (index !== -1) queuedJobs.splice(index, 1);
  useSourceRuntimeStore.getState().removeJob(job.id);
  try {
    await inStagingOrder(job.projectId, () => deleteSourceStagingJob(job.projectId, job.id));
  } catch {
    useSourceRuntimeStore.getState().upsertJob({ ...job, status: 'failed', error: 'Could not remove the local import. Try removing it again.' });
  } finally {
    removingJobs.delete(jobId);
  }
}

export async function permanentlyDeleteSource(projectId: string, sourceId: string): Promise<void> {
  const project = await readProjectForSources(projectId);
  const source = project?.sourceLibrary?.sources[sourceId];
  if (!source) return;
  // Removing a saved webpage also cancels its pending refresh, without
  // disturbing imports of the same URL in other projects.
  const refreshes = Object.values(useSourceRuntimeStore.getState().jobs).filter(job =>
    job.projectId === projectId && (job.sourceId === sourceId || (source.originalUrl && job.originalUrl === source.originalUrl)));
  await Promise.all(refreshes.map(job => removeSourceJob(job.id)));
  const ids = sourceAssetIds({ mode: 'ignore', order: [sourceId], sources: { [sourceId]: source } });
  await removeProjectSource(projectId, sourceId);
  for (const assetId of [...ids.eager, ...ids.lazy]) await deleteSourceAsset(projectId, assetId);
}
