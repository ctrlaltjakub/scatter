import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { annotateMarkdownExtras } from './markdownExtras';
import { decodeString } from 'micromark-util-decode-string';
import { normalizeMarkdownBreaks } from './markdownBreaks';
import { normalizeMarkdownTasks } from './markdownTasks';

export interface ChatMdNode {
  type: string; value?: string; url?: string; depth?: number; ordered?: boolean; start?: number; checked?: boolean | null;
  children?: ChatMdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
export function parseChatMarkdown(body: string): ChatMdNode {
  const tree = parser.parse(body) as ChatMdNode;
  normalizeMarkdownBreaks(tree, body);
  annotateMarkdownExtras(tree, body, node => mappedSegment(node, body, false));
  normalizeMarkdownTasks(tree, body);
  return tree;
}

interface ChatSourceSegment {
  text: string; start: number; joinBefore: boolean; markdownParsed: true; literal: boolean;
  rawOffsets?: number[]; rawEnds?: number[];
}

/** Markdown's decoded text can be shorter than its source (escapes, entities,
 * and multi-backtick code). Keep exact character boundaries, not linear offsets. */
export function mappedSegment(node: ChatMdNode, body: string | undefined, literal: boolean): ChatSourceSegment | null {
  const start = node.position?.start.offset;
  if (node.type === 'break' && start != null) return {
    text: '\n', start, joinBefore: false, markdownParsed: true, literal: true,
    rawOffsets: [start], rawEnds: [node.position?.end.offset ?? start + 1],
  };
  if (!node.value || start == null || !['text', 'inlineCode'].includes(node.type)) return null;
  const result: ChatSourceSegment = { text: node.value, start, joinBefore: false, markdownParsed: true, literal };
  if (body == null) return result;
  const source = body.slice(start, node.position?.end.offset);
  let decoded = '', offsets: number[] = [], ends: number[] = [];
  const append = (value: string, from: number, to: number) => {
    decoded += value;
    for (let i = 0; i < value.length; i++) { offsets.push(start + from); ends.push(start + to); }
  };
  if (node.type === 'inlineCode') {
    const fence = source.match(/^`+/)?.[0].length ?? 0;
    const end = source.length - fence;
    for (let i = fence; i < end; i++) {
      const crlf = source.slice(i, i + 2) === '\r\n';
      append(/[\r\n]/.test(source[i]!) ? ' ' : source[i]!, i, i + (crlf ? 2 : 1));
      if (crlf) i++;
    }
    if (decoded.startsWith(' ') && decoded.endsWith(' ') && /\S/.test(decoded)) {
      decoded = decoded.slice(1, -1); offsets = offsets.slice(1, -1); ends = ends.slice(1, -1);
    }
  } else {
    const tokens = /\\[!-/:-@[-`{-~]|&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});|\r\n/gi;
    let cursor = 0;
    for (const token of source.matchAll(tokens)) {
      while (cursor < token.index) { append(source[cursor]!, cursor, cursor + 1); cursor++; }
      append(token[0] === '\r\n' ? '\n' : decodeString(token[0]), cursor, cursor + token[0].length);
      cursor += token[0].length;
    }
    while (cursor < source.length) { append(source[cursor]!, cursor, cursor + 1); cursor++; }
  }
  if (node.type === 'text' && decoded !== node.value) {
    // CommonMark removes indentation, quote prefixes and trailing whitespace
    // around soft line breaks. Keep their source gaps in the position map.
    let normalized = '', mappedOffsets: number[] = [], mappedEnds: number[] = [], cursor = 0;
    for (const match of decoded.matchAll(/[ \t]*\n[ \t]*(?:>[ \t]*)*/g)) {
      normalized += decoded.slice(cursor, match.index) + '\n';
      mappedOffsets.push(...offsets.slice(cursor, match.index));
      mappedEnds.push(...ends.slice(cursor, match.index));
      const newline = match.index + match[0].indexOf('\n');
      mappedOffsets.push(offsets[newline]!); mappedEnds.push(ends[newline]!);
      cursor = match.index + match[0].length;
    }
    normalized += decoded.slice(cursor);
    mappedOffsets.push(...offsets.slice(cursor)); mappedEnds.push(...ends.slice(cursor));
    if (normalized === node.value) { decoded = normalized; offsets = mappedOffsets; ends = mappedEnds; }
  }
  if (decoded !== node.value) return null; // Never create a shifted relation anchor.
  return { ...result, start: offsets[0] ?? start, rawOffsets: offsets, rawEnds: ends };
}

/** Mark semantic Markdown blocks before display transformations, preserving
 * raw source offsets for selection anchors through bold, links and tables. */
export function annotateChatSourceFields(root: ChatMdNode, body?: string): Map<string, ChatSourceSegment[]> {
  const fields = new Map<string, ChatSourceSegment[]>();
  const visit = (node: ChatMdNode) => {
    if (['paragraph', 'tableCell', 'heading'].includes(node.type)) {
      const id = `chat:${fields.size}`;
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-sc-source-field': id } };
      const segments: ChatSourceSegment[] = [];
      const collect = (child: ChatMdNode, inLink = false) => {
        if (child.type === 'comment') return;
        const literal = inLink || ['inlineCode', 'link', 'linkReference'].includes(child.type);
        if (child.children) { child.children.forEach((entry) => collect(entry, literal)); return; }
        const segment = mappedSegment(child, body, literal);
        if (segment) segments.push(segment);
      };
      collect(node); fields.set(id, segments); return;
    }
    node.children?.forEach(visit);
  };
  visit(root);
  return fields;
}
