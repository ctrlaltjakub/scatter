import { env, pipeline } from '@huggingface/transformers';

// Keep the inference engine in its own module so production can load it inside
// a Web Worker. Vitest and browsers without Worker support use the same engine
// directly, which keeps one implementation of the model contract.
export const GRANITE_EMBEDDING_MODEL = 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX';
export const GRANITE_EMBEDDING_REVISION = 'main';
export const GRANITE_EMBEDDING_DIMENSIONS = 384;

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: 'cls'; normalize: true },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(onProgress?: (progress: number) => void): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      env.allowLocalModels = false;
      const extractor = await pipeline('feature-extraction', GRANITE_EMBEDDING_MODEL, {
        dtype: 'q8',
        revision: GRANITE_EMBEDDING_REVISION,
        progress_callback: (event) => {
          if ('progress' in event && typeof event.progress === 'number') onProgress?.(event.progress);
        },
      });
      return extractor as unknown as FeatureExtractor;
    })().catch((error) => {
      extractorPromise = null;
      throw error;
    });
  }
  return extractorPromise;
}

export async function runGraniteEmbedding(options: {
  texts: readonly string[];
  batchSize?: number;
  onProgress?: (progress: number) => void;
  onBatchProgress?: (completed: number, total: number) => void | Promise<void>;
}): Promise<Float32Array> {
  const { texts } = options;
  if (!texts.length) return new Float32Array();
  await options.onBatchProgress?.(0, texts.length);
  const extractor = await loadExtractor(options.onProgress);
  // Larger batches amortize tokenization/session overhead. In production the
  // allocation lives off the UI thread. A 16-item batch is the best desktop
  // compromise here: doubling it only improved measured throughput by about
  // ten percent while doubling the batch's peak activation memory.
  const batchSize = Math.max(1, options.batchSize ?? 16);
  const values = new Float32Array(texts.length * GRANITE_EMBEDDING_DIMENSIONS);
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const output = await extractor(batch, { pooling: 'cls', normalize: true });
    if (output.data.length !== batch.length * GRANITE_EMBEDDING_DIMENSIONS) {
      throw new Error('Granite returned an unexpected embedding shape.');
    }
    values.set(output.data, start * GRANITE_EMBEDDING_DIMENSIONS);
    await options.onBatchProgress?.(Math.min(start + batch.length, texts.length), texts.length);
  }
  return values;
}
