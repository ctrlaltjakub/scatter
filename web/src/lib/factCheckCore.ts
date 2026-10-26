import { splitSentences, parseBody, stripChips } from './bulletParse';
import { chatFactUnits } from './chat/markdown';
import { normalizeUrl, sourceDomain } from './citations';
import type { Citation } from '@/providers/types';
import type {
  FactCheckEvidence,
  FactCheckFinding,
  FactCheckReport,
  FactCheckUnit,
  FactCheckVerdict,
  NodeVersion,
} from '@/store/types';

const VERDICTS = new Set<FactCheckVerdict>([
  'supported', 'mixed', 'contradicted', 'unverified',
]);

export function cleanFactText(value: string): string {
  return value
    .replace(/\[\[|\]\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/⟦\d+⟧/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
export function factCheckBodyFingerprint(version: NodeVersion): string {
  // Optional chat enrichment may finish while evidence review is running.
  // Term markers and outline titles do not change the checked answer.
  const input = version.chat ? `${version.chat.question}\u0000${stripChips(version.body)}`
    : `${version.header}\u0000${version.body}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function extractFactCheckUnits(version: NodeVersion): FactCheckUnit[] {
  if (version.chat || version.contentType === 'chat') {
    return chatFactUnits(version.body, new Set(version.internalSources?.map((source) => source.n)));
  }
  const parsed = parseBody(version.body);
  const contentType = version.contentType;
  const isEncyclopedic = contentType !== 'explain' && contentType !== 'interactive';
  const units: FactCheckUnit[] = [];
  let order = 0;

  const opening = parsed?.freeText ?? version.body;
  splitSentences(opening).forEach((sentence, sentenceIndex) => {
    const text = cleanFactText(sentence);
    if (!text) return;
    units.push({
      id: `opening:${sentenceIndex}`,
      order: order++,
      stage: isEncyclopedic ? 'opening' : 'prose',
      kind: 'sentence',
      text,
      sentenceIndex,
      state: 'pending',
    });
  });

  if (isEncyclopedic) {
    parsed?.bullets.forEach((bullet, bulletIndex) => {
      bullet.children.forEach((child, childIndex) => {
        const text = cleanFactText(
          child.desc ? `${child.name}: ${child.desc}` : child.name,
        );
        if (!text) return;
        units.push({
          id: `bullet:${bulletIndex}:${childIndex}`,
          order: order++,
          stage: 'bullets',
          kind: 'sub-bullet',
          text,
          sectionTitle: cleanFactText(bullet.title),
          bulletIndex,
          childIndex,
          state: 'pending',
        });
      });
    });
  }

  return units;
}

function unwrapJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('The model did not return a JSON object.');
  return JSON.parse(trimmed.slice(first, last + 1));
}

function words(value: string): string {
  return value.trim().split(/\s+/).slice(0, 25).join(' ');
}

function citationForUrl(url: string, citations: Citation[]): Citation | undefined {
  const normalized = normalizeUrl(url);
  return citations.find((citation) => normalizeUrl(citation.url) === normalized);
}

export function parseFactCheckFinding(
  raw: string,
  expectedUnitId: string,
  citations: Citation[],
): FactCheckFinding {
  const data = unwrapJson(raw) as Record<string, unknown>;
  if (data.unitId !== expectedUnitId) throw new Error('The model returned the wrong passage ID.');
  const verdict = String(data.verdict ?? '').toLowerCase() as FactCheckVerdict;
  if (!VERDICTS.has(verdict)) throw new Error('The model returned an unknown evidence status.');
  const explanation = String(data.explanation ?? '').trim();
  if (!explanation) throw new Error('The model omitted its evidence explanation.');
  const reason = data.unverifiedReason;
  const unverifiedReason = verdict === 'unverified'
    && (reason === 'not_factual' || reason === 'insufficient_evidence')
    ? reason
    : undefined;
  if (verdict === 'unverified' && !unverifiedReason) {
    throw new Error('An unverified passage needs a reason.');
  }

  const rawEvidence = Array.isArray(data.evidence) ? data.evidence : [];
  const evidence: FactCheckEvidence[] = rawEvidence.map((entry) => {
    const item = entry as Record<string, unknown>;
    const url = String(item.url ?? '').trim();
    const citation = citationForUrl(url, citations);
    if (!url || !citation) throw new Error('Evidence URL was not supplied by web search.');
    const stance = item.stance;
    if (stance !== 'supports' && stance !== 'contradicts' && stance !== 'context') {
      throw new Error('Evidence has an unknown stance.');
    }
    const proposed = words(String(item.excerpt ?? ''));
    const providerExcerpt = citation.content?.trim();
    const exact = !!providerExcerpt && (
      !proposed
      || providerExcerpt.toLocaleLowerCase().includes(proposed.toLocaleLowerCase())
      || proposed.toLocaleLowerCase().includes(providerExcerpt.toLocaleLowerCase())
    );
    return {
      url: citation.url,
      title: citation.title?.trim() || String(item.title ?? '').trim() || undefined,
      domain: sourceDomain(citation.url, citation.title),
      stance,
      excerpt: words(exact ? providerExcerpt! : proposed),
      excerptOrigin: exact ? 'source' : proposed ? 'ai' : undefined,
    };
  });

  if (verdict === 'supported' && !evidence.some((item) => item.stance === 'supports')) {
    throw new Error('A supported verdict needs supporting evidence.');
  }
  if (verdict === 'contradicted' && !evidence.some((item) => item.stance === 'contradicts')) {
    throw new Error('A contradicted verdict needs contradicting evidence.');
  }
  if (verdict === 'mixed' && !(
    evidence.some((item) => item.stance === 'supports')
    && evidence.some((item) => item.stance === 'contradicts')
  )) {
    throw new Error('Mixed evidence needs both supporting and contradicting sources.');
  }

  return { verdict, explanation, unverifiedReason, evidence };
}

export function factCheckProgress(report: FactCheckReport): { completed: number; total: number } {
  return {
    completed: report.units.filter((unit) => unit.state !== 'pending').length,
    total: report.units.length,
  };
}
