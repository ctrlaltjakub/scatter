import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

interface EmphasisSpan { tag: 'strong' | 'em'; contentStart: number; contentEnd: number; end: number }
const cache = new Map<string, Map<number, EmphasisSpan>>();
const empty = new Map<number, EmphasisSpan>();

/** CommonMark delimiter matching, shared by node rendering and its visible-text
 * offsets. In particular, ***term*** is nested emphasis, not bold + stray stars.
 * Cache because layout measurement renders the same node text several times. */
export function inlineEmphasis(text: string): ReadonlyMap<number, EmphasisSpan> {
  if (!/[*_]/.test(text)) return empty;
  const cached = cache.get(text);
  if (cached) return cached;
  const spans = new Map<number, EmphasisSpan>();
  const visit = (node: ChatMdNode) => {
    if (node.type === 'strong' || node.type === 'emphasis') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      const delimiter = node.type === 'strong' ? 2 : 1;
      if (start != null && end != null) spans.set(start, {
        tag: node.type === 'strong' ? 'strong' : 'em',
        contentStart: start + delimiter, contentEnd: end - delimiter, end,
      });
    }
    node.children?.forEach(visit);
  };
  visit(parseChatMarkdown(text));
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(text, spans);
  return spans;
}

/** Slice a structured bullet at its colon without leaving half an emphasis
 * pair in either field (e.g. **Name:** or *Name: description*). */
export function sliceWithInlineEmphasis(text: string, start: number, end = text.length): string {
  const spans = inlineEmphasis(text);
  const slice = (from: number, to: number): string => {
    let result = '';
    for (let i = from; i < to;) {
      const span = spans.get(i);
      if (span && span.end <= to) {
        const inner = slice(span.contentStart, span.contentEnd);
        if (inner.trim()) result += text.slice(i, span.contentStart) + inner.trim() + text.slice(span.contentEnd, span.end);
        i = span.end;
      } else {
        if (i >= start && i < end) result += text[i];
        i++;
      }
    }
    return result;
  };
  return slice(0, text.length).trim();
}
