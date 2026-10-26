import type { Project } from '@/store/types';
import type {
  ProjectFileRequest,
  ProjectFileResponse,
} from './projectPersistenceProtocol';
import {
  applyProjectFilePatch,
  stripTransientProject,
} from './projectPersistenceApply';

const worker = self as unknown as DedicatedWorkerGlobalScope;
const PROJECT_NODE_CHUNK_SIZE = 32;
const readContinuations = new Map<number, () => void>();
const mirrors = new Map<string, { project: Project; revision: number }>();
const pathQueues = new Map<string, Promise<void>>();

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

async function resolvePath(
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error(`Invalid path: ${path}`);
  let dir = await root();
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return { dir, name };
}

async function readProjectFile(path: string): Promise<unknown | null> {
  try {
    const { dir, name } = await resolvePath(path, false);
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as unknown;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

async function writeProjectFile(path: string, data: unknown): Promise<void> {
  const { dir, name } = await resolvePath(path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(data));
  await writable.close();
}

function queueForPath<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = pathQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  pathQueues.set(path, current.then(() => undefined, () => undefined));
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waitForReadContinuation(id: number): Promise<void> {
  return new Promise((resolve) => readContinuations.set(id, resolve));
}

/**
 * Large projects cross the worker boundary in small node batches. The main
 * thread acknowledges each batch after a paint, preventing one giant
 * structured-clone task from freezing the restoration animation.
 */
async function postReadResult(id: number, value: unknown | null): Promise<void> {
  if (!isRecord(value) || !isRecord(value.nodes)) {
    worker.postMessage({ id, ok: true, value } satisfies ProjectFileResponse);
    return;
  }

  const entries = Object.entries(value.nodes);
  if (entries.length <= PROJECT_NODE_CHUNK_SIZE) {
    worker.postMessage({ id, ok: true, value } satisfies ProjectFileResponse);
    return;
  }

  const { nodes: _nodes, ...base } = value;
  worker.postMessage({ id, ok: true, phase: 'start', value: base } satisfies ProjectFileResponse);
  await waitForReadContinuation(id);
  for (let start = 0; start < entries.length; start += PROJECT_NODE_CHUNK_SIZE) {
    worker.postMessage({
      id,
      ok: true,
      phase: 'nodes',
      value: entries.slice(start, start + PROJECT_NODE_CHUNK_SIZE),
    } satisfies ProjectFileResponse);
    await waitForReadContinuation(id);
  }
  worker.postMessage({ id, ok: true, phase: 'complete' } satisfies ProjectFileResponse);
}

async function mirrorFor(path: string): Promise<{ project: Project; revision: number }> {
  const cached = mirrors.get(path);
  if (cached) return cached;
  const value = await readProjectFile(path);
  if (!isRecord(value) || !isRecord(value.nodes) || !isRecord(value.arrows) || !isRecord(value.groups)) {
    throw new Error('Project file worker has no base project for this patch');
  }
  const mirror = { project: value as unknown as Project, revision: 0 };
  mirrors.set(path, mirror);
  return mirror;
}

async function handleRequest(request: ProjectFileRequest): Promise<void> {
  if (!request.path) throw new Error('Project file worker request is missing a path');
  const path = request.path;

  if (request.type === 'read') {
    const value = await readProjectFile(path);
    if (isRecord(value) && isRecord(value.nodes) && isRecord(value.arrows) && isRecord(value.groups)) {
      mirrors.set(path, { project: value as unknown as Project, revision: 0 });
    } else {
      mirrors.delete(path);
    }
    await postReadResult(request.id, value);
    return;
  }

  if (request.type === 'write') {
    if (!request.data) throw new Error('Project file worker write is missing data');
    mirrors.set(path, {
      project: request.data,
      revision: request.revision ?? 0,
    });
    await writeProjectFile(path, stripTransientProject(request.data));
    return;
  }

  if (request.type === 'patch') {
    if (!request.patch) throw new Error('Project file worker patch is missing data');
    let mirror = await mirrorFor(path);
    if (request.patch.revision > mirror.revision) {
      mirror = {
        project: applyProjectFilePatch(mirror.project, request.patch),
        revision: request.patch.revision,
      };
      mirrors.set(path, mirror);
    }
    return;
  }

  if (request.type === 'flush') {
    const mirror = await mirrorFor(path);
    await writeProjectFile(path, stripTransientProject(mirror.project));
    return;
  }

  if (request.type === 'evict') {
    mirrors.delete(path);
  }
}

worker.onmessage = (event: MessageEvent<ProjectFileRequest>) => {
  const request = event.data;
  if (request.type === 'continue-read') {
    const resume = readContinuations.get(request.id);
    if (resume) {
      readContinuations.delete(request.id);
      resume();
    }
    return;
  }

  if (!request.path) {
    worker.postMessage({
      id: request.id,
      ok: false,
      error: 'Project file worker request is missing a path',
    } satisfies ProjectFileResponse);
    return;
  }

  void queueForPath(request.path, () => handleRequest(request)).then(
    () => {
      if (request.type === 'read') return;
      worker.postMessage({ id: request.id, ok: true, value: null } satisfies ProjectFileResponse);
    },
    (error: unknown) => {
      readContinuations.delete(request.id);
      worker.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ProjectFileResponse);
    },
  );
};

export {};
