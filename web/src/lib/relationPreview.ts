import { parseBody, stripChips } from './bulletParse';
import { termLabel, type TermLabelPart } from './termLabel';

export interface FittedRelationPreview {
  text: string;
  leading: string;
  faded: string;
  truncated: boolean;
}

const CITATION_RE = /⟦\d+⟧/g;
const MARKDOWN_LINK_RE = /!?\[([^\]]*)\]\([^)]+\)/g;
const TRAILING_AWKWARD_RE = /[\s\p{P}\p{S}]+$/gu;

/** Opening prose as quiet, readable tooltip copy rather than Markdown source. */
export function openingParagraphPreview(body: string, preserveEmphasis = false): string {
  const opening = parseBody(body)?.freeText ?? '';
  return stripChips(opening)
    .replace(CITATION_RE, '')
    .replace(MARKDOWN_LINK_RE, '$1')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(preserveEmphasis ? /[`]+/g : /[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/** Slice by visible character positions, never through Markdown delimiters. */
export function previewFormattedParts(markdown: string, from = 0, to = Infinity): TermLabelPart[] {
  let offset = 0;
  return termLabel(markdown).parts.flatMap(part => {
    const start = offset;
    offset += part.text.length;
    const text = part.text.slice(Math.max(0, from - start), Math.max(0, Math.min(part.text.length, to - start)));
    return text ? [{ ...part, text }] : [];
  });
}

/** A cut preview must end in a readable glyph, never a dangling comma/dash. */
export function cleanPreviewTail(value: string): string {
  const cleaned = value.trimEnd().replace(TRAILING_AWKWARD_RE, '').trimEnd();
  return cleaned || value.trim();
}

function splitFadeTail(text: string): { leading: string; faded: string } {
  const chars = Array.from(text);
  const fadeCount = Math.min(2, chars.length);
  return {
    leading: chars.slice(0, chars.length - fadeCount).join(''),
    faded: chars.slice(chars.length - fadeCount).join(''),
  };
}

function wordCandidates(text: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const words = [...text.matchAll(/\S+/gu)];
  for (const word of words) {
    const end = (word.index ?? 0) + word[0].length;
    const candidate = cleanPreviewTail(text.slice(0, end));
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      values.push(candidate);
    }
  }
  return values;
}

/**
 * Longest word-safe preview that fits alongside the click icon. `fits` owns
 * the real DOM typography measurement, keeping this search pure and testable.
 */
export function fitRelationPreview(
  rawText: string,
  fits: (candidate: string) => boolean,
): FittedRelationPreview {
  const text = rawText.replace(/\s+/g, ' ').trim();
  if (!text) return { text: '', leading: '', faded: '', truncated: false };

  const full = cleanPreviewTail(text);
  if (fits(full)) {
    const tail = splitFadeTail(full);
    return { text: full, ...tail, truncated: full !== text };
  }

  const candidates = wordCandidates(text);
  let best = '';
  // A candidate is not strictly harder to fit just because it is longer:
  // the final word and click icon are kept together, so adding a short word
  // can move a previously long tail back into normally wrapping text. Check
  // every word boundary rather than using a monotonic binary search; previews
  // are tiny and this avoids needlessly collapsing a multi-line result.
  for (const candidate of candidates) {
    if (fits(candidate)) {
      best = candidate;
    }
  }

  // A single very long word can exceed the preview box. Preserve a readable
  // prefix instead of dropping the preview entirely.
  if (!best) {
    const chars = Array.from(full);
    let low = 1;
    let high = chars.length;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = cleanPreviewTail(chars.slice(0, middle).join(''));
      if (candidate && fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }

  const fitted = best || Array.from(full)[0] || '';
  const tail = splitFadeTail(fitted);
  return {
    text: fitted,
    ...tail,
    truncated: fitted !== text,
  };
}

export function previewTailParts(text: string): {
  head: string;
  tailLeading: string;
  faded: string;
} {
  const { leading, faded } = splitFadeTail(text);
  const boundary = leading.lastIndexOf(' ');
  return boundary < 0
    ? { head: '', tailLeading: leading, faded }
    : {
        head: leading.slice(0, boundary + 1),
        tailLeading: leading.slice(boundary + 1),
        faded,
      };
}
