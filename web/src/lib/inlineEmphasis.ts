import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

interface EmphasisSpan { tag: 'strong' | 'em'; contentStart: number; contentEnd: number; end: number }
const cache = new Map<string, Map<number, EmphasisSpan>>();
const empty = new Map<number, EmphasisSpan>();

/** Older editor saves split a bold phrase at every term boundary, producing
 * e.g. [[**left**]]** and **[[**right**]]. Only repair whitespace-flanking runs
 * immediately adjacent to these bold term tokens. Parse a same-length mask so
 * stored text, authored lines and selection offsets remain untouched. */
function legacyEmphasisSource(text: string): string {
  const tokens = [...text.matchAll(/\[\[\*\*([\s\S]*?)\*\*\]\]|\*\*([\s\S]*?)\*\*/g)];
  let masked: string[] | undefined;
  const escaped = (at: number) => {
    let slashes = 0;
    while (text[--at] === '\\') slashes++;
    return slashes % 2 === 1;
  };
  for (const [index, token] of tokens.entries()) {
    if (token[2] == null || !token[2].length || escaped(token.index)) continue;
    const previous = tokens[index - 1], next = tokens[index + 1];
    const besideBoldTerm = (previous?.[1] != null && !escaped(previous.index)
      && previous.index + previous[0].length === token.index)
      || (next?.[1] != null && !escaped(next.index) && token.index + token[0].length === next.index);
    if (!besideBoldTerm || escaped(token.index + token[0].length - 2)) continue;
    for (const at of [token.index + 2, token.index + token[0].length - 3]) {
      if (!/\s/u.test(text[at]!)) continue;
      masked ??= text.split('');
      masked[at] = 'x';
    }
  }
  return masked?.join('') ?? text;
}

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
  visit(parseChatMarkdown(legacyEmphasisSource(text)));
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
