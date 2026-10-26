import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

export interface TermLabelPart { text: string; bold?: boolean; italic?: boolean; strike?: boolean }
const cache = new Map<string, { text: string; parts: TermLabelPart[] }>();

/** A selected phrase can contain mixed emphasis, escapes or entities. Keep its
 * visible name and label formatting in agreement. Cache across measurement
 * clones; ordinary unformatted names avoid Markdown parsing altogether. */
export function termLabel(raw: string): { text: string; parts: TermLabelPart[] } {
  const saved = cache.get(raw);
  if (saved) return saved;
  const parts: TermLabelPart[] = [];
  if (!/[*_~\\&]/.test(raw)) parts.push({ text: raw });
  else {
    const visit = (node: ChatMdNode, marks: Omit<TermLabelPart, 'text'> = {}) => {
      const next = { ...marks, ...(node.type === 'strong' ? { bold: true } : {}),
        ...(node.type === 'emphasis' ? { italic: true } : {}), ...(node.type === 'delete' ? { strike: true } : {}) };
      if (node.value != null) parts.push({ text: node.value, ...next });
      else node.children?.forEach((child) => visit(child, next));
    };
    visit(parseChatMarkdown(raw));
  }
  const result = { text: parts.map((part) => part.text).join(''), parts };
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(raw, result);
  return result;
}
