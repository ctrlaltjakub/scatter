import type { NormalizedSourceDocument } from '@/store/types';

const GZIP_MIME = 'application/gzip';

export async function encodeSourceDocument(document: NormalizedSourceDocument): Promise<Blob> {
  const json = JSON.stringify(document);
  if (typeof CompressionStream === 'undefined') {
    return new Blob([json], { type: 'application/json' });
  }
  const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(compressed).arrayBuffer()], { type: GZIP_MIME });
}

export async function decodeSourceDocument(blob: Blob): Promise<NormalizedSourceDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let text: string;
  if (gzip) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot read compressed source data.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  const value = JSON.parse(text) as NormalizedSourceDocument;
  if (value?.schemaVersion !== 1 || !Array.isArray(value.blocks) || !Array.isArray(value.chunks)) {
    throw new Error('The stored source document is damaged or unsupported.');
  }
  return value;
}

export interface StoredEmbeddingIndex {
  schemaVersion: 1;
  model: string;
  revision: string;
  dimensions: number;
  chunkIds: string[];
  values: Float32Array;
}

export function encodeEmbeddingIndex(index: StoredEmbeddingIndex): Blob {
  const header = JSON.stringify({
    schemaVersion: index.schemaVersion,
    model: index.model,
    revision: index.revision,
    dimensions: index.dimensions,
    chunkIds: index.chunkIds,
  });
  return new Blob([header, '\n', index.values.slice().buffer], { type: 'application/x-scatter-embeddings' });
}

export async function decodeEmbeddingIndex(blob: Blob): Promise<StoredEmbeddingIndex> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const newline = bytes.indexOf(10);
  if (newline < 0) throw new Error('The stored source embedding index is damaged.');
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(0, newline))) as Omit<StoredEmbeddingIndex, 'values'>;
  const body = bytes.slice(newline + 1);
  const values = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (
    header.schemaVersion !== 1
    || !Array.isArray(header.chunkIds)
    || header.dimensions <= 0
    || values.length !== header.chunkIds.length * header.dimensions
  ) throw new Error('The stored source embedding index is inconsistent.');
  return { ...header, values };
}

export interface StoredKeywordIndex {
  schemaVersion: 1;
  chunkIds: string[];
  lengths: number[];
  documentFrequency: Record<string, number>;
  terms: Record<string, Array<[number, number]>>;
}

export function encodeKeywordIndex(index: StoredKeywordIndex): Blob {
  return new Blob([JSON.stringify(index)], { type: 'application/json' });
}

export async function decodeKeywordIndex(blob: Blob): Promise<StoredKeywordIndex> {
  const index = JSON.parse(await blob.text()) as StoredKeywordIndex;
  if (index?.schemaVersion !== 1 || !Array.isArray(index.chunkIds) || !index.terms) {
    throw new Error('The stored source keyword index is damaged.');
  }
  return index;
}
