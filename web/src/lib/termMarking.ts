import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { termSelectionPrompt } from './termSelectionPrompt';
import { useSettingsStore } from '@/store/useSettingsStore';
import { mappedSegment, parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';
import { termLabel } from './termLabel';

const MAX_BATCH_CHARS = 6000;
type Range = [number, number];
interface Batch { text: string; skip?: boolean }
const LITERAL = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html', 'definition', 'math', 'inlineMath', 'comment']);
const FORMATTING = new Set(['strong', 'emphasis', 'delete', 'highlight']);
const overlaps = ([a, b]: Range, [c, d]: Range) => a < d && b > c;

/** Bound provider requests, packing whole Markdown blocks where possible. */
export function termBatches(body: string): Batch[] {
  const tree = parseChatMarkdown(body);
  const embeddedImages: Range[] = [];
  const collectImages = (node: ChatMdNode) => {
    if (node.type === 'image' && node.url?.startsWith('data:') && node.position?.start.offset != null && node.position.end.offset != null)
      embeddedImages.push([node.position.start.offset, node.position.end.offset]);
    node.children?.forEach(collectImages);
  };
  collectImages(tree);
  const batches: Batch[] = [];
  let cursor = 0;
  const append = (text: string, skip = false) => {
    while (text) {
      let end = Math.min(text.length, MAX_BATCH_CHARS);
      if (!skip && end < text.length) {
        const boundary = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf(' ', end - 1));
        if (boundary > end / 2) end = boundary + 1;
        const open = text.lastIndexOf('[[', end);
        if (open > text.lastIndexOf(']]', end) && open > 0) end = open;
      }
      const piece = text.slice(0, end), last = batches.at(-1);
      if (!skip && last && !last.skip && last.text.length + piece.length <= MAX_BATCH_CHARS) last.text += piece;
      else batches.push({ text: piece, skip });
      text = text.slice(end);
    }
  };
  for (const block of tree.children ?? []) {
    const start = block.position?.start.offset ?? cursor;
    const end = block.position?.end.offset ?? start;
    append(body.slice(cursor, start));
    if (LITERAL.has(block.type)) append(body.slice(start, end), true);
    else {
      let part = start;
      for (const [imageStart, imageEnd] of embeddedImages) {
        if (imageStart < start || imageEnd > end) continue;
        append(body.slice(part, imageStart)); append(body.slice(imageStart, imageEnd), true); part = imageEnd;
      }
      append(body.slice(part, end));
    }
    cursor = end;
  }
  append(body.slice(cursor));
  return batches;
}

function literalRanges(root: ChatMdNode): Range[] {
  const ranges: Range[] = [];
  const visit = (node: ChatMdNode) => {
    if (LITERAL.has(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start != null && end != null) ranges.push([start, end]);
    } else node.children?.forEach(visit);
  };
  visit(root);
  return ranges;
}

/** The actual explorable markers, excluding literal examples in code/links. */
export function markedTerms(body: string): string[] {
  const protectedRanges = literalRanges(parseChatMarkdown(body));
  return [...new Set([...body.matchAll(/\[\[([\s\S]*?)\]\]/g)]
    .filter((match) => !protectedRanges.some((range) => overlaps(range, [match.index, match.index + match[0].length])))
    .map((match) => termLabel(match[1]!).text.trim()).filter(Boolean))];
}

/** Redo removes only term delimiters, never literal [[...]] in code,
 * links, images or raw HTML. All other source bytes are retained. */
export function stripTermMarkers(body: string): string {
  const protectedRanges = literalRanges(parseChatMarkdown(body));
  return body.replace(/\[\[([\s\S]*?)\]\]/g, (match, inner: string, start: number) =>
    protectedRanges.some((range) => overlaps(range, [start, start + match.length])) ? match : inner);
}

interface Run { text: string; starts: number[]; ends: number[]; formats: Array<{ raw: Range; text: Range }> }

/** Index the WHOLE document once. Never parse truncated batches as Markdown:
 * splitting a long table/link/code block must not change what is markable. */
function indexSource(body: string): { runs: Run[]; protectedRanges: Range[] } {
  const root = parseChatMarkdown(body), runs: Run[] = [];
  const protectedRanges = literalRanges(root);
  for (const match of body.matchAll(/\[\[[\s\S]*?\]\]|⟦[^⟧]*⟧|⟪[^⟫]*⟫|\(\d+(?:\s*,\s*\d+)*\)|<<<SCATTER_PART_BREAK_[^>]*>>>/g)) {
    protectedRanges.push([match.index, match.index + match[0].length]);
  }
  const visit = (node: ChatMdNode) => {
    if (LITERAL.has(node.type)) return;
    if (['paragraph', 'heading', 'tableCell'].includes(node.type)) {
      let run: Run = { text: '', starts: [], ends: [], formats: [] };
      const flush = () => { if (run.text) runs.push(run); run = { text: '', starts: [], ends: [], formats: [] }; };
      const collect = (child: ChatMdNode) => {
        if (LITERAL.has(child.type) || child.type === 'break') { flush(); return; }
        const current = run, from = run.text.length;
        if (child.type === 'text') {
          const segment = mappedSegment(child, body, false);
          if (!segment?.rawOffsets || !segment.rawEnds) { flush(); return; }
          run.text += segment.text;
          for (let i = 0; i < segment.rawOffsets.length; i++) {
            run.starts.push(segment.rawOffsets[i]!); run.ends.push(segment.rawEnds[i]!);
          }
        } else if (child.children) child.children.forEach(collect);
        else { flush(); return; }
        if (FORMATTING.has(child.type) && current === run && run.text.length > from) {
          const start = child.position?.start.offset, end = child.position?.end.offset;
          if (start != null && end != null) run.formats.push({ raw: [start, end], text: [from, run.text.length] });
        }
      };
      collect(node); flush(); return;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return { runs, protectedRanges };
}

function parseSelection(output: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!parsed || typeof parsed !== 'object' || !('terms' in parsed) || !Array.isArray(parsed.terms)
      || parsed.terms.length > 500 || !parsed.terms.every((term): term is string => typeof term === 'string')) return null;
    return [...new Set(parsed.terms.map((term) => term.trim()).filter((term) =>
      term.length > 0 && term.length <= 256 && /[\p{L}\p{N}]/u.test(term) && !/[\[\]⟦⟧]/.test(term)))];
  } catch { return null; }
}

function selectionRanges(index: ReturnType<typeof indexSource>, terms: string[], bounds: Range): Range[] {
  const ranges: Range[] = [];
  const word = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Hangul}\p{M}\p{N}_]/u;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(term.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gu');
    for (const run of index.runs) {
      if (!overlaps([run.starts[0]!, run.ends.at(-1)!], bounds)) continue;
      for (const match of run.text.matchAll(pattern)) {
        const from = match.index, to = from + match[0].length;
        if ((word.test(term[0]!) && word.test(run.text[from - 1] ?? ''))
          || (word.test(term.at(-1)!) && word.test(run.text[to] ?? ''))) continue;
        const range: Range = [run.starts[from]!, run.ends[to - 1]!];
        let safe = true;
        for (const format of run.formats) {
          const [a, b] = format.text;
          // A phrase crossing an emphasis boundary must enclose that entire
          // emphasized span, so the original Markdown remains balanced.
          if ((from < a && to > a && to < b) || (from > a && from < b && to > b)) { safe = false; break; }
          if (from <= a && to >= b && (from < a || to > b)) {
            range[0] = Math.min(range[0], format.raw[0]); range[1] = Math.max(range[1], format.raw[1]);
          }
        }
        if (!safe || range[0] < bounds[0] || range[1] > bounds[1]
          || index.protectedRanges.some((protectedRange) => overlaps(range, protectedRange))
          || ranges.some((existing) => overlaps(range, existing))) continue;
        ranges.push(range);
      }
    }
  }
  return ranges;
}

function insertRanges(body: string, ranges: Range[]): string {
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    body = body.slice(0, start) + '[[' + body.slice(start, end) + ']]' + body.slice(end);
  }
  return body;
}

export function applyTermSelection(body: string, output: string): string | null {
  const terms = parseSelection(output);
  return terms === null ? null : insertRanges(body, selectionRanges(indexSource(body), terms, [0, body.length]));
}

/** Shared by chat, encyclopedic generation, rewrites, selected fragments and
 * Redo terms. The AI only chooses names; it never supplies replacement prose. */
export async function markTerms(body: string, signal: AbortSignal,
  complete = secondaryTaskCompletion): Promise<{ body: string; failed: number }> {
  const custom = useSettingsStore.getState().customPrompts;
  const index = indexSource(body), batches = termBatches(body);
  let offset = 0;
  const bounds = batches.map((batch): Range => { const start = offset; offset += batch.text.length; return [start, offset]; });
  const ranges: Range[] = [];
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
    for (;;) {
      signal.throwIfAborted();
      const i = next++, batch = batches[i];
      if (!batch) return;
      if (batch.skip || !batch.text.trim()) continue;
      let accepted = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const output = await complete({ ...termSelectionPrompt(batch.text.trim(), custom),
            // Reasoning models share this ceiling between thinking and output.
            maxOutputTokens: 12000, rejectTruncated: true, signal });
          signal.throwIfAborted();
          const terms = parseSelection(output);
          if (terms === null) continue;
          ranges.push(...selectionRanges(index, terms, bounds[i]!));
          accepted = true; break;
        } catch (error) { if (signal.aborted) throw error; }
      }
      if (!accepted) failed++;
    }
  }));
  return { body: insertRanges(body, ranges), failed };
}
