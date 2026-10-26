import { beforeEach, expect, it, vi } from 'vitest';
import { prepareSourceEmbeddingModel } from './sourceProcessing';
import { embedSourceTexts, isGraniteEmbeddingModelCached } from './graniteEmbeddings';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';

vi.mock('./graniteEmbeddings', () => ({
  GRANITE_EMBEDDING_DIMENSIONS: 384, GRANITE_EMBEDDING_MODEL: 'test-model', GRANITE_EMBEDDING_REVISION: 'test',
  embedSourceTexts: vi.fn(), isGraniteEmbeddingModelCached: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  useSourceRuntimeStore.setState({ embeddingStatus: 'idle', embeddingProgress: 0, embeddingError: undefined, jobs: {} });
});

it.each([false, true])('prepares embeddings without previous sources, reusing cache when present (cached=%s)', async cached => {
  vi.mocked(isGraniteEmbeddingModelCached).mockResolvedValue(cached);
  vi.mocked(embedSourceTexts).mockImplementation(async (_texts, options) => {
    expect(useSourceRuntimeStore.getState().embeddingStatus).toBe(cached ? 'loading' : 'downloading');
    options?.onProgress?.(40);
    if (!cached) expect(useSourceRuntimeStore.getState().embeddingProgress).toBe(40);
    return new Float32Array(384);
  });
  // Concurrent first-source imports share one download/load.
  await Promise.all([prepareSourceEmbeddingModel(), prepareSourceEmbeddingModel()]);
  expect(embedSourceTexts).toHaveBeenCalledTimes(1);
  expect(useSourceRuntimeStore.getState()).toMatchObject({ embeddingStatus: 'ready', embeddingProgress: 100 });
  await prepareSourceEmbeddingModel();
  expect(embedSourceTexts).toHaveBeenCalledTimes(1);
});

it('reports download failure and allows a subsequent preparation to retry', async () => {
  vi.mocked(isGraniteEmbeddingModelCached).mockResolvedValue(false);
  vi.mocked(embedSourceTexts).mockRejectedValueOnce(new Error('Download failed')).mockResolvedValueOnce(new Float32Array(384));
  await prepareSourceEmbeddingModel();
  expect(useSourceRuntimeStore.getState()).toMatchObject({ embeddingStatus: 'failed', embeddingError: 'Download failed' });
  await prepareSourceEmbeddingModel();
  expect(useSourceRuntimeStore.getState().embeddingStatus).toBe('ready');
});
