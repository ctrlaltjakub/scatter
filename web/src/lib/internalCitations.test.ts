import { describe, expect, it } from 'vitest';
import type { RetrievedSourcePassage } from './sourceRetrieval';
import { normalizeInternalCitationTokens, pruneInternalSources } from './internalCitations';

const passages: RetrievedSourcePassage[] = [
  {
    evidenceId: 'SOURCE_4', sourceId: 's1', revisionId: 'r1', sourceTitle: 'Book',
    passageId: 'p4', text: 'A long exact passage.', page: 12, score: 1,
  },
  {
    evidenceId: 'SOURCE_9', sourceId: 's2', revisionId: 'r2', sourceTitle: 'Article',
    passageId: 'p9', text: 'A second passage.', section: 'Results', score: .8,
  },
];

describe('internal source citations', () => {
  it('numbers valid opaque IDs by first appearance and drops invented IDs', () => {
    const result = normalizeInternalCitationTokens(
      'First (SOURCE_9). Again SOURCE_9. Then (SOURCE_4). Invented SOURCE_7.',
      passages,
    );
    expect(result.body).toBe('First (1). Again (1). Then (2). Invented .');
    expect(result.sources.map((source) => [source.n, source.sourceId, source.page, source.section]))
      .toEqual([[1, 's2', undefined, 'Results'], [2, 's1', 12, undefined]]);
  });

  it('keeps only passages whose visible markers survived later passes', () => {
    const result = normalizeInternalCitationTokens('Claim SOURCE_4 and another SOURCE_9.', passages);
    expect(pruneInternalSources('Only (2) survived.', result.sources).map((source) => source.sourceId))
      .toEqual(['s2']);
  });
});
