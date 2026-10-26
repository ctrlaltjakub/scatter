import Fuse from 'fuse.js';
import type { ScatterNode } from '@/store/types';
import type { ChatAnswerRef } from '@/store/chatTypes';

/* -------------------------------------------------------------------------
 * Node search (fuzzy, typo-tolerant) for the sidebar search bar.
 *
 * Built on Fuse.js. The index is built once per node-set change
 * (`buildSearchIndex`) and queried per keystroke (`searchNodes`). Each node
 * contributes only its currently displayed version. Switching a
 * node's version rebuilds the sidebar index, so search always matches what is
 * actually visible on the canvas.
 *
 * Matches highlight the matched CHARACTERS (from Fuse's `indices`), which
 * for a fuzzy match may be scattered rather than a clean contiguous phrase.
 * `splitByRanges` turns a string + its bold ranges into render segments.
 * ------------------------------------------------------------------------*/

/** One bold range is an inclusive [start, end] char index pair (Fuse style). */
export interface Fragment {
  text: string;
  ranges: [number, number][];
}

export interface SearchResult {
  nodeId: string;
  sourceAnswer?: ChatAnswerRef;
  /** The node's current-version header (always shown as the row title). */
  title: string;
  /** Bold ranges within `title` (empty when the match was body-only). */
  titleRanges: [number, number][];
  /** One per distinct match window in the body (or a lead-in when title-only). */
  fragments: Fragment[];
}

interface SearchRecord {
  nodeId: string;
  sourceAnswer?: ChatAnswerRef;
  title: string;
  body: string;
}

// Snippet geometry (chars).
const PAD = 40; // context kept on each side of a match window
const MERGE_GAP = 80; // matches closer than this share one fragment window
const MAX_FRAGMENTS = 5; // cap fragment lines per node
const LEAD_IN = 80; // body lead-in length for a title-only match

/** Fuse scores are approximate. Within this distance deterministic title/ID
 * ordering keeps rows stable while typing. */
export const SEARCH_SCORE_TIE_EPSILON = 0.01;

const REF_RE = /(?<!\[)\[\[([^\[\]]+?)\]\](?!\])/g;

/** Markdown → plain display text. Mirrors `parser.ts` (refs) and the
 *  emphasis logic in `bulletParse.ts` so fragments read cleanly AND so
 *  Fuse's match indices line up with what we render. Self-consistent: the
 *  cleaned body is both indexed and displayed. */
export function cleanMarkdown(md: string): string {
  let s = md ?? '';
  s = s.replace(REF_RE, '$1'); // [[term]] -> term
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1'); // **bold**
  s = s.replace(/__([^_]+)__/g, '$1'); // __bold__
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1'); // *italic*
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, '$1'); // _italic_
  s = s.replace(/^#{1,6}[ \t]+/gm, ''); // # headings
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, ''); // - bullet markers
  s = s.replace(/\s+/g, ' ').trim(); // collapse newlines/whitespace
  return s;
}

export function buildSearchIndex(nodes: ScatterNode[], previews: Record<string, { previews: Record<string, number> }> = {}): Fuse<SearchRecord> {
  const records: SearchRecord[] = [];
  for (const n of nodes) {
    if (n.chat) {
      for (const turn of n.chat.turns) {
        const createdAt = previews[n.id]?.previews[turn.id] ?? turn.selectedVersionCreatedAt;
        const answer = n.versions.find((version) => version.createdAt === createdAt && version.chat?.turnId === turn.id);
        if (!answer?.chat) continue;
        records.push({ nodeId: n.id, sourceAnswer: { turnId: turn.id, versionCreatedAt: createdAt },
          title: `${n.chat.title} · ${answer.chat.title}`, body: cleanMarkdown(`${answer.chat.question}\n${answer.body}`) });
      }
      continue;
    }
    const v = n.versions[n.currentVersionIndex];
    if (!v) continue;
    records.push({
      nodeId: n.id,
      title: v.header ?? '',
      body: cleanMarkdown(v.body ?? ''),
    });
  }
  return new Fuse(records, {
    keys: [
      { name: 'title', weight: 2 },
      { name: 'body', weight: 1 },
    ],
    includeMatches: true,
    includeScore: true,
    ignoreLocation: true, // match anywhere in long bodies
    findAllMatches: true, // collect every match (multiple fragments)
    threshold: 0.4,
    minMatchCharLength: 2,
  });
}

export function searchNodes(index: Fuse<SearchRecord>, query: string): SearchResult[] {
  const q = query.trim();
  if (!q) return [];

  interface RankedResult {
    result: SearchResult;
    score: number;
  }

  const bestByNode = new Map<string, RankedResult>();

  for (const r of index.search(q)) {
    const rec = r.item;

    const matches = r.matches ?? [];
    const titleMatch = matches.find((m) => m.key === 'title');
    const bodyMatch = matches.find((m) => m.key === 'body');

    const titleRanges = titleMatch ? sortRanges(titleMatch.indices) : [];
    const fragments =
      bodyMatch && bodyMatch.indices.length > 0
        ? buildFragments(rec.body, bodyMatch.indices)
        : [leadIn(rec.body)];

    const candidate: RankedResult = {
      result: {
        nodeId: rec.nodeId,
        ...(rec.sourceAnswer ? { sourceAnswer: rec.sourceAnswer } : {}),
        title: rec.title,
        titleRanges,
        fragments,
      },
      score: r.score ?? 1,
    };
    const key = `${rec.nodeId}:${rec.sourceAnswer?.turnId ?? ''}`;
    const previous = bestByNode.get(key);
    if (!previous || compareRanked(candidate, previous) < 0) {
      bestByNode.set(key, candidate);
    }
  }

  return [...bestByNode.values()]
    .sort(compareRanked)
    .map(({ result }) => result);
}

function compareRanked(a: {
  result: SearchResult;
  score: number;
}, b: {
  result: SearchResult;
  score: number;
}): number {
  const scoreDifference = a.score - b.score;
  if (Math.abs(scoreDifference) > SEARCH_SCORE_TIE_EPSILON) return scoreDifference;
  const titleOrder = a.result.title.localeCompare(b.result.title, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  if (titleOrder !== 0) return titleOrder;
  return a.result.nodeId.localeCompare(b.result.nodeId, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

function sortRanges(indices: readonly [number, number][]): [number, number][] {
  return indices.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
}

/** Group nearby match ranges into windowed, ellipsised fragments with
 *  bold ranges re-based to each window. */
function buildFragments(body: string, indices: readonly [number, number][]): Fragment[] {
  const ranges = sortRanges(indices);
  if (ranges.length === 0) return [leadIn(body)];

  const groups: [number, number][][] = [];
  let cur: [number, number][] = [];
  let prevEnd = -Infinity;
  for (const r of ranges) {
    if (cur.length > 0 && r[0] - prevEnd > MERGE_GAP) {
      groups.push(cur);
      cur = [];
    }
    cur.push(r);
    prevEnd = r[1];
  }
  if (cur.length > 0) groups.push(cur);

  return groups.slice(0, MAX_FRAGMENTS).map((group) => {
    const first = group[0]![0];
    const last = group[group.length - 1]![1];
    const start = Math.max(0, first - PAD);
    const end = Math.min(body.length, last + 1 + PAD); // slice end (exclusive)
    const prefix = start > 0 ? '…' : '';
    const suffix = end < body.length ? '…' : '';
    const off = prefix.length - start;
    return {
      text: prefix + body.slice(start, end) + suffix,
      ranges: group.map(([s, e]) => [s + off, e + off] as [number, number]),
    };
  });
}

function leadIn(body: string): Fragment {
  if (!body) return { text: '', ranges: [] };
  const text = body.length > LEAD_IN ? body.slice(0, LEAD_IN) + '…' : body;
  return { text, ranges: [] };
}

/** Turn `text` + inclusive bold `ranges` into ordered render segments. */
export function splitByRanges(
  text: string,
  ranges: [number, number][],
): { text: string; bold: boolean }[] {
  if (ranges.length === 0) return [{ text, bold: false }];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: { text: string; bold: boolean }[] = [];
  let cursor = 0;
  for (const [s, e] of sorted) {
    const end = e + 1;
    if (end <= cursor) continue; // fully inside an earlier (overlapping) range
    if (s > cursor) out.push({ text: text.slice(cursor, s), bold: false });
    out.push({ text: text.slice(Math.max(cursor, s), end), bold: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), bold: false });
  return out.filter((seg) => seg.text.length > 0);
}
