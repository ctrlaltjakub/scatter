import { inlineEmphasis } from './inlineEmphasis';

export interface ProseLine {
  text: string;
  /** Offsets into the original source, before Markdown emphasis is rebalanced. */
  start: number;
  end: number;
}

/** Authored line boundaries, not guessed grammatical sentence boundaries.
 * No abbreviation dictionaries, language assumptions, or punctuation fallback.
 * Empty lines remain available in the gaps between source ranges so callers
 * can distinguish sentence lines from separate paragraphs. */
export function explicitLineSegments(source: string): ProseLine[] {
  const lines: ProseLine[] = [];
  // Legacy term marking could wrap an entire multiline phrase. Keep that
  // existing link atomic rather than exposing half of its [[...]] markup.
  // New term marking never creates links across source lines.
  const terms = [...source.matchAll(/\[\[[\s\S]*?\]\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  let termIndex = 0;
  // Most emphasis stays inside one line. Avoid re-parsing/re-scanning the full
  // paragraph for every line, especially in long generated answers.
  const crossing = [...inlineEmphasis(source)].filter(([, span]) =>
    /[\n\r\u2028\u2029]/u.test(source.slice(span.contentStart, span.contentEnd)))
    .sort(([a], [b]) => a - b);
  const add = (from: number, to: number) => {
    while (from < to && /\s/u.test(source[from]!)) from++;
    while (to > from && /\s/u.test(source[to - 1]!)) to--;
    if (from === to) return;
    const before = crossing.filter(([start, span]) => start < from && span.contentEnd > from)
      .map(([start, span]) => source.slice(start, span.contentStart)).join('');
    const after = crossing.filter(([, span]) => span.contentStart < to && span.end > to)
      .reverse().map(([, span]) => source.slice(span.contentEnd, span.end)).join('');
    const text = before + source.slice(from, to) + after;
    if (text) lines.push({ text, start: from, end: to });
  };
  let start = 0;
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    while (terms[termIndex] && terms[termIndex]!.end <= match.index) termIndex++;
    if (terms[termIndex] && terms[termIndex]!.start < match.index && match.index < terms[termIndex]!.end) continue;
    add(start, match.index);
    start = match.index + match[0].length;
  }
  add(start, source.length);
  return lines;
}

/** For consumers that already keep their own text/Markdown position mapping. */
export function explicitLineSplitPoints(source: string): number[] {
  // Plain DOM/AST consumers need offsets only: no Markdown parsing on the
  // streaming render path. A leading/empty line does not create a new unit.
  const starts: number[] = [];
  for (const match of source.matchAll(/(?:^|\r\n|[\n\r\u2028\u2029])([^\S\n\r\u2028\u2029]*)([^\s])/gu)) {
    starts.push(match.index + match[0].length - match[2]!.length);
  }
  return starts.slice(1);
}

export function splitExplicitLines(source: string): string[] {
  return explicitLineSegments(source).map(line => line.text);
}

export function hasParagraphBreak(separator: string): boolean {
  return /\n[\t ]*\n|\u2029/u.test(separator.replace(/\r\n?|\u2028/g, '\n'));
}
