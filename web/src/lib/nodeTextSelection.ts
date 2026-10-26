import { separatorColonIndex } from './bulletParse';
import type { NodeTextSelection, NodeTextSelectionPart } from '@/store/useNodeTextSelectionStore';
import { annotateChatSourceFields, parseChatMarkdown } from './chat/markdownFields';
import { inlineEmphasis } from './inlineEmphasis';

interface SourceSegment {
  text: string;
  start: number;
  rawOffsets?: number[];
  rawEnds?: number[];
  markdownParsed?: boolean;
  literal?: boolean;
  joinBefore?: boolean;
  emphasisMarkers?: Set<number>;
}

type SourceFields = Map<string, SourceSegment[]>;

const BULLET_RE = /^(\s*)([-*+])\s+(.+)$/;
const ANY_BULLET_RE = /^\s*[-*+]\s/;

interface SanitizedLine {
  text: string;
  rawOffsets: number[];
}

/** Strip render-only heading/quote prefixes while retaining per-char offsets. */
function sanitizeLine(raw: string, rawStart: number): SanitizedLine {
  const match = raw.match(/^(\s*)#{1,6}[ \t]+/) ?? raw.match(/^(\s*)>[ \t]?/);
  if (!match) {
    return { text: raw, rawOffsets: [...raw].map((_, i) => rawStart + i) };
  }
  const indent = match[1]?.length ?? 0;
  const text = raw.slice(0, indent) + raw.slice(match[0].length);
  const rawOffsets = [
    ...Array.from({ length: indent }, (_, i) => rawStart + i),
    ...Array.from({ length: raw.length - match[0].length }, (_, i) => rawStart + match[0].length + i),
  ];
  return { text, rawOffsets };
}

function segmentFromLine(line: SanitizedLine, start = 0, end = line.text.length): SourceSegment {
  const text = line.text.slice(start, end);
  const left = text.length - text.trimStart().length;
  const right = text.trimEnd().length;
  const from = start + left;
  const to = start + right;
  const rawOffsets = line.rawOffsets.slice(from, to);
  const content = line.text.match(BULLET_RE)?.[3] ?? line.text.trimStart();
  const contentStart = line.text.length - content.length;
  const emphasisMarkers = new Set<number>();
  // Parse before splitting name/description so an emphasized colon does not
  // make either field look like unmatched Markdown to the selection mapper.
  for (const [start, span] of inlineEmphasis(content)) {
    for (let i = start; i < span.contentStart; i++) emphasisMarkers.add(contentStart + i - from);
    for (let i = span.contentEnd; i < span.end; i++) emphasisMarkers.add(contentStart + i - from);
  }
  return { text: line.text.slice(from, to), start: rawOffsets[0] ?? 0, rawOffsets, emphasisMarkers };
}

function buildSourceFields(body: string, chat = false): SourceFields {
  if (chat) return annotateChatSourceFields(parseChatMarkdown(body), body);
  const fields: SourceFields = new Map();
  const rawLines = body.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of rawLines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const lines = rawLines.map((line, i) => sanitizeLine(line, starts[i] ?? 0));
  const firstBullet = lines.findIndex(({ text }) => ANY_BULLET_RE.test(text));
  if (firstBullet < 0) {
    const freeText = lines.map((line) => segmentFromLine(line)).filter((segment) => segment.text);
    if (freeText.length) fields.set('ft', freeText);
    return fields;
  }

  const freeText = lines.slice(0, firstBullet)
    .map((line) => segmentFromLine(line))
    .filter((segment) => segment.text);
  if (freeText.length) fields.set('ft', freeText);

  let bulletIndex = -1;
  let childIndex = -1;
  let lastDescKey: string | null = null;
  for (let i = firstBullet; i < lines.length; i++) {
    const sanitizedLine = lines[i]!;
    const { text: line } = sanitizedLine;
    if (!line.trim()) {
      lastDescKey = null;
      continue;
    }
    const match = line.match(BULLET_RE);
    if (match) {
      const indent = match[1]?.length ?? 0;
      const content = match[3] ?? '';
      const contentInLine = line.indexOf(content);
      const contentSegment = segmentFromLine(sanitizedLine, contentInLine, contentInLine + content.length);
      if (indent === 0) {
        bulletIndex += 1;
        childIndex = -1;
        lastDescKey = null;
        fields.set(`b:${bulletIndex}:title`, [contentSegment]);
        continue;
      }
      if (bulletIndex < 0) continue;
      childIndex += 1;
      const colon = separatorColonIndex(content);
      const nameText = colon >= 0 ? content.slice(0, colon) : content;
      const descText = colon >= 0 ? content.slice(colon + 1) : '';
      fields.set(`b:${bulletIndex}:c:${childIndex}:name`, [
        segmentFromLine(sanitizedLine, contentInLine, contentInLine + nameText.length),
      ]);
      const descKey = `b:${bulletIndex}:c:${childIndex}:desc`;
      if (descText.trim()) {
        const descStart = contentInLine + colon + 1;
        fields.set(descKey, [segmentFromLine(sanitizedLine, descStart, descStart + descText.length)]);
      } else {
        fields.set(descKey, []);
      }
      lastDescKey = descKey;
      continue;
    }
    if (/^\s+\S/.test(line) && lastDescKey) {
      const segment = segmentFromLine(sanitizedLine);
      fields.get(lastDescKey)?.push(segment);
      continue;
    }
    lastDescKey = null;
  }
  return fields;
}

export interface SourceFieldProjection {
  text: string;
  /** Raw source offset for each projected visible character. */
  raw: number[];
  rawEnds: number[];
  sourceStart: number;
  sourceEnd: number;
}

function projectSegments(segments: SourceSegment[]): SourceFieldProjection | null {
  if (!segments.length) return null;
  let text = '';
  const raw: number[] = [];
  const rawEnds: number[] = [];
  const push = (char: string, at: number, end = at + 1) => {
    if (/\s/.test(char)) {
      if (!text || /\s/.test(text.at(-1) ?? '')) return;
      text += ' ';
      raw.push(at);
      rawEnds.push(end);
      return;
    }
    text += char;
    raw.push(at);
    rawEnds.push(end);
  };

  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s]!;
    if (s > 0 && segment.joinBefore !== false) push(' ', segment.start - 1);
    for (let i = 0; i < segment.text.length;) {
      const at = segment.rawOffsets?.[i] ?? segment.start + i;
      const pair = segment.text.slice(i, i + 2);
      if (!segment.literal && (pair === '[[' || pair === ']]')) {
        i += 2;
        continue;
      }
      const char = segment.text[i]!;
      if (segment.emphasisMarkers?.has(i)) {
        i += 1;
        continue;
      }
      if (!segment.literal && char === '⟦') {
        const end = segment.text.indexOf('⟧', i + 1);
        const digits = end > i ? segment.text.slice(i + 1, end) : '';
        if (/^\d+$/.test(digits)) {
          push('[', at);
          for (let j = 0; j < digits.length; j++) {
            push(digits[j]!, segment.rawOffsets?.[i + 1 + j] ?? at + 1 + j);
          }
          push(']', segment.rawOffsets?.[end] ?? segment.start + end);
          i = end + 1;
          continue;
        }
      }
      push(char, at, segment.rawEnds?.[i]);
      i += 1;
    }
  }
  return {
    text,
    raw,
    rawEnds,
    sourceStart: segments[0]!.start,
    sourceEnd: segments.at(-1)!.rawEnds?.at(-1)
      ?? (segments.at(-1)!.rawOffsets?.at(-1) ?? (segments.at(-1)!.start + segments.at(-1)!.text.length - 1)) + 1,
  };
}

/** Build the exact visible-text projection for one persisted semantic field. */
export function sourceFieldProjection(
  body: string,
  sourceField: string,
): SourceFieldProjection | null {
  return projectSegments(buildSourceFields(body, sourceField.startsWith('chat:')).get(sourceField) ?? []);
}

function fieldForEndpoint(root: HTMLElement, node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const field = element?.closest<HTMLElement>('[data-sc-source-field]') ?? null;
  return field && root.contains(field) ? field : null;
}

function visibleOffset(field: HTMLElement, container: Node, offset: number): number | null {
  try {
    const prefix = document.createRange();
    prefix.selectNodeContents(field);
    prefix.setEnd(container, offset);
    return prefix.toString().length;
  } catch {
    return null;
  }
}

/** Align rendered text with our render projection while tolerating layout-only whitespace. */
function visibleToProjected(actual: string, projected: string, visibleOffsetValue: number): number | null {
  let a = 0;
  let p = 0;
  while (a < visibleOffsetValue) {
    const ac = actual[a];
    const pc = projected[p];
    if (ac == null) return null;
    if (/\s/.test(ac)) {
      a += 1;
      if (pc != null && /\s/.test(pc)) p += 1;
      continue;
    }
    while (pc != null && /\s/.test(projected[p]!)) p += 1;
    if (projected[p] !== ac) return null;
    a += 1;
    p += 1;
  }
  return p;
}

function rawBoundary(
  root: HTMLElement,
  fields: SourceFields,
  container: Node,
  offset: number,
  edge: 'start' | 'end',
): number | null {
  const field = fieldForEndpoint(root, container);
  const key = field?.dataset.scSourceField;
  const projection = key ? projectSegments(fields.get(key) ?? []) : null;
  if (!field || !projection) return null;
  const visible = visibleOffset(field, container, offset);
  if (visible == null) return null;
  const projectedOffset = visibleToProjected(field.textContent ?? '', projection.text, visible);
  if (projectedOffset == null) return null;
  if (projectedOffset <= 0) return projection.sourceStart;
  if (projectedOffset >= projection.raw.length) return projection.sourceEnd;
  return edge === 'start'
    ? projection.raw[projectedOffset]!
    : projection.rawEnds[projectedOffset - 1]!;
}

export function resolveNodeTextSelection({
  body, nodeId, versionIndex, range, root,
}: {
  body: string;
  nodeId: string;
  versionIndex: number;
  range: Range;
  root: HTMLElement;
}): NodeTextSelection | null {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const fields = buildSourceFields(body, root.classList.contains('chat-markdown'));
  const parts: NodeTextSelectionPart[] = [];
  const visibleFields = Array.from(root.querySelectorAll<HTMLElement>('[data-sc-source-field]'))
    // AdaptiveBullets keeps duplicate, invisible measurement copies in the
    // DOM. They are never user-selectable and must not become source parts.
    .filter((field) => !field.closest('.sc-ab-measure'));

  for (const field of visibleFields) {
    let intersects = false;
    try {
      intersects = range.intersectsNode(field);
    } catch {
      intersects = false;
    }
    if (!intersects) continue;

    const clipped = document.createRange();
    clipped.selectNodeContents(field);
    if (field === range.startContainer || field.contains(range.startContainer)) {
      clipped.setStart(range.startContainer, range.startOffset);
    }
    if (field === range.endContainer || field.contains(range.endContainer)) {
      clipped.setEnd(range.endContainer, range.endOffset);
    }
    if (clipped.collapsed) continue;

    const start = rawBoundary(root, fields, clipped.startContainer, clipped.startOffset, 'start');
    const end = rawBoundary(root, fields, clipped.endContainer, clipped.endOffset, 'end');
    const text = clipped.toString();
    const sourceField = field.dataset.scSourceField;
    if (!sourceField || start == null || end == null || end <= start || !text.trim()) continue;
    parts.push({ sourceField, start, end, text });
  }

  if (!parts.length) return null;
  const start = parts[0]!.start;
  const end = parts.at(-1)!.end;
  const text = parts.map((part) => part.text.trim()).filter(Boolean).join('\n');
  if (!text) return null;
  return { nodeId, versionIndex, sourceBody: body, start, end, text, parts };
}
