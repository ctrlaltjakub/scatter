import { normalizeLanguage } from './languages';
/**
 * Reading-ruler DOM glue — the only layer that touches layout.
 *
 * Builds the per-keypress SECTION MODEL (flat text + spans + clusters +
 * visual lines) for one section of a node card, and paints the current
 * position via the CSS Custom Highlight API (the SearchHighlighter
 * precedent: zero DOM mutation, ranges repaint on their own when the
 * canvas pans/zooms).
 *
 * Nothing here is cached across keypresses: the adaptive-bullet cascade
 * re-renders section content when the active section changes, which kills
 * live Ranges — so the model is rebuilt fresh each time (sections are a
 * few hundred characters; the rebuild is trivially cheap).
 */
import { buildClusters, trimToWord, type Cluster, type Segment } from './readingClusters';
import { findWrapBreak, groupIntoLines, type Fragment, type Line } from './readingLines';
import type { SectionShape } from './readingNav';

const LINE_HIGHLIGHT = 'sc-read-line';
const WORD_HIGHLIGHT = 'sc-read-word';

/** Same exclusions as searchHighlight, plus the `•` marker glyphs — they are
 *  visual furniture, not readable text. */
const SKIP_SELECTOR = '[aria-hidden="true"], [data-reading-exclude], .sc-ab-measure, .sc-ab-bullet-mark, .sc-ab-child-mark';

interface TextSpan {
  node: Text;
  start: number; // global offset within the section's flat text
  end: number; // exclusive
}

export interface SectionModel {
  /** Flat text of the section (concatenated visible text nodes). */
  text: string;
  spans: TextSpan[];
  /** Measurable clusters in reading order (unmeasurable ones are dropped). */
  clusters: Cluster[];
  lines: Line[];
  shape: SectionShape;
}

export type ReadingReferenceElement = {
  kind: 'term';
  parentNodeId: string;
  term: string;
  childId: string | null;
  element: HTMLElement;
} | {
  kind: 'selection';
  parentNodeId: string;
  childId: string;
  arrowId: string;
  element: HTMLElement;
};

/** The DOM element holding one section's content. Anchors exist only on
 *  visible content (the hidden measurement labs carry none). */
export function sectionElement(cardEl: Element, stop: number): Element | null {
  if (cardEl.hasAttribute('data-sc-reading-table')) return cardEl.querySelector('.chat-markdown');
  if (cardEl.classList.contains('chat-node')) return cardEl.querySelectorAll('.chat-assistant .chat-markdown')[stop] ?? null;
  return cardEl.querySelector(
    stop <= 0 ? '[data-sc-anchor="ft"]' : `[data-sc-anchor="b-${stop - 1}"]`,
  );
}

/** Walk a section's visible text nodes into a flat string + span map + cluster
 *  segments (chip / bold / plain). Adjacent text nodes merge into one segment
 *  ONLY when they share the same owning element, so two blocks butting together
 *  with no whitespace between them — e.g. two trimmed `.sc-ab-sentence` spans
 *  ("…settlement." then "Augustus…") — don't fuse the sentence-final period
 *  into the next sentence's first word. Exported for jsdom tests. */
export function buildSectionSegments(sectionEl: Element): {
  text: string;
  spans: TextSpan[];
  segments: Segment[];
} {
  const walker = document.createTreeWalker(sectionEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n as Text).parentElement?.closest(SKIP_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  const spans: TextSpan[] = [];
  const segments: Segment[] = [];
  const idents: (Element | null)[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const v = t.nodeValue ?? '';
    if (!v) continue;
    const start = text.length;
    spans.push({ node: t, start, end: start + v.length });
    text += v;

    // A chip wins over bold (a bold chip is still one term), bold over plain.
    const parent = t.parentElement;
    const chip = parent?.closest('.ref-chip') ?? null;
    const bold = chip ? null : (parent?.closest('strong') ?? null);
    const kind: Segment['kind'] = chip ? 'chip' : bold ? 'bold' : 'text';
    // Merge identity: the owning chip/strong element for those kinds, else the
    // plain run's own parent element — distinct per sentence span, so adjacent
    // sentences never merge across their (whitespace-free) boundary.
    const ident = chip ?? bold ?? parent ?? null;

    const prev = segments[segments.length - 1];
    if (prev && prev.kind === kind && idents[idents.length - 1] === ident && prev.end === start) {
      prev.end = start + v.length; // same phrase continues across text nodes
    } else {
      segments.push({ start, end: start + v.length, kind });
      idents.push(ident);
    }
  }
  return { text, spans, segments };
}

/** Map a [start, end) range of the flat text back to DOM Ranges, split at
 *  text-node boundaries (same as searchHighlight's private mapToRanges). */
function mapToRanges(spans: TextSpan[], start: number, end: number): Range[] {
  const out: Range[] = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
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

/** Screen-space geometry of the exact highlighted text, not its whole block. */
export function readingRects(model: SectionModel, start: number, end: number): DOMRect[] {
  return mapToRanges(model.spans, start, end).flatMap((range) => [...range.getClientRects()])
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/** A wrapped term stays one word-mode cluster, but table highlights must
 * remain inside the current cell's current visual line. */
export function readingTarget(model: SectionModel, lineIdx: number, clusterIdx: number | null): { start: number; end: number } | undefined {
  const line = model.lines[lineIdx];
  if (!line) return;
  const cluster = clusterIdx === null ? undefined : model.clusters[clusterIdx];
  if (!cluster) return line;
  const span = model.spans.find((item) => item.end > cluster.start);
  return span?.node.parentElement?.closest('td, th')
    ? { start: Math.max(line.start, cluster.start), end: Math.min(line.end, cluster.end) }
    : cluster;
}

interface RectInfo {
  top: number;
  left: number;
  height: number;
}

/** One representative rect per visual line a char range touches, sorted by
 *  top. Rects are zoom-normalized so the half-height grouping tolerance is
 *  stable at any canvas zoom. */
function topGroupsOf(spans: TextSpan[], start: number, end: number, zoom: number): RectInfo[] {
  const rects: RectInfo[] = [];
  for (const range of mapToRanges(spans, start, end)) {
    for (const r of range.getClientRects()) {
      if (r.width <= 0 || r.height <= 0) continue;
      rects.push({ top: r.top / zoom, left: r.left / zoom, height: r.height / zoom });
    }
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const groups: RectInfo[] = [];
  for (const r of rects) {
    const last = groups[groups.length - 1];
    if (!last || r.top > last.top + last.height / 2) {
      groups.push({ ...r });
    } else {
      last.left = Math.min(last.left, r.left);
      last.height = Math.max(last.height, r.height);
    }
  }
  return groups;
}

/** Build the full line model for one section, or null when it has no
 *  measurable text (empty freetext, media-only body, display:none). */
export function buildLineModel(sectionEl: Element, zoom: number): SectionModel | null {
  const z = zoom > 0 ? zoom : 1;
  const { text, spans, segments } = buildSectionSegments(sectionEl);
  if (!text.trim()) return null;

  const clusters: Cluster[] = [];
  const fragments: Fragment[] = [];
  // Table cells have independent visual lines even when they share a screen
  // y-coordinate. Splitting before clustering also prevents article/term
  // merges from crossing a cell boundary.
  const flows: Array<{ cell: Element | null; end: number; segments: Segment[] }> = [];
  for (const span of spans) {
    const cell = span.node.parentElement?.closest('td, th') ?? null;
    const last = flows.at(-1);
    if (last && last.cell === cell) last.end = span.end;
    else flows.push({ cell, end: span.end, segments: [] });
  }
  let flowIndex = 0;
  for (const segment of segments) {
    while (flows[flowIndex]!.end <= segment.start) flowIndex++;
    flows[flowIndex]!.segments.push(segment);
  }
  const language = normalizeLanguage(sectionEl.closest('[lang]')?.getAttribute('lang')?.split('-')[0]);
  for (const [flow, group] of flows.entries()) for (const c of buildClusters(text, group.segments, language)) {
    const groups = topGroupsOf(spans, c.start, c.end, z);
    if (groups.length === 0) continue; // invisible cluster — drop it
    const clusterIdx = clusters.length;
    clusters.push(c);
    if (groups.length === 1) {
      const g = groups[0]!;
      fragments.push({ flow, clusterIdx, start: c.start, end: c.end, top: g.top, left: g.left, height: g.height });
      continue;
    }
    // Wrapped cluster: binary-search the char offset where each new line
    // starts (smallest o where Range(start, o) touches one more line; the
    // char at o-1 is the first on the new line).
    const bounds = [c.start];
    for (let li = 1; li < groups.length; li++) {
      const o = findWrapBreak((x) => topGroupsOf(spans, c.start, x, z).length > li, c.start, c.end);
      bounds.push(o - 1);
    }
    bounds.push(c.end);
    for (let gi = 0; gi < groups.length; gi++) {
      const s = bounds[gi]!;
      const e = bounds[gi + 1]!;
      if (e <= s) continue;
      const g = groups[gi]!;
      fragments.push({ flow, clusterIdx, start: s, end: e, top: g.top, left: g.left, height: g.height });
    }
  }
  if (clusters.length === 0 || fragments.length === 0) return null;

  const { lines, clusterHomeLine } = groupIntoLines(fragments, language === 'ar');
  return {
    text,
    spans,
    clusters,
    lines,
    shape: {
      lineCount: lines.length,
      clusterCount: clusters.length,
      firstClusterOnLine: lines.map((l) => l.firstClusterIdx),
      lastClusterOnLine: lines.map((l) => l.lastClusterIdx),
      clusterHomeLine,
    },
  };
}

/** Resolve the clickable relation represented by one reading cluster. A
 * selected-text mark wins over a nested term chip because every word inside
 * that complete marked selection should preview its selected-text child. */
export function referenceForCluster(
  model: SectionModel,
  clusterIdx: number | null,
): ReadingReferenceElement | null {
  if (clusterIdx === null) return null;
  const cluster = model.clusters[clusterIdx];
  if (!cluster) return null;
  for (const span of model.spans) {
    if (span.end <= cluster.start || span.start >= cluster.end) continue;
    const selection = span.node.parentElement?.closest<HTMLElement>(
      '[data-reading-relation-kind="selection"]',
    );
    if (selection) {
      const parentNodeId = selection.dataset.readingRelationParentId;
      const childId = selection.dataset.readingRelationChildId;
      const arrowId = selection.dataset.relationArrowId;
      if (!parentNodeId || !childId || !arrowId) return null;
      return {
        kind: 'selection',
        parentNodeId,
        childId,
        arrowId,
        element: selection,
      };
    }
    const element = span.node.parentElement?.closest<HTMLElement>('[data-reference-term]');
    if (!element) continue;
    const parentNodeId = element.dataset.referenceParentId;
    const term = element.dataset.referenceTerm;
    if (!parentNodeId || !term) return null;
    return {
      kind: 'term',
      parentNodeId,
      term,
      childId: element.dataset.relationChildId ?? null,
      element,
    };
  }
  return null;
}

/* ── Painting (CSS Custom Highlight API, feature-detected like search) ── */

type HighlightCtor = new (...ranges: Range[]) => { priority: number };
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { Ctor: HighlightCtor; registry: HighlightRegistry } | null {
  const Ctor = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  return Ctor && registry ? { Ctor, registry } : null;
}

export function paintReading(model: SectionModel, lineIdx: number, clusterIdx: number | null): void {
  const api = highlightApi();
  if (!api) return; // old browser — the ruler silently doesn't paint
  const line = model.lines[lineIdx];
  if (!line) {
    clearReadingPaint();
    return;
  }
  api.registry.set(LINE_HIGHLIGHT, new api.Ctor(...mapToRanges(model.spans, line.start, line.end)));
  if (clusterIdx !== null && model.clusters[clusterIdx]) {
    const c = readingTarget(model, lineIdx, clusterIdx)!;
    // Paint the word WITHOUT its leading/trailing punctuation (a lone
    // all-punctuation cluster, which shouldn't occur, falls back to itself).
    const w = trimToWord(model.text, c.start, c.end) ?? c;
    const word = new api.Ctor(...mapToRanges(model.spans, w.start, w.end));
    word.priority = 1; // paints over the line wash
    api.registry.set(WORD_HIGHLIGHT, word);
  } else {
    api.registry.delete(WORD_HIGHLIGHT);
  }
}

export function clearReadingPaint(): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(LINE_HIGHLIGHT);
  api.registry.delete(WORD_HIGHLIGHT);
}

/* ── The node's accent, as a root-level custom property ──
 * `::highlight()` pseudo-elements resolve var() through the highlight
 * inheritance chain (the root), NOT the originating element — and only one
 * node reads at a time, so one root prop is exactly right. */

export function setReadAccent(hex: string): void {
  document.documentElement.style.setProperty('--sc-read-accent', hex);
}

export function clearReadAccent(): void {
  document.documentElement.style.removeProperty('--sc-read-accent');
}
