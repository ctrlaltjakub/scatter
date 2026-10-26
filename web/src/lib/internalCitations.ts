import type { InternalNodeSource } from '@/store/types';
import type { RetrievedSourcePassage } from './sourceRetrieval';

const SOURCE_TOKEN_RE = /\(?SOURCE_(\d+)\)?/g;

/** Convert only opaque IDs Scatter supplied to the model. Numbering follows
 * first appearance in the response, independently of retrieval rank. */
export function normalizeInternalCitationTokens(
  body: string,
  passages: readonly RetrievedSourcePassage[],
): { body: string; sources: InternalNodeSource[] } {
  const byId = new Map(passages.map((passage) => [passage.evidenceId, passage]));
  const numberById = new Map<string, number>();
  const sources: InternalNodeSource[] = [];
  const normalized = body.replace(SOURCE_TOKEN_RE, (_match, rawNumber: string) => {
    const evidenceId = `SOURCE_${Number(rawNumber)}`;
    const passage = byId.get(evidenceId);
    if (!passage) return '';
    let n = numberById.get(evidenceId);
    if (!n) {
      n = numberById.size + 1;
      numberById.set(evidenceId, n);
      sources.push({
        n,
        sourceId: passage.sourceId,
        revisionId: passage.revisionId,
        passageId: passage.passageId,
        sourceTitle: passage.sourceTitle,
        // The complete immutable passage lives in the source asset and opens
        // by passageId. Keep only a compact panel preview in project JSON.
        excerpt: passage.text.length > 620
          ? `${passage.text.slice(0, 617).trimEnd()}…`
          : passage.text,
        page: passage.page,
        section: passage.section,
        originalUrl: passage.originalUrl,
        captureDate: passage.captureDate,
      });
    }
    return `(${n})`;
  });
  return { body: normalized, sources };
}

export function pruneInternalSources(
  body: string,
  sources: readonly InternalNodeSource[],
): InternalNodeSource[] {
  return sources.filter((source) => body.includes(`(${source.n})`));
}
