import type { JSONContent } from '@tiptap/core';
import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';
import { markChatInline } from './chat/markdown';

type Md = ChatMdNode & { lang?: string; align?: Array<string | null>; title?: string };
type Marks = NonNullable<JSONContent['marks']>;

export function answerBodyToDoc(body: string): JSONContent {
  const tree = parseChatMarkdown(body);
  // Reuse the display parser's balanced term handling (including terms whose
  // label contains bold/italic). No sentence splitting inside the editor.
  markChatInline(tree);
  const inline = (node: Md, marks: Marks = []): JSONContent[] => {
    if (node.type === 'inlineMath') return [{ type: 'inlineMath', attrs: { value: node.value ?? '' } }];
    if (node.type === 'footnoteReference') return [{ type: 'footnoteReference', attrs: { identifier: (node as Md & { identifier: string }).identifier } }];
    if (node.type === 'break') return [{ type: 'hardBreak' }];
    if (node.type === 'image') return [{ type: 'answerImage', attrs: { src: node.url, alt: (node as Md & { alt?: string }).alt ?? '', title: node.title } }];
    if (['imageReference', 'linkReference', 'html'].includes(node.type)) return [{ type: 'rawInline',
      attrs: { raw: body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) } }];
    if (node.type === 'inlineCode') return node.value ? [{ type: 'text', text: node.value, marks: [...marks, { type: 'code' }] }] : [];
    if (node.type === 'text') return (node.value ?? '').split('\n').flatMap((text, i) => [
      ...(i ? [{ type: 'hardBreak' }] : []), ...(text ? [{ type: 'text', text, marks }] : []),
    ]);
    const type = { strong: 'bold', emphasis: 'italic', delete: 'strike', highlight: 'highlight', comment: 'comment' }[node.type];
    let next = type ? [...marks, { type }] : marks;
    if (node.type === 'link') {
      if (node.url?.startsWith('#chat-term/')) next = [...marks, { type: 'term' }];
      else if (node.url?.startsWith('#chat-cite/')) {
        const [, kind, n] = node.url.split('/');
        return [{ type: 'text', text: kind === 'web' ? `⟦${n}⟧` : `(${n})`, marks }];
      }
      else if (!node.url?.startsWith('#chat-cite/')) next = [...marks, { type: 'link', attrs: { href: node.url, title: node.title } }];
    }
    return node.children?.flatMap((child) => inline(child, next)) ?? [];
  };
  const blocks = (nodes: Md[]): JSONContent[] => nodes.flatMap((node): JSONContent[] => {
    if (node.type === 'math') return [{ type: 'mathBlock', content: node.value ? [{ type: 'text', text: node.value }] : [] }];
    if (node.type === 'footnoteDefinition') return [{ type: 'footnoteDefinition', attrs: { identifier: (node as Md & { identifier: string }).identifier }, content: blocks(node.children ?? []) }];
    if (['definition', 'html'].includes(node.type)) return [{ type: 'rawMarkdown',
      content: [{ type: 'text', text: body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0) }] }];
    if (node.type === 'thematicBreak') return [{ type: 'horizontalRule' }];
    if (node.type === 'code') return [{ type: 'codeBlock', attrs: { language: node.lang ?? '' }, content: node.value ? [{ type: 'text', text: node.value }] : [] }];
    if (node.type === 'table') return [{ type: 'table', content: node.children?.map((row, index) => ({
      type: 'tableRow', content: row.children?.map((cell, col) => ({ type: index === 0 ? 'tableHeader' : 'tableCell',
        attrs: { align: node.align?.[col] ?? null }, content: [{ type: 'paragraph', content: inline(cell) }] })),
    })) }];
    if (node.type === 'list') return [{ type: node.ordered ? 'orderedList' : 'bulletList', attrs: { start: node.start ?? 1 },
      content: node.children?.map((item) => ({ type: 'listItem', attrs: { checked: item.checked ?? null }, content: blocks(item.children ?? []) })) }];
    if (node.type === 'blockquote' && node.data?.hProperties?.['data-callout']) {
      const raw = body.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
      const content = raw.split('\n').slice(1).map(line => line.replace(/^\s*> ?/, '')).join('\n');
      return [{ type: 'callout', attrs: { kind: node.data.hProperties['data-callout'], title: node.data.hProperties['data-callout-title'] }, content: answerBodyToDoc(content).content }];
    }
    if (node.type === 'blockquote') return [{ type: 'blockquote', content: blocks(node.children ?? []) }];
    if (node.type === 'heading') return [{ type: 'heading', attrs: { level: node.depth ?? 2 }, content: inline(node) }];
    if (node.type === 'paragraph') return [{ type: 'paragraph', content: inline(node) }];
    // Preserve unsupported source blocks as editable literal text, not silent loss.
    return node.value ? [{ type: 'paragraph', content: [{ type: 'text', text: node.value }] }] : [];
  });
  const content = blocks(tree.children ?? []);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const escape = (text: string) => text.replace(/[\\`*_[\]<>$]/g, '\\$&').replace(/([=%])\1/g, '\\$1\\$1');
export function answerDocToBody(doc: JSONContent, { stripTerms = false }: { stripTerms?: boolean } = {}): string {
  const token = (mark: Marks[number], close: boolean) => {
    if (mark.type === 'term') return close ? ']]' : '[[';
    if (mark.type === 'link') return close ? `](${String(mark.attrs?.href ?? '').replace(/[()\s]/g, (c) => encodeURIComponent(c))}${mark.attrs?.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : ''})` : '[';
    if (mark.type === 'code') return close ? `${mark.attrs?.padding ?? ''}${mark.attrs?.delimiter ?? '`'}` : `${mark.attrs?.delimiter ?? '`'}${mark.attrs?.padding ?? ''}`;
    return ({ bold: '**', italic: '_', strike: '~~', code: '`', highlight: '==', comment: '%%' } as Record<string, string>)[mark.type] ?? '';
  };
  const inline = (nodes: JSONContent[] = []) => {
    let out = ''; let active: Marks = [];
    const close = (marks: Marks) => {
      // CommonMark does not allow emphasis delimiters around trailing spaces.
      // A term boundary can split a visually continuous bold run in the editor.
      const trailing = marks.some(m => ['bold', 'italic', 'strike', 'highlight'].includes(m.type))
        ? out.match(/\s+$/)?.[0] ?? '' : '';
      if (trailing) out = out.slice(0, -trailing.length);
      out += marks.map(m => token(m, true)).join('') + trailing;
    };
    for (const node of nodes) {
      // Put term/link on the outside, so nested emphasis remains one clickable term.
      const marks = [...node.marks ?? []].filter(mark => !stripTerms || mark.type !== 'term').map((mark) => mark.type === 'code' ? { ...mark, attrs: {
        delimiter: '`'.repeat(Math.max(1, ...[...(node.text ?? '').matchAll(/`+/g)].map((m) => m[0].length + 1))),
        padding: /^`|`$/.test(node.text ?? '') ? ' ' : '',
      } } : mark).sort((a, b) => (['term', 'link'].includes(a.type) ? -1 : 0) - (['term', 'link'].includes(b.type) ? -1 : 0));
      let same = 0;
      while (same < active.length && same < marks.length && JSON.stringify(active[same]) === JSON.stringify(marks[same])) same++;
      close(active.slice(same).reverse());
      const opening = marks.slice(same);
      const leading = !marks.some(m => m.type === 'code') && opening.some(m => ['bold', 'italic', 'strike', 'highlight'].includes(m.type))
        ? node.text?.match(/^\s+/)?.[0] ?? '' : '';
      out += leading + opening.map((m) => token(m, false)).join('');
      out += node.type === 'hardBreak' ? '\\\n'
        : node.type === 'inlineMath' ? `$${node.attrs?.value ?? ''}$`
        : node.type === 'footnoteReference' ? `[^${node.attrs?.identifier ?? '1'}]`
        : node.type === 'rawInline' ? node.attrs?.raw ?? ''
        : node.type === 'answerImage' ? `![${escape(node.attrs?.alt ?? '')}](${node.attrs?.src ?? ''}${node.attrs?.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''})`
        : marks.some((m) => m.type === 'code') ? node.text ?? '' : escape((node.text ?? '').slice(leading.length));
      active = marks;
    }
    close(active.reverse());
    return out;
  };
  const blocks = (nodes: JSONContent[] = []): string => nodes.map((node): string => {
    if (node.type === 'horizontalRule') return '---';
    if (node.type === 'mathBlock') return `$$\n${node.content?.map(n => n.text ?? '').join('') ?? ''}\n$$`;
    if (node.type === 'footnoteDefinition') return `[^${node.attrs?.identifier ?? '1'}]: ${blocks(node.content).replace(/\n/g, '\n    ')}`;
    if (node.type === 'rawMarkdown') return node.content?.map((n) => n.text ?? '').join('') ?? '';
    if (node.type === 'codeBlock') {
      const text = node.content?.map((n) => n.text ?? '').join('') ?? '';
      const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}`;
    }
    if (node.type === 'heading') return `${'#'.repeat(node.attrs?.level ?? 2)} ${inline(node.content)}`;
    if (node.type === 'blockquote') return blocks(node.content).split('\n').map((line) => `> ${line}`).join('\n');
    if (node.type === 'callout') return `> [!${node.attrs?.kind ?? 'note'}]${node.attrs?.title && String(node.attrs.title).toLowerCase() !== node.attrs.kind ? ` ${node.attrs.title}` : ''}\n${blocks(node.content).split('\n').map(line => `> ${line}`).join('\n')}`;
    if (node.type === 'bulletList' || node.type === 'orderedList') return (node.content ?? []).map((item, index) => {
      const prefix = node.type === 'orderedList' ? `${(node.attrs?.start ?? 1) + index}. ` : '- ';
      const task = item.attrs?.checked == null ? '' : item.attrs.checked ? '[x] ' : '[ ] ';
      // A checkbox belongs to the item's text, not its Markdown list marker.
      // Counting it as indentation turns nested children into code blocks.
      return prefix + task + blocks(item.content).replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
    }).join('\n');
    if (node.type === 'table') {
      const rows = node.content ?? [];
      const rendered = rows.map((row) => `| ${(row.content ?? []).map((cell) => (cell.content ?? []).map((p) => inline(p.content)).join('<br>').replace(/\|/g, '\\|').replace(/\\\n/g, '<br>')).join(' | ')} |`);
      rendered.splice(1, 0, `| ${(rows[0]?.content ?? []).map((cell) => cell.attrs?.align === 'center' ? ':---:' : cell.attrs?.align === 'right' ? '---:' : cell.attrs?.align === 'left' ? ':---' : '---').join(' | ')} |`);
      return rendered.join('\n');
    }
    return inline(node.content);
  }).join('\n\n');
  return blocks(doc.content);
}
