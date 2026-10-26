import type { ChatMdNode } from './markdownFields';
import { decodeString } from 'micromark-util-decode-string';

/** Recognize only the common Markdown line-break escape, never arbitrary HTML.
 * Preserve source positions so selection/term anchors still address the original. */
export function normalizeMarkdownBreaks(node: ChatMdNode, source?: string): void {
  if (node.type === 'code' || node.type === 'inlineCode') return;
  if (!node.children) return;
  node.children = node.children.flatMap(child => {
    if (child.type === 'html' && /^<\s*br\s*\/?\s*>$/i.test(child.value ?? '')) {
      return [{ ...child, type: 'break', value: undefined }];
    }
    if (child.type === 'text' && /<\s*br\s*\/?\s*>/i.test(child.value ?? '')) {
      const value = child.value!;
      const offset = child.position?.start.offset;
      const raw = source != null && offset != null ? source.slice(offset, child.position?.end.offset) : value;
      const parts: ChatMdNode[] = [];
      let end = 0, rawEnd = 0;
      const part = (type: string, start: number, finish: number, rawStart: number, rawFinish: number): ChatMdNode => ({
        type, ...(type === 'text' ? { value: value.slice(start, finish) } : {}),
        ...(offset != null ? { position: {
          start: { offset: offset + rawStart },
          end: { offset: offset + rawFinish },
        } } : {}),
      });
      for (const match of raw.matchAll(/<\s*br\s*\/?\s*>/gi)) {
        // Escaped tags and &lt;br&gt; are literal prose, including text written
        // in the WYSIWYG editor. Only actual source tags become breaks.
        const prefix = raw.slice(0, match.index);
        if ((prefix.match(/\\+$/)?.[0].length ?? 0) % 2) continue;
        const start = decodeString(prefix).length;
        const finish = start + match[0].length;
        if (value.slice(start, finish) !== match[0]) continue;
        if (start > end) parts.push(part('text', end, start, rawEnd, match.index));
        rawEnd = match.index + match[0].length;
        parts.push(part('break', start, finish, match.index, rawEnd));
        end = finish;
      }
      if (!parts.length) return [child];
      if (end < value.length) parts.push(part('text', end, value.length, rawEnd, raw.length));
      return parts;
    }
    normalizeMarkdownBreaks(child, source);
    return [child];
  });
}
