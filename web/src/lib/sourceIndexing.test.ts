import { describe, expect, it } from 'vitest';
import { buildKeywordIndex, chunkSourceBlocks, cosineSimilarity, fuseSourceRanks, searchKeywordIndex } from './sourceIndexing';

describe('local source indexing', () => {
  it('never crosses page boundaries while chunking long text', () => {
    const chunks = chunkSourceBlocks([
      { id: 'p1', page: 1, text: `${'alpha '.repeat(500)}END-ONE` },
      { id: 'p2', page: 2, text: `${'beta '.repeat(500)}END-TWO` },
    ]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.filter((chunk) => chunk.page === 1).every((chunk) => !chunk.text.includes('beta'))).toBe(true);
    expect(chunks.filter((chunk) => chunk.page === 2).every((chunk) => !chunk.text.includes('alpha'))).toBe(true);
  });

  it('finds exact names and numbers through BM25', () => {
    const chunks = chunkSourceBlocks([
      { id: 'a', text: 'Granite supports multilingual semantic retrieval.' },
      { id: 'b', text: 'Invoice ZX-419 totals 87.25 euros.' },
    ]);
    const result = searchKeywordIndex(buildKeywordIndex(chunks), 'ZX-419 87.25');
    expect([...result].sort((a, b) => b[1] - a[1])[0]?.[0]).toContain('b:');
  });

  it('combines incomparable result lists by stable reciprocal rank', () => {
    const fused = fuseSourceRanks([
      new Map([['a', 100], ['b', 1]]),
      new Map([['b', 0.9], ['a', 0.8]]),
      new Map([['b', 0.2]]),
    ]);
    expect(fused.get('b')).toBeGreaterThan(fused.get('a')!);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
});
