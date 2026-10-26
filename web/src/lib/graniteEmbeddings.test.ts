import { afterEach, describe, expect, it, vi } from 'vitest';

const { pipelineMock } = vi.hoisted(() => ({
  pipelineMock: vi.fn(async () => async (input: string | string[]) => {
    const count = Array.isArray(input) ? input.length : 1;
    return {
      data: new Float32Array(count * 384),
      dims: [count, 384],
    };
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  env: { allowLocalModels: true },
  pipeline: pipelineMock,
}));

import {
  embedSourceTexts,
  GRANITE_EMBEDDING_MODEL,
  isGraniteEmbeddingModelCached,
} from './graniteEmbeddings';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Granite browser embeddings', () => {
  it('loads the browser-ready quantized ONNX repository', async () => {
    const values = await embedSourceTexts(['semantic source search']);

    expect(GRANITE_EMBEDDING_MODEL).toBe(
      'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    );
    expect(pipelineMock).toHaveBeenCalledWith(
      'feature-extraction',
      GRANITE_EMBEDDING_MODEL,
      expect.objectContaining({ dtype: 'q8', revision: 'main' }),
    );
    expect(values).toHaveLength(384);
  });

  it('recognizes the quantized model in the browser cache', async () => {
    const match = vi.fn(async () => new Response('cached'));
    const open = vi.fn(async () => ({ match }));
    vi.stubGlobal('caches', { open });

    await expect(isGraniteEmbeddingModelCached()).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith('transformers-cache');
    expect(match).toHaveBeenCalledWith(
      `https://huggingface.co/${GRANITE_EMBEDDING_MODEL}/resolve/main/onnx/model_quantized.onnx`,
    );
  });

  it('reports semantic indexing after every completed batch', async () => {
    const progress: Array<[number, number]> = [];
    await embedSourceTexts(['one', 'two', 'three'], {
      batchSize: 2,
      onBatchProgress: (completed, total) => { progress.push([completed, total]); },
    });

    expect(progress).toEqual([[0, 3], [2, 3], [3, 3]]);
  });
});
