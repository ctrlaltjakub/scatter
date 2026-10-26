'use client';

import { configuredPrompt } from '@/lib/configuredPrompt';
import type {
  Project,
  ProjectSource,
  ProjectSourceMode,
  SourceChunk,
} from '@/store/types';
import { loadSourceAsset } from '@/opfs/sourceAssetsIO';
import { activeProjectSources, activeRevision, effectiveSourceMode, sourceLibrary } from './projectSources';
import {
  decodeEmbeddingIndex,
  decodeKeywordIndex,
  decodeSourceDocument,
  type StoredEmbeddingIndex,
  type StoredKeywordIndex,
} from './sourceCodec';
import {
  fuseSourceRanks,
  searchEmbeddingValues,
  searchKeywordIndex,
  sourceTokens,
} from './sourceIndexing';
import { embedSourceQuery } from './graniteEmbeddings';
import { sourceQueryAlternates } from './secondaryTaskCompletion';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';

export interface SourcePolicySnapshot {
  projectId: string;
  mode: ProjectSourceMode;
  sourceIds: string[];
  revisionIds: string[];
  /** Processing rows that were checked when the action began. Runtime-only. */
  pendingJobIds: string[];
  pendingSourceIds: string[];
  pendingUrls: string[];
  createdAt: number;
}

export interface RetrievedSourcePassage {
  evidenceId: string;
  sourceId: string;
  revisionId: string;
  sourceTitle: string;
  passageId: string;
  text: string;
  page?: number;
  section?: string;
  originalUrl?: string;
  captureDate?: number;
  score: number;
}

export interface SourceRetrievalResult {
  snapshot: SourcePolicySnapshot;
  passages: RetrievedSourcePassage[];
  limitedReason?: string;
}

interface LoadedSource {
  source: ProjectSource;
  revisionId: string;
  chunks: SourceChunk[];
  chunkById: Map<string, SourceChunk>;
  keyword: StoredKeywordIndex;
  embedding?: StoredEmbeddingIndex;
}

export function snapshotSourcePolicy(
  project: Project,
  options: { includePending?: boolean } = {},
): SourcePolicySnapshot {
  const library = sourceLibrary(project);
  const active = activeProjectSources(library);
  const allPending = Object.values(useSourceRuntimeStore.getState().jobs).filter((job) => (
    job.projectId === project.id && job.checkedOnSuccess && job.status !== 'failed'
  ));
  const pending = options.includePending === false ? [] : allPending;
  return {
    projectId: project.id,
    // A first source can still be processing, so there may be no ready row for
    // effectiveSourceMode() to count yet. Its saved policy already changed to
    // Use when the import was queued; preserve that policy for this request.
    mode: active.length > 0 || allPending.length > 0 ? library.mode : effectiveSourceMode(library),
    sourceIds: active.map((source) => source.id),
    revisionIds: active.map((source) => source.activeRevisionId),
    pendingJobIds: pending.map((job) => job.id),
    pendingSourceIds: pending.flatMap((job) => job.sourceId ? [job.sourceId] : []),
    pendingUrls: pending.flatMap((job) => job.originalUrl ? [job.originalUrl] : []),
    createdAt: Date.now(),
  };
}

async function requiredAsset(projectId: string, assetId: string, label: string): Promise<Blob> {
  const blob = await loadSourceAsset(projectId, assetId);
  if (!blob) throw new Error(`${label} is unavailable. Reopen Sources to repair it.`);
  return blob;
}

async function loadSelectedSource(
  project: Project,
  sourceId: string,
  revisionId: string,
): Promise<LoadedSource | null> {
  const source = project.sourceLibrary?.sources[sourceId];
  const revision = source?.revisions[revisionId];
  if (!source || !revision) return null;
  const [document, keyword, embedding] = await Promise.all([
    requiredAsset(project.id, revision.contentAssetId, source.title).then(decodeSourceDocument),
    requiredAsset(project.id, revision.keywordIndexAssetId, source.title).then(decodeKeywordIndex),
    revision.embeddingIndexAssetId
      ? requiredAsset(project.id, revision.embeddingIndexAssetId, source.title)
        .then(decodeEmbeddingIndex).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  return {
    source,
    revisionId,
    chunks: document.chunks,
    chunkById: new Map(document.chunks.map((chunk) => [chunk.id, chunk])),
    keyword,
    embedding,
  };
}

function exactBoost(chunk: SourceChunk, query: string): number {
  const haystack = chunk.text.toLocaleLowerCase();
  const exact = query.trim().toLocaleLowerCase();
  let boost = exact.length >= 4 && haystack.includes(exact) ? 0.05 : 0;
  const tokens = [...new Set(sourceTokens(query))];
  for (const token of tokens) {
    if (token.length > 2 && haystack.includes(token)) boost += 0.002;
    if (/^\d/.test(token) && haystack.includes(token)) boost += 0.01;
  }
  if (chunk.section && tokens.some((token) => chunk.section!.toLocaleLowerCase().includes(token))) boost += 0.02;
  return boost;
}

function globallyKeyed(sourceId: string, chunkId: string): string {
  return `${sourceId}\n${chunkId}`;
}

function nearDuplicate(left: string, right: string): boolean {
  const a = new Set(sourceTokens(left));
  const b = new Set(sourceTokens(right));
  if (!a.size || !b.size) return false;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 && intersection / union >= 0.82;
}

export async function retrieveProjectSources(options: {
  project: Project;
  snapshot: SourcePolicySnapshot;
  query: string;
  signal?: AbortSignal;
  maxPassages?: number;
}): Promise<SourceRetrievalResult> {
  const { project, snapshot, query, signal } = options;
  if (snapshot.mode === 'ignore' || snapshot.sourceIds.length === 0) {
    return { snapshot, passages: [] };
  }
  const loaded = (await Promise.all(snapshot.sourceIds.map((sourceId, index) => (
    loadSelectedSource(project, sourceId, snapshot.revisionIds[index] ?? '')
  )))).filter((source): source is LoadedSource => Boolean(source));
  const alternates = await sourceQueryAlternates(query, signal);
  const queries = [query, ...alternates.filter((value) => value !== query)];
  const lists: Map<string, number>[] = [];
  for (const search of queries) {
    for (const item of loaded) {
      const scores = searchKeywordIndex(item.keyword, search);
      lists.push(new Map([...scores].map(([chunkId, score]) => (
        [globallyKeyed(item.source.id, chunkId), score]
      ))));
    }
  }

  const hasEmbeddings = loaded.some((item) => item.embedding);
  let limitedReason: string | undefined;
  if (hasEmbeddings) {
    try {
      for (const search of queries) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const queryVector = await embedSourceQuery(search);
        for (const item of loaded) {
          if (!item.embedding) continue;
          const scores = searchEmbeddingValues(
            item.embedding.chunkIds,
            item.embedding.values,
            item.embedding.dimensions,
            queryVector,
          );
          lists.push(new Map([...scores].filter(([, score]) => score >= 0.15).map(([chunkId, score]) => (
            [globallyKeyed(item.source.id, chunkId), score]
          ))));
        }
      }
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      limitedReason = error instanceof Error ? error.message : 'The semantic model could not start.';
    }
  } else {
    limitedReason = 'The semantic index is not available; exact-word search was used.';
  }

  const fused = fuseSourceRanks(lists);
  const bySource = new Map(loaded.map((item) => [item.source.id, item]));
  const ranked = [...fused.entries()].map(([key, score]) => {
    const [sourceId, chunkId] = key.split('\n');
    const item = sourceId ? bySource.get(sourceId) : undefined;
    const chunk = chunkId ? item?.chunkById.get(chunkId) : undefined;
    return item && chunk ? { item, chunk, score: score + exactBoost(chunk, query) } : null;
  }).filter((value): value is NonNullable<typeof value> => Boolean(value))
    .sort((a, b) => b.score - a.score);

  const maxPassages = Math.max(1, Math.min(16, options.maxPassages ?? 8));
  const picked: typeof ranked = [];
  const seen = new Set<string>();
  const sourceCounts = new Map<string, number>();
  let evidenceChars = 0;
  const evidenceBudget = 18_000;
  for (const candidate of ranked) {
    if (picked.length >= maxPassages) break;
    const key = globallyKeyed(candidate.item.source.id, candidate.chunk.id);
    if (
      seen.has(key)
      || (sourceCounts.get(candidate.item.source.id) ?? 0) >= 4
      || picked.some((prior) => nearDuplicate(prior.chunk.text, candidate.chunk.text))
      || (picked.length > 0 && evidenceChars + candidate.chunk.text.length > evidenceBudget)
    ) continue;
    picked.push(candidate);
    evidenceChars += candidate.chunk.text.length;
    seen.add(key);
    sourceCounts.set(candidate.item.source.id, (sourceCounts.get(candidate.item.source.id) ?? 0) + 1);
  }
  // Neighbor passages make a cut-off chunk understandable, but never displace
  // all independently relevant results.
  for (const candidate of [...picked]) {
    if (picked.length >= maxPassages) break;
    const index = candidate.item.chunks.findIndex((chunk) => chunk.id === candidate.chunk.id);
    const neighbor = candidate.item.chunks[index + 1];
    if (!neighbor || neighbor.blockId !== candidate.chunk.blockId) continue;
    const key = globallyKeyed(candidate.item.source.id, neighbor.id);
    if (seen.has(key) || evidenceChars + neighbor.text.length > evidenceBudget) continue;
    picked.push({ item: candidate.item, chunk: neighbor, score: candidate.score * 0.85 });
    evidenceChars += neighbor.text.length;
    seen.add(key);
  }

  return {
    snapshot,
    passages: picked.map(({ item, chunk, score }, index) => {
      const revision = item.source.revisions[item.revisionId];
      return {
        evidenceId: `SOURCE_${index + 1}`,
        sourceId: item.source.id,
        revisionId: item.revisionId,
        sourceTitle: item.source.title,
        passageId: chunk.id,
        text: chunk.text,
        page: chunk.page,
        section: chunk.section,
        originalUrl: item.source.originalUrl,
        captureDate: revision?.captureDate,
        score,
      };
    }),
    limitedReason,
  };
}

export function formatSourceEvidenceBlock(
  mode: Exclude<ProjectSourceMode, 'ignore'>,
  passages: readonly RetrievedSourcePassage[],
): string {
  const policy = mode === 'only'
    ? configuredPrompt('sourcePolicyOnly')
    : configuredPrompt('sourcePolicyUse');
  const formattedPassages = passages.map((passage) => [
    `<<<${passage.evidenceId} source=${JSON.stringify(passage.sourceTitle)}${passage.page ? ` page=${passage.page}` : ''}>>>`,
    passage.text.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››'),
    `<<<END ${passage.evidenceId}>>>`,
  ].join('\n')).join('\n');
  return configuredPrompt('sourceEvidence', { policy, passages: formattedPassages });
}
