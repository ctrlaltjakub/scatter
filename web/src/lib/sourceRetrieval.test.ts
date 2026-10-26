import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedSourceDocument, ProjectSource } from '@/store/types';
import { createBlankProject } from '@/store/useGraphStore';
import { buildKeywordIndex } from './sourceIndexing';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';

const mocks = vi.hoisted(() => ({
  assets: new Map<string, Blob>(),
  documents: new Map<Blob, unknown>(),
  keywordIndexes: new Map<Blob, unknown>(),
  embeddingIndexes: new Map<Blob, unknown>(),
  queryVector: vi.fn(),
  alternates: vi.fn(),
}));

vi.mock('@/opfs/sourceAssetsIO', () => ({
  loadSourceAsset: vi.fn(async (_projectId: string, assetId: string) => mocks.assets.get(assetId) ?? null),
}));
vi.mock('./graniteEmbeddings', () => ({
  embedSourceQuery: (...args: unknown[]) => mocks.queryVector(...args),
}));
vi.mock('./secondaryTaskCompletion', () => ({
  sourceQueryAlternates: (...args: unknown[]) => mocks.alternates(...args),
}));
vi.mock('./sourceCodec', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sourceCodec')>();
  return {
    ...original,
    decodeSourceDocument: vi.fn(async (blob: Blob) => mocks.documents.get(blob)),
    decodeKeywordIndex: vi.fn(async (blob: Blob) => mocks.keywordIndexes.get(blob)),
    decodeEmbeddingIndex: vi.fn(async (blob: Blob) => mocks.embeddingIndexes.get(blob)),
  };
});

import { retrieveProjectSources, snapshotSourcePolicy } from './sourceRetrieval';

async function addSource(options: {
  id: string;
  title: string;
  text: string;
  vector?: [number, number];
}): Promise<ProjectSource> {
  const chunkId = `${options.id}-block:0`;
  const document: NormalizedSourceDocument = {
    schemaVersion: 1,
    revisionId: `${options.id}-revision`,
    title: options.title,
    blocks: [{ id: `${options.id}-block`, text: options.text }],
    chunks: [{
      id: chunkId,
      blockId: `${options.id}-block`,
      text: options.text,
      start: 0,
      end: options.text.length,
    }],
  };
  const contentAssetId = `${options.id}-content`;
  const keywordIndexAssetId = `${options.id}-keyword`;
  const embeddingIndexAssetId = options.vector ? `${options.id}-embedding` : undefined;
  const contentBlob = new Blob([contentAssetId]);
  const keywordBlob = new Blob([keywordIndexAssetId]);
  mocks.assets.set(contentAssetId, contentBlob);
  mocks.documents.set(contentBlob, document);
  mocks.assets.set(keywordIndexAssetId, keywordBlob);
  mocks.keywordIndexes.set(keywordBlob, buildKeywordIndex(document.chunks));
  if (embeddingIndexAssetId && options.vector) {
    const embeddingBlob = new Blob([embeddingIndexAssetId]);
    mocks.assets.set(embeddingIndexAssetId, embeddingBlob);
    mocks.embeddingIndexes.set(embeddingBlob, {
      schemaVersion: 1,
      model: 'test-embedding',
      revision: 'test',
      dimensions: 2,
      chunkIds: [chunkId],
      values: new Float32Array(options.vector),
    });
  }
  return {
    id: options.id,
    title: options.title,
    kind: 'text',
    checked: true,
    createdAt: 1,
    contentHash: `${options.id}-hash`,
    activeRevisionId: `${options.id}-revision`,
    revisions: {
      [`${options.id}-revision`]: {
        id: `${options.id}-revision`,
        createdAt: 1,
        status: 'ready',
        contentAssetId,
        keywordIndexAssetId,
        embeddingIndexAssetId,
        index: {
          formatVersion: 1,
          embeddingModel: 'test-embedding',
          embeddingRevision: 'test',
          dimensions: 2,
        },
      },
    },
  };
}

describe('hybrid project-source retrieval', () => {
  beforeEach(() => {
    mocks.assets.clear();
    mocks.documents.clear();
    mocks.keywordIndexes.clear();
    mocks.embeddingIndexes.clear();
    mocks.queryVector.mockReset().mockResolvedValue(new Float32Array([1, 0]));
    mocks.alternates.mockReset().mockResolvedValue([]);
    useSourceRuntimeStore.setState({ jobs: {} });
  });

  it('can exclude unfinished imports without weakening the saved source policy', () => {
    const project = {
      ...createBlankProject('pending', 'root'),
      sourceLibrary: { mode: 'only' as const, order: [], sources: {} },
    };
    useSourceRuntimeStore.getState().upsertJob({
      schemaVersion: 1,
      id: 'job-1',
      projectId: project.id,
      title: 'Long source',
      kind: 'text',
      status: 'indexing',
      createdAt: 1,
      checkedOnSuccess: true,
      sourceId: 'future-source',
    });

    const waiting = snapshotSourcePolicy(project);
    const startNow = snapshotSourcePolicy(project, { includePending: false });

    expect(waiting).toMatchObject({ mode: 'only', pendingJobIds: ['job-1'] });
    expect(startNow).toMatchObject({ mode: 'only', pendingJobIds: [] });
  });

  it('combines exact keyword hits with semantic matches', async () => {
    const exact = await addSource({
      id: 'exact',
      title: 'Exact ledger',
      text: 'The archive identifier ZX-419 records the calibration run.',
      vector: [0, 1],
    });
    const semantic = await addSource({
      id: 'semantic',
      title: 'Conceptual notes',
      text: 'Changing an interpretation can alter the emotional response to an event.',
      vector: [1, 0],
    });
    const project = {
      ...createBlankProject('retrieval', 'root'),
      sourceLibrary: {
        mode: 'use' as const,
        order: [exact.id, semantic.id],
        sources: { [exact.id]: exact, [semantic.id]: semantic },
      },
    };
    const result = await retrieveProjectSources({
      project,
      snapshot: snapshotSourcePolicy(project),
      query: 'ZX-419 cognitive reframing',
    });

    expect(result.passages.map((passage) => passage.sourceId)).toEqual(
      expect.arrayContaining(['exact', 'semantic']),
    );
    expect(result.limitedReason).toBeUndefined();
  });

  it('keeps keyword retrieval usable and explains the limitation when semantics are unavailable', async () => {
    const exact = await addSource({
      id: 'exact',
      title: 'Exact ledger',
      text: 'Invoice ZX-419 totals 87.25 euros.',
    });
    const project = {
      ...createBlankProject('fallback', 'root'),
      sourceLibrary: {
        mode: 'only' as const,
        order: [exact.id],
        sources: { [exact.id]: exact },
      },
    };
    const result = await retrieveProjectSources({
      project,
      snapshot: snapshotSourcePolicy(project),
      query: 'ZX-419 87.25',
    });

    expect(result.passages[0]).toMatchObject({ sourceId: 'exact' });
    expect(result.limitedReason).toContain('exact-word search was used');
    expect(mocks.queryVector).not.toHaveBeenCalled();
  });

  it('falls back to keyword results if the cached semantic model cannot launch', async () => {
    const exact = await addSource({
      id: 'exact',
      title: 'Exact ledger',
      text: 'Invoice ZX-419 totals 87.25 euros.',
      vector: [0, 1],
    });
    mocks.queryVector.mockRejectedValueOnce(new Error('WebAssembly initialization failed'));
    const project = {
      ...createBlankProject('fallback', 'root'),
      sourceLibrary: {
        mode: 'use' as const,
        order: [exact.id],
        sources: { [exact.id]: exact },
      },
    };
    const result = await retrieveProjectSources({
      project,
      snapshot: snapshotSourcePolicy(project),
      query: 'ZX-419 87.25',
    });

    expect(result.passages[0]).toMatchObject({ sourceId: 'exact' });
    expect(result.limitedReason).toBe('WebAssembly initialization failed');
  });
});
