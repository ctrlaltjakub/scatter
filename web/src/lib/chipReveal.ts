/**
 * Legacy annotated-copy validation utilities. Active term marking now uses
 * JSON selection and local insertion in termMarking.ts instead.
 *
 * Pass 1 produces a finished PLAIN body (`base`). Pass 2 streams the same text
 * back with `[[chip]]` markers inserted; the completed output is validated by
 * `validateChips` and applied in ONE shot. (A progressive per-frame reveal
 * used to live here — `revealChips` — but writing partial markings into the
 * store each frame re-ran the whole parse/measure pipeline per frame and froze
 * long nodes for the entire marking pass, so it was removed.)
 *
 * Pure functions only — unit-tested in chipReveal.test.ts.
 */

/** Strip ONLY the `[[` / `]]` chip markers. Leaves `**bold**`, whitespace and
 *  newlines untouched. */
export function plain(s: string): string {
  return s.replace(/\[\[/g, '').replace(/\]\]/g, '');
}

interface ParsedChipOutput {
  text: string;
  spans: Array<[number, number]>;
}

/** Strip chip delimiters while recording their ranges in the resulting text. */
function parseChipOutput(value: string): ParsedChipOutput | null {
  let text = '';
  let openAt: number | null = null;
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '[' && value[i + 1] === '[') {
      if (openAt != null) return null;
      openAt = text.length;
      i++;
      continue;
    }
    if (value[i] === ']' && value[i + 1] === ']') {
      if (openAt == null || openAt === text.length) return null;
      spans.push([openAt, text.length]);
      openAt = null;
      i++;
      continue;
    }
    text += value[i];
  }
  return openAt == null ? { text, spans } : null;
}

interface CanonicalText {
  text: string;
  boundaryToCanonical: number[];
  charStarts: number[];
  charEnds: number[];
}

/**
 * Remove only Markdown strong-emphasis delimiters. The maps let us translate
 * a term selected by a model that dropped/repositioned `**` or `__` back onto
 * the exact original bytes.
 */
function canonicalizeStrong(value: string): CanonicalText {
  let text = '';
  const boundaryToCanonical = new Array<number>(value.length + 1).fill(0);
  const charStarts: number[] = [];
  const charEnds: number[] = [];
  let canonicalIndex = 0;
  for (let i = 0; i < value.length;) {
    boundaryToCanonical[i] = canonicalIndex;
    const pair = value.slice(i, i + 2);
    if (pair === '**' || pair === '__') {
      boundaryToCanonical[i + 1] = canonicalIndex;
      boundaryToCanonical[i + 2] = canonicalIndex;
      i += 2;
      continue;
    }
    text += value[i];
    charStarts.push(i);
    charEnds.push(i + 1);
    canonicalIndex++;
    boundaryToCanonical[i + 1] = canonicalIndex;
    i++;
  }
  return { text, boundaryToCanonical, charStarts, charEnds };
}

/** Apply semantic chip ranges to the untouched original Markdown. */
function applyChipRanges(base: string, ranges: Array<[number, number]>): string {
  let result = base;
  const unique = [...new Map(ranges.map((range) => [`${range[0]}:${range[1]}`, range])).values()]
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (const [start, end] of unique) {
    result = `${result.slice(0, start)}[[${result.slice(start, end)}]]${result.slice(end)}`;
  }
  return result;
}

/**
 * Accept ONLY the model's chip choices and reapply them to the exact original
 * body. A model may drop or move strong-emphasis delimiters; everything else
 * must remain byte-identical after canonicalization or the pass safely falls
 * back to `base` with no chips.
 */
export function validateChips(acc: string, base: string): string {
  if (!acc.trim()) return base;

  // Pass 2's whole job is to ADD chips. Zero chips means the model no-op'd or
  // returned preamble — fall back to plain `base` (identical text, no worse).
  if (!acc.includes('[[')) return base;

  const parsed = parseChipOutput(acc);
  if (!parsed || parsed.spans.length === 0) return base;
  const outputCanonical = canonicalizeStrong(parsed.text);
  const baseCanonical = canonicalizeStrong(base);
  if (outputCanonical.text !== baseCanonical.text) return base;

  const ranges: Array<[number, number]> = [];
  for (const [outputStart, outputEnd] of parsed.spans) {
    const semanticStart = outputCanonical.boundaryToCanonical[outputStart];
    const semanticEnd = outputCanonical.boundaryToCanonical[outputEnd];
    if (semanticStart == null || semanticEnd == null || semanticStart >= semanticEnd) return base;
    const start = baseCanonical.charStarts[semanticStart];
    const end = baseCanonical.charEnds[semanticEnd - 1];
    if (start == null || end == null || start >= end) return base;
    ranges.push([start, end]);
  }
  return applyChipRanges(base, ranges);
}
