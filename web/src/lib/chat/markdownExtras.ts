import type { ChatMdNode } from './markdownFields';

/** Small, explicit Obsidian-compatible extensions. Never interpret arbitrary HTML. */
export function annotateMarkdownExtras(root: ChatMdNode, source: string,
  offsetsFor: (node: ChatMdNode) => { rawOffsets?: number[]; rawEnds?: number[] } | null) {
  const visit = (node: ChatMdNode) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(node.type)) return;
    if (node.type === 'blockquote') {
      const first = node.children?.[0]?.children?.[0];
      const match = first?.type === 'text' && first.value?.match(/^\[!([\w-]+)\]([+-])?(?:[ \t]+([^\n]+))?(?:\n|$)/);
      if (match && first) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties,
          'data-callout': match[1]!.toLowerCase(), 'data-callout-title': match[3] ?? match[1] } };
        const offsets = offsetsFor(first);
        first.value = first.value!.slice(match[0].length);
        if (first.position) first.position.start.offset = offsets?.rawOffsets?.[match[0].length] ?? first.position.end.offset;
      }
    }
    node.children?.forEach(visit);
    if (!node.children) return;
    // Split delimiter tokens first, then wrap their siblings. This keeps bold,
    // links and other inline formatting inside a highlighted/commented range.
    for (const [delimiter, type, tag] of [['==', 'highlight', 'mark'], ['%%', 'comment', 'span']] as const) {
      const children = node.children.flatMap((child): ChatMdNode[] => {
        if (child.type !== 'text' || !child.value?.includes(delimiter)) return [child];
        const offsets = offsetsFor(child);
        if (!offsets?.rawOffsets || !offsets.rawEnds) return [child];
        const { rawOffsets, rawEnds } = offsets;
        const slice = (from: number, to: number): ChatMdNode => ({ ...child, value: child.value!.slice(from, to),
          position: { start: { offset: rawOffsets[from] }, end: { offset: rawEnds[to - 1] } } });
        const parts: ChatMdNode[] = [];
        let cursor = 0;
        for (let at = child.value.indexOf(delimiter); at >= 0; at = child.value.indexOf(delimiter, at + delimiter.length)) {
          const start = rawOffsets[at], end = rawEnds[at + delimiter.length - 1];
          // Escaped delimiters and character entities remain literal text.
          if (start == null || end == null || source.slice(start, end) !== delimiter) continue;
          if (at > cursor) parts.push(slice(cursor, at));
          parts.push({ ...slice(at, at + delimiter.length), type: 'delimiter' }); cursor = at + delimiter.length;
        }
        if (cursor < child.value.length) parts.push(slice(cursor, child.value.length));
        return parts;
      });
      const result: ChatMdNode[] = [];
      let pending: ChatMdNode[] | null = null;
      let opening: ChatMdNode | null = null;
      for (const child of children) {
        if (child.type === 'delimiter') {
          if (pending) {
            result.push({ type, children: pending,
              position: opening?.position && child.position ? { start: opening.position.start, end: child.position.end } : undefined,
              data: { hName: tag, hProperties: type === 'comment' ? { hidden: true, 'data-markdown-comment': true } : {} } });
            pending = null;
          } else { pending = []; opening = child; }
        } else (pending ?? result).push(child);
      }
      if (pending) result.push({ ...opening!, type: 'text', value: delimiter }, ...pending);
      node.children = result;
    }
  };
  visit(root);
}

export function normalizeEditorUrl(raw: string, image = false): string | null {
  const value = raw.trim();
  if (/^www\.[^\s/]+(?:\/\S*)?$/i.test(value)) return `https://${value}`;
  if (/^https?:\/\/\S+$/i.test(value)) {
    try { new URL(value); return value; } catch { return null; }
  }
  if (!image && /^(mailto:[^\s]+|#[^\s]*|\/(?!\/)[^\s]*)$/i.test(value)) return value;
  if (image && /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  if (image && /^\/(?!\/)[^\s]*$/.test(value)) return value;
  return null;
}
