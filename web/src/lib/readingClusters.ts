/**
 * Reading-ruler cluster segmentation (pure — no DOM).
 *
 * The word-by-word reading mode doesn't step literal words: it steps
 * CLUSTERS, the natural reading units of a node body:
 *
 *   - a whole term chip (`.ref-chip`) is one cluster,
 *   - a whole bold phrase (`<strong>`) is one cluster,
 *   - plain text splits on whitespace (punctuation stays attached),
 *   - a punctuation-only token (like the `: ` separator between a child
 *     name and its description) merges into the previous cluster,
 *   - a standalone article (a / an / the, case-insensitive, whole token)
 *     merges with the FOLLOWING cluster of any kind ("the" + chip = one).
 *
 * Input is the section's flat text plus ordered, non-overlapping segments
 * that tile it (produced by the DOM walk in readingDom.ts). Output clusters
 * are [start, end) char ranges into that same flat text — they may span
 * whitespace (merges) and later wrap across visual lines; that's fine, the
 * line model handles wrapping.
 */

import { languageInfo, normalizeLanguage, READING_ARTICLES, type GenerationLanguage } from './languages';
export type SegmentKind = 'text' | 'chip' | 'bold';

export interface Segment {
  start: number;
  end: number; // exclusive
  kind: SegmentKind;
}

export interface Cluster {
  start: number;
  end: number; // exclusive
}

const segmenters = new Map<string, Intl.Segmenter>();
/** A cluster with no letter/number is "punctuation-only" (never stands alone). */
const WORDLIKE_RE = /[\p{L}\p{N}\p{M}]/u;

/**
 * Narrow a [start, end) range to its word-like core — strip leading and
 * trailing punctuation, keep any internal (so "U.S.A." → "U.S.A", "settlement."
 * → "settlement", "(hi)" → "hi"). Returns null when the range holds no letter
 * or number at all. Used to paint the WORD highlight without the punctuation.
 */
export function trimToWord(text: string, start: number, end: number): Cluster | null {
  let s = start;
  let e = end;
  const characters = [...text.slice(start, end)];
  while (characters.length && !WORDLIKE_RE.test(characters[0]!)) s += characters.shift()!.length;
  while (characters.length && !WORDLIKE_RE.test(characters.at(-1)!)) e -= characters.pop()!.length;
  return e > s ? { start: s, end: e } : null;
}

interface Token extends Cluster {
  kind: SegmentKind;
}

export function buildClusters(text: string, segments: Segment[], language: GenerationLanguage = 'en'): Cluster[] {
  // 1. Tokenize: chip/bold segments become one token (whitespace-trimmed);
  //    text segments split into whitespace-separated tokens.
  const tokens: Token[] = [];
  for (const segment of segments) {
    const s = text.slice(segment.start, segment.end);
    if (segment.kind === 'chip' || segment.kind === 'bold') {
      const from = s.length - s.trimStart().length;
      const to = s.trimEnd().length;
      if (to > from) tokens.push({ start: segment.start + from, end: segment.start + to, kind: segment.kind });
      continue;
    }
    // Use dictionary word boundaries for scripts without inter-word spaces.
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) {
      if (typeof Intl.Segmenter !== 'function') {
        let offset = segment.start;
        for (const character of s) {
          if (character.trim()) tokens.push({ start: offset, end: offset + character.length, kind: 'text' });
          offset += character.length;
        }
        continue;
      }
      const locale = languageInfo(language).locale;
      let segmenter = segmenters.get(locale);
      if (!segmenter) { segmenter = new Intl.Segmenter(locale, { granularity: 'word' }); segmenters.set(locale, segmenter); }
      for (const part of segmenter.segment(s)) if (part.segment.trim()) {
        tokens.push({ start: segment.start + part.index, end: segment.start + part.index + part.segment.length, kind: 'text' });
      }
      continue;
    }
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      tokens.push({ start: segment.start + m.index, end: segment.start + m.index + m[0].length, kind: 'text' });
    }
  }

  // 2. Punctuation-only tokens merge backward (forward when nothing precedes).
  const merged: Token[] = [];
  let leadStart: number | null = null; // leading punctuation waiting for a word
  for (const t of tokens) {
    if (!WORDLIKE_RE.test(text.slice(t.start, t.end))) {
      const last = merged[merged.length - 1];
      if (last) last.end = t.end;
      else if (leadStart === null) leadStart = t.start;
      continue;
    }
    merged.push({ start: leadStart ?? t.start, end: t.end, kind: t.kind });
    leadStart = null;
  }

  // 3. A standalone article (plain text only — a chip labeled "the" is a
  //    term, not an article) merges with the following cluster.
  const out: Cluster[] = [];
  for (let i = 0; i < merged.length; i++) {
    const t = merged[i]!;
    const follower = merged[i + 1];
    const isArticle = t.kind === 'text' && READING_ARTICLES[normalizeLanguage(language)]?.has(text.slice(t.start, t.end).toLocaleLowerCase(languageInfo(language).locale));
    if (isArticle && follower) {
      out.push({ start: t.start, end: follower.end });
      i++;
    } else {
      out.push({ start: t.start, end: t.end });
    }
  }
  return out;
}
