import Fuse from 'fuse.js';
import { parseBody } from './bulletParse';
import { cleanMarkdown } from './searchNodes';

/* -------------------------------------------------------------------------
 * In-canvas search highlighting — find DOM ranges for the search match.
 *
 * Uses the SAME fuzzy engine (Fuse.js) and config as the sidebar, so the
 * characters highlighted inside a node match exactly what the sidebar
 * matched. Pure DOM here (no CSS Custom Highlight API — that lives in the
 * SearchHighlighter component); returns `Range`s the caller hands to a
 * `Highlight`.
 *
 * Each node text container (`.node-header` title + `.node-body`) becomes a
 * "block": its concatenated visible text plus an offset map back to the
 * underlying text nodes. We fuzzy-match the query against each block's text,
 * then map the matched character ranges back to DOM Ranges (splitting at
 * text-node boundaries when a match spans them).
 *
 * The body contains AdaptiveBullets' hidden measurement copies
 * (`.sc-ab-measure`, `aria-hidden`); those are skipped so we never highlight
 * invisible text.
 * ------------------------------------------------------------------------*/

const SELECTOR = '.node-header, .node-body:not(.chat-node-body), .chat-user-message, .chat-markdown';
const HIDDEN_SELECTOR = '[aria-hidden="true"], .sc-ab-measure';
const MIN_LEN = 2;

interface TextSpan {
  node: Text;
  start: number; // global offset of this text node within the block
  end: number; // exclusive
}
interface Block {
  text: string;
  spans: TextSpan[];
}

/** Concatenate a container's visible text + remember where each text node sits.
 *  Text inside hidden measurement copies is skipped. */
function buildBlock(container: Element): Block {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n as Text).parentElement?.closest(HIDDEN_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  const spans: TextSpan[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const v = t.nodeValue ?? '';
    if (!v) continue;
    spans.push({ node: t, start: text.length, end: text.length + v.length });
    text += v;
  }
  return { text, spans };
}

/** Map a [start, end) global range within a block to DOM Ranges, split at
 *  text-node boundaries (a fuzzy match can straddle two text nodes). */
function mapToRanges(block: Block, start: number, end: number): Range[] {
  const out: Range[] = [];
  for (const span of block.spans) {
    if (span.end <= start || span.start >= end) continue; // no overlap
    const localStart = Math.max(start, span.start) - span.start;
    const localEnd = Math.min(end, span.end) - span.start;
    if (localEnd <= localStart) continue;
    const range = document.createRange();
    range.setStart(span.node, localStart);
    range.setEnd(span.node, localEnd);
    out.push(range);
  }
  return out;
}

export function collectSearchRanges(root: ParentNode, query: string): Range[] {
  const q = query.trim();
  if (q.length < MIN_LEN) return [];

  const blocks = Array.from(root.querySelectorAll(SELECTOR))
    .map(buildBlock)
    .filter((b) => b.text.length > 0);
  if (blocks.length === 0) return [];

  // Same engine + config as the sidebar index (src/lib/searchNodes.ts) so the
  // highlighted characters match what the sidebar matched.
  const fuse = new Fuse(blocks, {
    keys: ['text'],
    includeMatches: true,
    ignoreLocation: true,
    findAllMatches: true,
    threshold: 0.4,
    minMatchCharLength: MIN_LEN,
  });

  const out: Range[] = [];
  for (const result of fuse.search(q)) {
    const match = result.matches?.find((m) => m.key === 'text');
    if (!match) continue;
    for (const [s, e] of match.indices) {
      // Fuse indices are inclusive; convert to a [start, end) half-open range.
      out.push(...mapToRanges(result.item, s, e + 1));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Per-bullet match markers — which bullets (by index) contain the query in
 * their FULL text, so a left-margin line can flag a bullet whose matching
 * detail is currently collapsed/hidden. Driven by the parsed body data (not
 * the DOM), because collapsed bullet detail isn't rendered at all.
 * ------------------------------------------------------------------------*/

export function matchingBulletIndices(body: string, query: string): number[] {
  const q = query.trim();
  if (q.length < MIN_LEN) return [];
  const parsed = parseBody(body);
  if (!parsed || parsed.bullets.length === 0) return [];

  // Reconstruct the node's full text (freetext + every bullet, including the
  // collapsed detail that isn't in the DOM) and match it the SAME way the
  // visible-text highlight does — one Fuse pass over the whole string with
  // `includeMatches`, then keep only matched CHARACTER ranges. Matching each
  // bullet in isolation (short string) was too lenient and produced false
  // positives ("zebra" loosely matching an unrelated short bullet), so a
  // marker could appear on a bullet that, once expanded, highlights nothing.
  // Going whole-text + index-based makes the marker agree with the highlight.
  let text = cleanMarkdown(parsed.freeText);
  const spans: { i: number; start: number; end: number }[] = [];
  parsed.bullets.forEach((b, i) => {
    if (text.length > 0) text += ' ';
    const start = text.length;
    text += cleanMarkdown([b.title, ...b.children.flatMap((c) => [c.name, c.desc])].join(' '));
    spans.push({ i, start, end: text.length });
  });

  const fuse = new Fuse([{ text }], {
    keys: ['text'],
    includeMatches: true,
    findAllMatches: true,
    ignoreLocation: true,
    threshold: 0.4,
    minMatchCharLength: MIN_LEN,
  });
  const result = fuse.search(q)[0];
  const match = result?.matches?.find((m) => m.key === 'text');
  if (!match) return [];

  const hit = new Set<number>();
  for (const [s, e] of match.indices) {
    for (const span of spans) {
      if (span.end <= s || span.start >= e + 1) continue; // [s, e] inclusive
      hit.add(span.i);
    }
  }
  return [...hit].sort((a, b) => a - b);
}

const MARKER_CONTAINER = 'sc-bullet-markers';
const MARKER_LINE = 'sc-bullet-marker';

/** The set of bullet rows that already contain a VISIBLE highlight range, so
 *  the marker for them can be skipped (the in-text highlight covers it). */
export function rowsWithVisibleMatch(ranges: Range[]): Set<Element> {
  const set = new Set<Element>();
  for (const r of ranges) {
    const row = r.startContainer.parentElement?.closest('.sc-ab-item[data-sc-anchor]');
    if (row) set.add(row);
  }
  return set;
}

/** Draw left-margin lines next to the matching bullets of each node card.
 *  Imperative (no React re-render of the bullet cascade). `getBody` returns a
 *  node's current body markdown; `zoom` converts screen rects to card-local
 *  px (the markers live inside the zoom-scaled card). A bullet whose row is in
 *  `visibleRows` is skipped — its match is already shown by the in-text
 *  highlight (e.g. the match is in the always-visible title). Pass an empty
 *  query to clear every marker. */
export function updateBulletMarkers(
  root: ParentNode,
  query: string,
  getBody: (nodeId: string) => string | undefined,
  zoom: number,
  visibleRows: Set<Element>,
): void {
  const q = query.trim();
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-node-id]'));
  for (const card of cards) {
    const container = card.querySelector<HTMLElement>('.' + MARKER_CONTAINER);
    if (!container) continue;
    container.replaceChildren();
    if (q.length < MIN_LEN) continue;

    const nodeId = card.dataset.nodeId;
    const body = nodeId ? getBody(nodeId) : undefined;
    if (!body) continue;
    const matched = new Set(matchingBulletIndices(body, query));
    if (matched.size === 0) continue;

    const cardRect = card.getBoundingClientRect();
    const safeZoom = zoom > 0 ? zoom : 1;
    // Visible bullet rows only — hidden measurement copies have no data-sc-anchor.
    const rows = card.querySelectorAll<HTMLElement>('.sc-ab-item[data-sc-anchor^="b-"]');
    rows.forEach((row) => {
      const idx = Number(row.dataset.scAnchor?.slice(2));
      if (!Number.isInteger(idx) || !matched.has(idx)) return;
      if (visibleRows.has(row)) return; // match already shown by the in-text highlight
      const rect = row.getBoundingClientRect();
      const top = (rect.top - cardRect.top) / safeZoom;
      const height = rect.height / safeZoom;
      const line = document.createElement('div');
      line.className = MARKER_LINE;
      line.style.top = `${top}px`;
      line.style.height = `${height}px`;
      container.appendChild(line);
    });
  }
}
