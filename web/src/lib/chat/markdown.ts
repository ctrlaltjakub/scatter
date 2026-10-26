import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { sentenceSplitPoints } from '@/lib/bulletParse';
import type { FactCheckUnit } from '@/store/types';
import { annotateChatSourceFields } from './markdownFields';
import { normalizeMarkdownBreaks } from './markdownBreaks';
import { normalizeMarkdownTasks } from './markdownTasks';

/** A small structural view over mdast; no HTML injection or custom parser. */
interface MdNode {
  type: string; value?: string; url?: string; alt?: string; children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export const markdownText = (node: MdNode): string => node.type === 'break' ? '\n'
  : node.type === 'image' ? node.alt || '\uFFFC'
  : node.type === 'footnoteReference' ? '\uFFFC'
  : node.value ?? node.children?.map(markdownText).join('') ?? '';

function sliceInline(nodes: MdNode[], from: number, to: number): MdNode[] {
  const result: MdNode[] = [];
  let offset = 0;
  for (const node of nodes) {
    const length = markdownText(node).length;
    const start = Math.max(0, from - offset), end = Math.min(length, to - offset);
    if (end > start) result.push(['break', 'image', 'inlineMath', 'footnoteReference'].includes(node.type) ? { ...node } : node.children
      ? { ...node, children: sliceInline(node.children, start, end) }
      : { ...node, value: (node.value ?? '').slice(start, end) });
    offset += length;
  }
  return result;
}

const INLINE_CONTAINERS = new Set(['paragraph', 'heading', 'tableCell', 'strong', 'emphasis', 'delete']);
const LITERAL_OR_LINK = new Set(['code', 'inlineCode', 'math', 'inlineMath', 'comment', 'link', 'linkReference', 'image', 'imageReference', 'html']);
const containsLiteralOrLink = (node: MdNode): boolean => LITERAL_OR_LINK.has(node.type)
  || !!node.children?.some(containsLiteralOrLink);

/** Markdown emphasis splits a [[term]] into sibling text/emphasis nodes.
 * Rejoin only its semantic range, keeping the rich label and surrounding
 * formatting. Never span blocks or turn code/existing links into buttons. */
function markRichTerms(node: MdNode): void {
  if (!node.children || !INLINE_CONTAINERS.has(node.type)) return;
  const value = markdownText(node);
  if (!value.includes('[[')) return;
  const result: MdNode[] = [];
  let end = 0;
  for (const match of value.matchAll(/\[\[([^\[\]]+)\]\]/g)) {
    const label = sliceInline(node.children, match.index + 2, match.index + match[0].length - 2);
    if (label.some(containsLiteralOrLink)) continue;
    result.push(...sliceInline(node.children, end, match.index), {
      type: 'link', url: `#chat-term/${encodeURIComponent(match[1]!)}`, children: label,
    });
    end = match.index + match[0].length;
  }
  if (end) node.children = [...result, ...sliceInline(node.children, end, value.length)];
}

function markInline(node: MdNode, internal: ReadonlySet<number>): void {
  if (!node.children || LITERAL_OR_LINK.has(node.type)) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type !== 'text') { markInline(child, internal); return [child]; }
    const value = (child.value ?? '').replace(/\s+/g, ' ');
    const pattern = /\[\[([^\[\]]+)\]\]|⟦(\d+)⟧|\((\d+)\)/g;
    const result: MdNode[] = [];
    let end = 0;
    for (const match of value.matchAll(pattern)) {
      if (match[3] && !internal.has(Number(match[3]))) continue;
      if (match.index > end) result.push({ type: 'text', value: value.slice(end, match.index) });
      const label = match[1] ?? (match[2] ? `[${match[2]}]` : `(${match[3]})`);
      result.push({ type: 'link', url: match[1] ? `#chat-term/${encodeURIComponent(match[1])}`
        : `#chat-cite/${match[2] ? 'web' : 'internal'}/${match[2] ?? match[3]}`,
      children: [{ type: 'text', value: label }] });
      end = match.index + match[0].length;
    }
    if (end < value.length) result.push({ type: 'text', value: value.slice(end) });
    return result;
  });
  markRichTerms(node);
}

/** Editors need term/citation marks without the display-only sentence slicing,
 * which deliberately omits non-text atoms from fact-check units. */
export function markChatInline(root: unknown): void { markInline(root as MdNode, new Set()); }

/** The same AST walk supplies rendered highlights and fact-check targets.
 * Headings/code are context only; each table row includes its column names. */
export function annotateChatMarkdown(root: unknown, options: {
  chunked: boolean; internalNumbers?: ReadonlySet<number>; source?: string;
}): FactCheckUnit[] {
  const tree = root as MdNode;
  normalizeMarkdownBreaks(tree, options.source);
  if (options.source != null) normalizeMarkdownTasks(tree, options.source);
  annotateChatSourceFields(tree);
  const units: FactCheckUnit[] = [];
  let heading = '', tableIndex = 0;
  markInline(tree, options.internalNumbers ?? new Set());
  const cleanUnit = (text: string) => text.replace(/\[\d+\]/g, '').replace(/\((\d+)\)/g, (match, number: string) =>
    options.internalNumbers?.has(Number(number)) ? '' : match).trim();
  const sentenceNodes = (node: MdNode, table = false) => {
    const children = node.children ?? [];
    const text = markdownText(node);
    const points = sentenceSplitPoints(text).map((point) => {
      // Provider evidence IDs are post-sentence tokens. Keep them with the
      // preceding sentence instead of creating a separate citation-only unit.
      let next = point;
      for (;;) {
        const token = text.slice(next).match(/^\s*(?:\(?SOURCE_\d+\)?|\[\d+\])\s*/);
        if (!token) break;
        next += token[0].length;
      }
      return next;
    });
    const boundaries = [...new Set([0, ...points, text.length])].sort((a, b) => a - b);
    node.children = boundaries.slice(0, -1).flatMap((start, index): MdNode[] => {
      const end = boundaries[index + 1]!;
      const exact = text.slice(start, end);
      if (!exact.trim()) return [];
      const id = table ? undefined : `chat:${units.length}`;
      if (id) units.push({ id, order: units.length, stage: 'prose', kind: 'sentence',
        text: cleanUnit(exact),
        sectionTitle: heading || undefined, state: 'pending' });
      return [{ type: 'scatterSentence', children: sliceInline(children, start, end),
        data: { hName: 'span', hProperties: {
          className: options.chunked ? 'sc-ab-sentence' : 'sc-ab-flow-sentence',
          ...(id ? { 'data-chat-unit': id } : {}),
        } } }];
    });
  };
  const visit = (node: MdNode, parent?: MdNode) => {
    if (node.type === 'heading') { heading = markdownText(node); return; }
    if (node.type === 'code') return;
    if (node.type === 'table') {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-chat-table-index': tableIndex } };
      const rows = node.children ?? [];
      const labels = rows[0]?.children?.map(markdownText) ?? [];
      rows.slice(1).forEach((row, rowIndex) => {
        const cells = row.children ?? [];
        const id = `chat-row:${tableIndex}:${rowIndex}`;
        units.push({ id, order: units.length, stage: 'prose', kind: 'sentence',
          text: cells.map((cell, index) => `${labels[index] || `Column ${index + 1}`}: ${cleanUnit(markdownText(cell))}`).join('; '),
          sectionTitle: [heading, `Table columns: ${labels.join(' | ')}`].filter(Boolean).join(' — '), state: 'pending' });
        row.data = { hProperties: { 'data-chat-unit': id } };
        cells.forEach((cell) => sentenceNodes(cell, true));
      });
      tableIndex++;
      return;
    }
    if (node.type === 'paragraph') {
      sentenceNodes(node);
      const field = node.data?.hProperties?.['data-sc-source-field'];
      if (parent?.type === 'listItem' && typeof field === 'string') {
        // CommonMark unwraps <p> inside tight lists, discarding its attributes.
        // Keep the exact-source marker on an inline child that survives both
        // tight and loose lists. GFM inserts task checkboxes OUTSIDE this span,
        // so their display-only spacing never shifts the source text offsets.
        const { 'data-sc-source-field': _field, ...properties } = node.data!.hProperties!;
        node.data = { ...node.data, hProperties: properties };
        node.children = [{ type: 'scatterSourceField', children: node.children,
          data: { hName: 'span', hProperties: { 'data-sc-source-field': field } } }];
      }
      return;
    }
    node.children?.forEach(child => visit(child, node));
  };
  visit(tree);
  return units;
}

/** Wrap saved source-selection ranges after sentence/citation transforms.
 * Existing link children retain priority over the surrounding relation. */
export function annotateChatRelations(root: unknown, marks: Map<string, Array<{ start: number; end: number; arrowId: string }>>): void {
  const visit = (node: MdNode) => {
    const id = node.data?.hProperties?.['data-sc-source-field'];
    const fields = typeof id === 'string' ? marks.get(id) : undefined;
    if (fields?.length) {
      let offset = 0;
      const wrap = (child: MdNode): MdNode[] => {
        const length = markdownText(child).length;
        if (child.type === 'link') { offset += length; return [child]; }
        if (child.children) return [{ ...child, children: child.children.flatMap(wrap) }];
        const start = offset; offset += length;
        const boundaries = [...new Set([start, offset, ...fields.flatMap((mark) => [Math.max(start, mark.start), Math.min(offset, mark.end)])])]
          .filter((point) => point >= start && point <= offset).sort((a, b) => a - b);
        return boundaries.slice(0, -1).map((from, index) => {
          const to = boundaries[index + 1]!;
          const text = { ...child, value: (child.value ?? '').slice(from - start, to - start) };
          const mark = fields.findLast((entry) => from >= entry.start && from < entry.end);
          return mark ? { type: 'scatterRelation', children: [text], data: { hName: 'span', hProperties: {
            'data-chat-relation': mark.arrowId, 'data-chat-relation-start': from === mark.start,
            'data-chat-relation-end': to === mark.end,
          } } } : text;
        });
      };
      node.children = node.children?.flatMap(wrap); return;
    }
    node.children?.forEach(visit);
  };
  visit(root as MdNode);
}

export function chatFactUnits(body: string, internalNumbers?: ReadonlySet<number>): FactCheckUnit[] {
  return annotateChatMarkdown(parser.parse(body), { chunked: false, internalNumbers, source: body });
}

/** All factual Markdown units must use a supplied opaque ID in Sources only.
 * Headings do not need citation keys. A repair may narrow unsupported claims. */
export function chatHasSourceCoverage(body: string, valid: ReadonlySet<string>): boolean {
  const units = chatFactUnits(body);
  return units.length > 0 && units.every((unit) =>
    [...unit.text.matchAll(/SOURCE_\d+/g)].some((match) => valid.has(match[0])));
}
