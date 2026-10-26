import { generationLanguagePrompt } from './generationLanguage';
import { versionLanguage } from './languages';
import { configuredPrompt } from '@/lib/configuredPrompt';
import { GenerationOutputLimitError } from './generationLimits';
import type { NodeVersion } from '@/store/types';
import { parseBody, stripChips } from './bulletParse';
import { wholeTerm } from './bulletTerms';
import { markedTerms, stripTermMarkers } from './termMarking';
import { stringHash as hashPrompt } from './stringHash';
import { semanticHeaderText } from './nodeHeaderText';
import { termPreviewUser } from './termPreviewPrompt';

export const TERM_PREVIEW_BATCH_SIZE = 24;
export const termPreviewKey = (term: string) => term.trim().replace(/\s+/g, ' ').toLowerCase();
const previewSubject = (version: NodeVersion) => version.headerParts
  ? semanticHeaderText(version.headerParts) : version.header;
export function termPreviewFingerprint(version: NodeVersion): string {
  // Preserve legacy English fingerprints: adding a language selector must not
  // invalidate already-paid-for previews in existing projects.
  const values = version.answerEnrichmentId
    ? [version.answerEnrichmentId, version.body]
    : [previewSubject(version), version.body, version.contentType, version.generatedBy];
  if (versionLanguage(version) !== 'en') values.push(versionLanguage(version));
  const source = JSON.stringify(values);
  return `${source.length}:${hashPrompt(source)}`;
}

/** Re-marking changes delimiters, not meaning. Reuse only verified caches with
 * the exact same prose, subject and node kind; real edits still invalidate them.
 * Keep unmarked entries too, so a later redo can mark the term again for free. */
export function reusableTermPreviews(version: NodeVersion, candidates: readonly NodeVersion[], retryFailed = false): NodeVersion['termPreviews'] {
  const fingerprint = termPreviewFingerprint(version);
  const current = version.termPreviews?.fingerprint === fingerprint ? version.termPreviews : undefined;
  let entries = current?.entries;
  const exhaustedTerms = new Set(retryFailed ? [] : current?.exhaustedTerms ?? []);
  let plain: string | undefined;
  for (const candidate of candidates) {
    const cache = candidate.termPreviews;
    const shared = !!version.answerEnrichmentId && version.answerEnrichmentId === candidate.answerEnrichmentId;
    if (candidate === version || versionLanguage(candidate) !== versionLanguage(version) || !cache || cache.fingerprint !== termPreviewFingerprint(candidate)
      || (!shared && (previewSubject(candidate) !== previewSubject(version) || candidate.contentType !== version.contentType
      || candidate.generatedBy !== version.generatedBy))) continue;
    if (candidate.body !== version.body) {
      plain ??= stripTermMarkers(version.body);
      if (stripTermMarkers(candidate.body) !== plain) continue;
    }
    for (const [key, value] of Object.entries(cache.entries)) {
      if (typeof value !== 'string' || (entries && Object.hasOwn(entries, key))) continue;
      if (entries === current?.entries) entries = Object.assign(Object.create(null), entries) as Record<string, string>;
      entries![key] = value;
    }
    // Once this version has its own cache, its retry state is authoritative.
    // Older failed attempts must not suppress an explicit retry on this version.
    if (!retryFailed && !current && candidate.body === version.body) {
      for (const term of cache.exhaustedTerms ?? []) exhaustedTerms.add(term);
    }
  }
  if (!retryFailed && entries === current?.entries && exhaustedTerms.size === (current?.exhaustedTerms?.length ?? 0)) return current;
  return retryFailed || entries || exhaustedTerms.size ? { fingerprint, entries: entries ?? {},
    ...(exhaustedTerms.size ? { exhaustedTerms: [...exhaustedTerms] } : {}) } : undefined;
}

export function previewTerms(version: NodeVersion): string[] {
  if (version.media || version.contentType === 'media') return [];
  const terms = markedTerms(version.body);
  // Encyclopedia chapter/subchapter titles are whole clickable terms even if
  // the model marked only part of the title (or no part at all).
  const encyclopedic = version.contentType === 'encyclopedic' || (!version.contentType
    && !['chat', 'explain', 'interactive', 'media'].includes(version.generatedBy));
  if (encyclopedic) for (const bullet of parseBody(version.body)?.bullets ?? []) {
    terms.push(wholeTerm(bullet.title));
    for (const child of bullet.children) terms.push(wholeTerm(child.name));
  }
  return [...new Map(terms.filter(Boolean).map(term => [termPreviewKey(term), term])).values()];
}

export interface TermPreviewIssue { reason: string; previousParts?: string[] }

export function previewRequest(version: NodeVersion, terms: string[], repairs?: Record<string, TermPreviewIssue>) {
  let context = stripChips(version.body);
  if (context.length > 4000) {
    const lower = context.toLocaleLowerCase();
    // Preserve the opening AND a local occurrence of every requested term,
    // rather than discarding terms near the end of a long answer.
    const ranges: Array<[number, number]> = [[0, 600]];
    for (const term of terms) {
      const index = lower.indexOf(term.toLocaleLowerCase());
      if (index >= 0) ranges.push([Math.max(0, index - 120), index + term.length + 180]);
    }
    const merged: Array<[number, number]> = [];
    for (const range of ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    context = merged.map(([from, to]) => context.slice(from, to)).join('\n[…]\n');
  }
  return { system: configuredPrompt('termPreviewSystem') + '\n\n' + generationLanguagePrompt(versionLanguage(version))
      + (repairs ? '\n\n' + configuredPrompt('termPreviewRepair') : ''),
    user: termPreviewUser(previewSubject(version), context, terms.map((term, id) => ({ id, term,
      ...(repairs?.[termPreviewKey(term)] ? { repair: repairs[termPreviewKey(term)] } : {}) }))),
    maxOutputTokens: Math.max(1400, terms.length * 180), rejectTruncated: true };
}

/** Keep exact rejection reasons so repair requests and capability checks use
 * the same validator instead of blindly repeating a failed generation. */
export function inspectTermPreviews(raw: string, terms: string[]) {
  const result: Record<string, string> = Object.create(null);
  const issues: Record<string, TermPreviewIssue> = Object.create(null);
  for (const term of terms) issues[termPreviewKey(term)] = { reason: 'No preview was returned for this ID. Include it in the previews array.' };
  try {
    const data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!Array.isArray(data?.previews)) throw new Error('Missing previews array');
    const ids = new Set<number>();
    for (const entry of data.previews) {
      if (!Number.isInteger(entry?.id) || !terms[entry.id] || ids.has(entry.id)) continue;
      ids.add(entry.id);
      const key = termPreviewKey(terms[entry.id]!);
      const reject = (reason: string) => {
        issues[key] = { reason,
          ...(Array.isArray(entry.parts) && entry.parts.every((part: unknown) => typeof part === 'string')
            ? { previousParts: entry.parts.slice(0, 9).map((part: string) => part.slice(0, 650)) } : {}) };
      };
      if (!Array.isArray(entry.parts) || !entry.parts.length
        || !entry.parts.every((part: unknown) => typeof part === 'string')) {
        reject('Return the explanation as a nonempty array of text strings in parts.'); continue;
      }
      // Emphasis is a presentation preference, never a reason to discard or
      // regenerate useful prose. Accept any part count, empty/long bold parts,
      // and inline Markdown; preserve usable bold spans without nesting them.
      const text = entry.parts.map((part: string, i: number) => {
        const normalized = part.replace(/__([^_\n]+)__/g, '**$1**');
        return i % 2 && normalized.trim() && !normalized.includes('*')
          ? normalized.replace(/^(\s*)([\s\S]*?)(\s*)$/, '$1**$2**$3') : normalized;
      }).join('').split(/(\*\*[^*\n]+\*\*)/g)
        .map((part: string, i: number) => i % 2 ? part : part.replace(/\*+|_{2,}/g, ''))
        .join('').trim().replace(/ {2,}/g, ' ');
      const plain = text.replace(/\*\*([^*]+)\*\*/g, '$1');
      // Measure visible prose, not Markdown delimiters: adding/removing bold
      // must not change acceptance, including compact CJK explanations.
      if (plain.length > 650 || !/[\p{L}\p{N}]/u.test(plain)) { reject('Use a nonempty explanation of at most 650 characters.'); continue; }
      if (/[\n\r<>`\[\]*]|https?:\/\//.test(plain)) { reject('Use one line of prose without HTML, code, links, brackets or term markers.'); continue; }
      if (!/[.!?。！？؟۔।॥]["”’»」』)]?$/.test(plain)) { reject('Finish the sentence with punctuation appropriate to its language.'); continue; }
      // Segment sentences where the platform supports it; abbreviations and
      // decimal points are not naively treated as extra sentences.
      if (typeof Intl.Segmenter === 'function') {
        const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(plain)]
          .filter(part => /[\p{L}\p{N}]/u.test(part.segment));
        if (sentences.length !== 1) { reject('The explanation contains multiple sentences. Rewrite it as exactly one complete sentence.'); continue; }
      }
      result[key] = text;
      delete issues[key];
    }
  } catch {
    for (const term of terms) issues[termPreviewKey(term)] = { reason: 'The response was not valid JSON with a previews array. Return only the required JSON object.' };
  }
  return { entries: result, issues };
}

/** Compatibility helper for callers that only need valid entries. */
export function parseTermPreviews(raw: string, terms: string[]): Record<string, string> {
  return inspectTermPreviews(raw, terms).entries;
}

export function termPreviewFor(version: NodeVersion | undefined, term: string): string | undefined {
  if (!version || version.termPreviews?.fingerprint !== termPreviewFingerprint(version)) return;
  const entries = version.termPreviews.entries;
  const key = termPreviewKey(term);
  return Object.hasOwn(entries, key) && typeof entries[key] === 'string' ? entries[key] : undefined;
}

/** One primary group, one smaller repair, then one single-term repair only for
 * persistent formatting failures. Successful entries are never regenerated. */
export async function completeTermPreviews(
  version: NodeVersion,
  terms: string[],
  complete: (request: ReturnType<typeof previewRequest>) => Promise<string>,
  commit: (entries: Record<string, string>) => void,
): Promise<string[]> {
  const repairs: Record<string, TermPreviewIssue> = Object.create(null);
  const request = async (batch: string[]) => {
    let raw: string;
    try { raw = await complete(previewRequest(version, batch,
      batch.some(term => repairs[termPreviewKey(term)]) ? repairs : undefined)); }
    catch (error) {
      if (error instanceof GenerationOutputLimitError
        || (error instanceof Error && error.message === 'The secondary model reached its output limit.')) {
        for (const term of batch) repairs[termPreviewKey(term)] = { reason: 'The previous response reached its output limit. Keep the sentence concise while retaining all required parts.' };
        return batch;
      }
      throw error;
    }
    const { entries, issues } = inspectTermPreviews(raw, batch);
    for (const term of batch) {
      const key = termPreviewKey(term);
      if (issues[key]) repairs[key] = issues[key]; else delete repairs[key];
    }
    commit(entries);
    return batch.filter(term => !entries[termPreviewKey(term)]);
  };
  const failed: string[] = [];
  for (let i = 0; i < terms.length; i += TERM_PREVIEW_BATCH_SIZE) {
    const missing = await request(terms.slice(i, i + TERM_PREVIEW_BATCH_SIZE));
    const remaining: string[] = [];
    for (let j = 0; j < missing.length; j += 8) remaining.push(...await request(missing.slice(j, j + 8)));
    for (const term of remaining) failed.push(...await request([term]));
  }
  return failed;
}
