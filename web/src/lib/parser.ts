import { termLabel } from './termLabel';
import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

// Matches [[non-empty content with no brackets inside]].
// Rejects empty [[]] and nested [[[x]]] via lookbehind/lookahead guards.
const REF_RE = /(?<!\[)\[\[([^\[\]]+?)\]\](?!\])/g;

export function extractReferences(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(REF_RE)) {
    const term = m[1]?.trim();
    if (term && term.length > 0) out.push(term);
  }
  return out;
}

/** Normalize a header/term for case- and whitespace-insensitive comparison. */
function normalizeHeader(s: string): string {
  return termLabel(s).text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Remove the `[[ ]]` chip markers around any chip whose term equals (after
 * case/whitespace normalization) one of `blockedHeaders`, leaving the term as
 * plain text. Other chips and all surrounding text are untouched. Uses the same
 * REF_RE as the chip scanner so "what counts as a chip" stays single-sourced
 * (malformed/nested brackets are left alone).
 *
 * Used to "unchip" redundant chips on non-root nodes that just point back to
 * the node's own / parent's / sibling's header.
 */
export function unchipHeaders(body: string, blockedHeaders: string[]): string {
  const blocked = new Set(blockedHeaders.map(normalizeHeader).filter(Boolean));
  if (blocked.size === 0) return body;
  // Redundant-term cleanup must obey the same literal boundaries as insertion.
  // In particular, literal [[...]] inside code is not a term to remove.
  const literals: Array<[number, number]> = [];
  const visit = (node: ChatMdNode) => {
    if (['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'html', 'definition'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start != null && end != null) literals.push([start, end]);
    } else node.children?.forEach(visit);
  };
  visit(parseChatMarkdown(body));
  return body.replace(REF_RE, (full, inner: string, offset: number) => {
    if (literals.some(([start, end]) => offset < end && offset + full.length > start)) return full;
    const term = inner.trim();
    return blocked.has(normalizeHeader(term)) ? term : full;
  });
}
