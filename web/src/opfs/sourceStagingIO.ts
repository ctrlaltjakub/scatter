import type { ProjectSourceKind } from '@/store/types';
import { deleteFile, listDir, readBlob, readJSON, removeDir, writeBlob, writeJSON } from './storage';

export type SourceStagingStatus =
  | 'queued'
  | 'fetching'
  | 'extracting'
  | 'ocr'
  | 'indexing'
  | 'failed';

export interface SourceStagingRecord {
  schemaVersion: 1;
  id: string;
  projectId: string;
  title: string;
  kind: ProjectSourceKind;
  status: SourceStagingStatus;
  /** Concrete sub-step shown in the manager without changing queue logic. */
  statusDetail?: 'fetch-direct' | 'fetch-jina';
  waitingForConnection?: boolean;
  createdAt: number;
  checkedOnSuccess: boolean;
  sourceId?: string;
  originalUrl?: string;
  mimeType?: string;
  completedPages?: number[];
  pageCount?: number;
  indexingCompleted?: number;
  indexingTotal?: number;
  error?: string;
}

const jobPath = (projectId: string, jobId: string) => `source-staging/${projectId}/${jobId}`;
const recordPath = (projectId: string, jobId: string) => `${jobPath(projectId, jobId)}/job.json`;
const inputPath = (projectId: string, jobId: string) => `${jobPath(projectId, jobId)}/input`;
const ocrPageDir = (projectId: string, jobId: string) => `${jobPath(projectId, jobId)}/ocr-pages`;
const ocrPagePath = (projectId: string, jobId: string, page: number) => `${ocrPageDir(projectId, jobId)}/${page}.txt`;

export async function saveSourceStagingRecord(record: SourceStagingRecord): Promise<void> {
  await writeJSON(recordPath(record.projectId, record.id), record);
}

export async function loadSourceStagingRecord(
  projectId: string,
  jobId: string,
): Promise<SourceStagingRecord | null> {
  return readJSON<SourceStagingRecord>(recordPath(projectId, jobId));
}

export async function listSourceStagingRecords(projectId: string): Promise<SourceStagingRecord[]> {
  const records = await Promise.all((await listDir(`source-staging/${projectId}`)).map((jobId) => (
    loadSourceStagingRecord(projectId, jobId)
  )));
  return records.filter((record): record is SourceStagingRecord => Boolean(record));
}

export async function saveSourceStagingInput(
  projectId: string,
  jobId: string,
  blob: Blob,
): Promise<void> {
  await writeBlob(inputPath(projectId, jobId), blob);
}

export async function loadSourceStagingInput(projectId: string, jobId: string): Promise<Blob | null> {
  return readBlob(inputPath(projectId, jobId));
}

export async function deleteSourceStagingInput(projectId: string, jobId: string): Promise<void> {
  await deleteFile(inputPath(projectId, jobId));
}

export async function saveSourceStagingOcrPage(
  projectId: string,
  jobId: string,
  page: number,
  text: string,
): Promise<void> {
  await writeBlob(ocrPagePath(projectId, jobId, page), new Blob([text], { type: 'text/plain' }));
}

export async function loadSourceStagingOcrPages(
  projectId: string,
  jobId: string,
): Promise<Map<number, string>> {
  const pages = new Map<number, string>();
  for (const filename of await listDir(ocrPageDir(projectId, jobId))) {
    const page = Number.parseInt(filename.replace(/\.txt$/i, ''), 10);
    if (!Number.isFinite(page) || page < 1) continue;
    const blob = await readBlob(`${ocrPageDir(projectId, jobId)}/${filename}`);
    if (blob) pages.set(page, await blob.text());
  }
  return pages;
}

export async function deleteSourceStagingJob(projectId: string, jobId: string): Promise<void> {
  await removeDir(jobPath(projectId, jobId));
}
