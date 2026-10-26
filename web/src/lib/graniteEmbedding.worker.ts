/// <reference lib="webworker" />

import { runGraniteEmbedding } from './graniteEmbeddingEngine';

type EmbedRequest = {
  type: 'embed';
  id: number;
  texts: string[];
  batchSize?: number;
};

type WorkerResponse =
  | { type: 'model-progress'; id: number; progress: number }
  | { type: 'batch-progress'; id: number; completed: number; total: number }
  | { type: 'result'; id: number; buffer: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

const workerScope = self as DedicatedWorkerGlobalScope;

// ONNX Web cannot execute two sessions simultaneously. Serialize requests in
// the worker so source imports and generation-time queries share one warmed
// model safely without ever blocking Scatter's UI thread.
let inferenceQueue = Promise.resolve();

workerScope.onmessage = (event: MessageEvent<EmbedRequest>) => {
  const request = event.data;
  if (request.type !== 'embed') return;
  inferenceQueue = inferenceQueue.then(async () => {
    try {
      const values = await runGraniteEmbedding({
        texts: request.texts,
        batchSize: request.batchSize,
        onProgress: (progress) => workerScope.postMessage({
          type: 'model-progress', id: request.id, progress,
        } satisfies WorkerResponse),
        onBatchProgress: (completed, total) => workerScope.postMessage({
          type: 'batch-progress', id: request.id, completed, total,
        } satisfies WorkerResponse),
      });
      const buffer = values.buffer as ArrayBuffer;
      workerScope.postMessage({ type: 'result', id: request.id, buffer } satisfies WorkerResponse, [buffer]);
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  });
};

export {};
