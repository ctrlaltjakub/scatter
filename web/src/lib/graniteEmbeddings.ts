'use client';

import {
  GRANITE_EMBEDDING_DIMENSIONS,
  GRANITE_EMBEDDING_MODEL,
  GRANITE_EMBEDDING_REVISION,
  runGraniteEmbedding,
} from './graniteEmbeddingEngine';

export {
  GRANITE_EMBEDDING_DIMENSIONS,
  GRANITE_EMBEDDING_MODEL,
  GRANITE_EMBEDDING_REVISION,
};

// Transformers.js needs the browser-ready ONNX conversion. The IBM repository
// contains the source model, but not the `onnx/model_quantized.onnx` file the
// browser runtime requests for `dtype: 'q8'`.
const GRANITE_QUANTIZED_MODEL_URL = `https://huggingface.co/${GRANITE_EMBEDDING_MODEL}/resolve/${GRANITE_EMBEDDING_REVISION}/onnx/model_quantized.onnx`;

type EmbedOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  onBatchProgress?: (completed: number, total: number) => void | Promise<void>;
  batchSize?: number;
};

type WorkerResponse =
  | { type: 'model-progress'; id: number; progress: number }
  | { type: 'batch-progress'; id: number; completed: number; total: number }
  | { type: 'result'; id: number; buffer: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

interface PendingEmbedding {
  options: EmbedOptions;
  progressWrites: Promise<void>;
  resolve: (value: Float32Array) => void;
  reject: (reason: Error) => void;
}

let embeddingWorker: Worker | null = null;
let nextRequestId = 1;
const pendingEmbeddings = new Map<number, PendingEmbedding>();

export async function isGraniteEmbeddingModelCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    const cache = await caches.open('transformers-cache');
    return Boolean(await cache.match(GRANITE_QUANTIZED_MODEL_URL));
  } catch {
    return false;
  }
}

function rejectAllPending(error: Error): void {
  for (const pending of pendingEmbeddings.values()) pending.reject(error);
  pendingEmbeddings.clear();
  embeddingWorker?.terminate();
  embeddingWorker = null;
}

function workerAvailable(): boolean {
  return typeof window !== 'undefined'
    && typeof Worker !== 'undefined'
    && process.env.NODE_ENV !== 'test';
}

function getEmbeddingWorker(): Worker {
  if (embeddingWorker) return embeddingWorker;
  embeddingWorker = new Worker(new URL('./graniteEmbedding.worker.ts', import.meta.url), { type: 'module' });
  embeddingWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const pending = pendingEmbeddings.get(message.id);
    if (!pending) return;
    if (message.type === 'model-progress') {
      pending.options.onProgress?.(message.progress);
      return;
    }
    if (message.type === 'batch-progress') {
      pending.progressWrites = pending.progressWrites.then(async () => {
        if (!pending.options.signal?.aborted) await pending.options.onBatchProgress?.(message.completed, message.total);
      });
      // A staging write may fail before the worker sends its final result.
      // Keep the rejection for the caller while marking it handled now.
      void pending.progressWrites.catch(() => {});
      return;
    }
    pendingEmbeddings.delete(message.id);
    void pending.progressWrites.then(() => {
      if (message.type === 'error') pending.reject(new Error(message.message));
      else pending.resolve(new Float32Array(message.buffer));
    }, pending.reject);
  };
  embeddingWorker.onerror = () => rejectAllPending(new Error('The local semantic index worker stopped unexpectedly.'));
  embeddingWorker.onmessageerror = () => rejectAllPending(new Error('The local semantic index worker returned unreadable data.'));
  return embeddingWorker;
}

export async function embedSourceTexts(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<Float32Array> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (!texts.length) return new Float32Array();
  if (!workerAvailable()) return runGraniteEmbedding({ texts, ...options });
  const id = nextRequestId++;
  const worker = getEmbeddingWorker();
  return new Promise<Float32Array>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      pendingEmbeddings.delete(id);
      worker.postMessage({ type: 'cancel', id });
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    pendingEmbeddings.set(id, {
      options,
      progressWrites: Promise.resolve(),
      resolve: value => { cleanup(); resolve(value); },
      reject: error => { cleanup(); reject(error); },
    });
    try {
      worker.postMessage({ type: 'embed', id, texts: [...texts], batchSize: options.batchSize });
    } catch (error) {
      pendingEmbeddings.delete(id);
      cleanup();
      reject(error);
    }
  });
}

export async function embedSourceQuery(text: string): Promise<Float32Array> {
  const values = await embedSourceTexts([text], { batchSize: 1 });
  return values.subarray(0, GRANITE_EMBEDDING_DIMENSIONS);
}
