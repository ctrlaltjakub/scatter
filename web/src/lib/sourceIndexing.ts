import type { SourceBlock, SourceChunk } from '@/store/types';
import type { StoredKeywordIndex } from './sourceCodec';

const TARGET_CHARS = 2_200;
const OVERLAP_CHARS = 220;
const WORD_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu;

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function boundaryBefore(text: string, desired: number, floor: number): number {
  if (desired >= text.length) return text.length;
  for (let index = desired; index > floor; index -= 1) {
    if (/\s/.test(text[index] ?? '')) return index;
  }
  return desired;
}

/** Chunk only inside a block. A page/section boundary is therefore always a
 * hard retrieval boundary and citations never point ambiguously across pages. */
export function chunkSourceBlocks(blocks: readonly SourceBlock[]): SourceChunk[] {
  const chunks: SourceChunk[] = [];
  for (const block of blocks) {
    const text = normalizeText(block.text);
    if (!text) continue;
    let start = 0;
    let part = 0;
    while (start < text.length) {
      const end = boundaryBefore(text, Math.min(text.length, start + TARGET_CHARS), start + 300);
      const slice = text.slice(start, end).trim();
      if (slice) chunks.push({
        id: `${block.id}:${part}`,
        blockId: block.id,
        text: slice,
        page: block.page,
        section: block.section,
        start,
        end,
      });
      if (end >= text.length) break;
      start = Math.max(start + 1, boundaryBefore(text, end - OVERLAP_CHARS, start));
      part += 1;
    }
  }
  return chunks;
}

export function sourceTokens(text: string): string[] {
  return [...text.toLocaleLowerCase().matchAll(WORD_TOKEN)].map((match) => match[0]!);
}

export function buildKeywordIndex(chunks: readonly SourceChunk[]): StoredKeywordIndex {
  const documentFrequency: Record<string, number> = {};
  const terms: StoredKeywordIndex['terms'] = {};
  const lengths: number[] = [];
  chunks.forEach((chunk, documentIndex) => {
    const tokens = sourceTokens(chunk.text);
    lengths.push(tokens.length);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, count] of counts) {
      documentFrequency[token] = (documentFrequency[token] ?? 0) + 1;
      (terms[token] ??= []).push([documentIndex, count]);
    }
  });
  return {
    schemaVersion: 1,
    chunkIds: chunks.map((chunk) => chunk.id),
    lengths,
    documentFrequency,
    terms,
  };
}

export function searchKeywordIndex(
  index: StoredKeywordIndex,
  query: string,
): Map<string, number> {
  const queryTokens = [...new Set(sourceTokens(query))];
  const scores = new Map<number, number>();
  const count = index.chunkIds.length;
  if (!count || !queryTokens.length) return new Map();
  const averageLength = index.lengths.reduce((sum, value) => sum + value, 0) / count || 1;
  const k1 = 1.2;
  const b = 0.75;
  for (const token of queryTokens) {
    const postings = index.terms[token];
    if (!postings) continue;
    const frequency = index.documentFrequency[token] ?? postings.length;
    const idf = Math.log(1 + (count - frequency + 0.5) / (frequency + 0.5));
    for (const [documentIndex, termFrequency] of postings) {
      const length = index.lengths[documentIndex] ?? averageLength;
      const denominator = termFrequency + k1 * (1 - b + b * length / averageLength);
      scores.set(documentIndex, (scores.get(documentIndex) ?? 0)
        + idf * ((termFrequency * (k1 + 1)) / denominator));
    }
  }
  return new Map([...scores.entries()].map(([documentIndex, score]) => (
    [index.chunkIds[documentIndex]!, score]
  )));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    left += av * av;
    right += bv * bv;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

export function searchEmbeddingValues(
  chunkIds: readonly string[],
  values: Float32Array,
  dimensions: number,
  query: ArrayLike<number>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (let documentIndex = 0; documentIndex < chunkIds.length; documentIndex += 1) {
    const offset = documentIndex * dimensions;
    const vector = values.subarray(offset, offset + dimensions);
    scores.set(chunkIds[documentIndex]!, cosineSimilarity(vector, query));
  }
  return scores;
}

/** Reciprocal-rank fusion is stable across incomparable BM25/cosine scales. */
export function fuseSourceRanks(
  lists: ReadonlyArray<ReadonlyMap<string, number>>,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    const ranked = [...list.entries()].sort((a, b) => b[1] - a[1]);
    ranked.forEach(([id], rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1)));
  }
  return fused;
}
