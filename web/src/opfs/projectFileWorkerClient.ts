import { readJSON, writeJSON } from './storage';
import type { Project } from '@/store/types';
import type {
  ProjectFilePatch,
  ProjectFileRequest,
  ProjectFileResponse,
} from './projectPersistenceProtocol';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  streamed?: {
    base: Record<string, unknown>;
    nodes: Record<string, unknown>;
  };
};

let projectFileWorker: Worker | null | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function stopWorker(error: Error): void {
  projectFileWorker?.terminate();
  projectFileWorker = null;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getWorker(): Worker | null {
  if (projectFileWorker !== undefined) return projectFileWorker;
  // Tests, server rendering, and older browsers use the existing main-thread
  // implementation. Do not cache this case because a test may install Worker
  // after the module has already been used.
  if (typeof Worker === 'undefined') return null;

  try {
    const worker = new Worker(new URL('./projectFile.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<ProjectFileResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      if (!request) return;
      if (!response.ok) {
        pending.delete(response.id);
        request.reject(new Error(response.error || 'Project file worker failed'));
        return;
      }

      if (response.phase === 'start') {
        request.streamed = {
          base: (response.value ?? {}) as Record<string, unknown>,
          nodes: {},
        };
        continueReadAfterPaint(response.id);
        return;
      }
      if (response.phase === 'nodes') {
        const entries = response.value as Array<[string, unknown]>;
        const streamed = request.streamed;
        if (!streamed || !Array.isArray(entries)) {
          pending.delete(response.id);
          request.reject(new Error('Project file worker returned an invalid node batch'));
          return;
        }
        for (const [id, node] of entries) streamed.nodes[id] = node;
        continueReadAfterPaint(response.id);
        return;
      }
      if (response.phase === 'complete') {
        pending.delete(response.id);
        const streamed = request.streamed;
        if (!streamed) {
          request.reject(new Error('Project file worker completed without project metadata'));
          return;
        }
        request.resolve({ ...streamed.base, nodes: streamed.nodes });
        return;
      }

      pending.delete(response.id);
      request.resolve(response.value);
    };
    worker.onerror = (event) => {
      stopWorker(new Error(event.message || 'Project file worker crashed'));
    };
    worker.onmessageerror = () => {
      stopWorker(new Error('Project file worker returned unreadable data'));
    };
    projectFileWorker = worker;
    return worker;
  } catch {
    projectFileWorker = null;
    return null;
  }
}

/**
 * Acknowledge the next streamed node batch only after the browser has had a
 * chance to paint. Hidden tabs do not run rAF reliably, so they fall back to a
 * task-yield instead of leaving restoration stuck forever.
 */
function continueReadAfterPaint(id: number): void {
  const send = () => projectFileWorker?.postMessage({ id, type: 'continue-read' } satisfies ProjectFileRequest);
  if (
    typeof document !== 'undefined'
    && !document.hidden
    && typeof requestAnimationFrame === 'function'
  ) {
    requestAnimationFrame(() => send());
  } else {
    setTimeout(send, 0);
  }
}

function sendToWorker<T>(request: Omit<ProjectFileRequest, 'id'>): Promise<T> | null {
  const worker = getWorker();
  if (!worker) return null;

  const id = nextRequestId++;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
  });
  worker.postMessage({ ...request, id } satisfies ProjectFileRequest);
  return promise;
}

/** Read and parse a large JSON file away from React and the canvas thread. */
export async function readLargeJSON<T>(path: string): Promise<T | null> {
  const task = sendToWorker<T | null>({ type: 'read', path });
  if (!task) return readJSON<T>(path);
  try {
    return await task;
  } catch {
    // Preserve compatibility if OPFS-in-a-worker is unavailable in a browser.
    return readJSON<T>(path);
  }
}

/** Convert and write a large JSON file away from React and the canvas thread. */
export async function writeLargeJSON(path: string, data: unknown): Promise<void> {
  const task = sendToWorker<null>({
    type: 'write',
    path,
    data: data as Project,
  });
  if (!task) return writeJSON(path, data);
  try {
    await task;
  } catch {
    // Preserve compatibility if OPFS-in-a-worker is unavailable in a browser.
    await writeJSON(path, data);
  }
}

/**
 * Apply a small immutable graph delta to the worker's in-memory project.
 * Returns false when the worker is unavailable or rejected the patch so the
 * caller can fall back to a complete main-thread save.
 */
export async function patchLargeProject(
  path: string,
  patch: ProjectFilePatch,
): Promise<boolean> {
  const task = sendToWorker<null>({
    type: 'patch',
    path,
    patch,
    revision: patch.revision,
  });
  if (!task) return false;
  try {
    await task;
    return true;
  } catch {
    return false;
  }
}

/** Serialize and write the worker mirror after all earlier patches. */
export async function flushLargeProject(
  path: string,
  revision: number,
): Promise<boolean> {
  const task = sendToWorker<null>({ type: 'flush', path, revision });
  if (!task) return false;
  try {
    await task;
    return true;
  } catch {
    return false;
  }
}

/** Release a non-active project mirror after its queued operations settle. */
export async function evictLargeProject(path: string): Promise<void> {
  const task = sendToWorker<null>({ type: 'evict', path });
  if (!task) return;
  try {
    await task;
  } catch {
    // Eviction is only a memory optimization. A stopped worker has already
    // released every mirror, while a later read safely replaces stale data.
  }
}
