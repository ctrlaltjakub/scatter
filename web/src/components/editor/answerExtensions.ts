import { Extension, Mark, Node, InputRule, getMarkRange, mergeAttributes, textblockTypeInputRule, wrappingInputRule, type NodeConfig } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import Paragraph from '@tiptap/extension-paragraph';
import History from '@tiptap/extension-history';
import Gapcursor from '@tiptap/extension-gapcursor';
import Dropcursor from '@tiptap/extension-dropcursor';
import { splitListItem, liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { TermMark } from './TermMark';
import { TermResize } from './TermResize';
import { Plugin } from '@tiptap/pm/state';
import { tableEditing, goToNextCell, isInTable } from '@tiptap/pm/tables';
import { answerBodyToDoc } from '@/lib/answerEditorSerialize';
import { normalizeEditorUrl } from '@/lib/chat/markdownExtras';
import katex from 'katex';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { SoftBreak } from './SoftBreak';

const safeUrl = (value: unknown, image = false) => typeof value === 'string'
  && (/^(?:https?:|\/|#)/i.test(value) || (image ? /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(value) : /^mailto:/i.test(value))) ? value : '';

/** Rich Markdown answers use the same editor and history, without the forced
 * introduction/two-level-outline schema of encyclopedic nodes. */
export function buildAnswerExtensions() {
  const block = (name: string, tag: string, content: string, extra: Partial<NodeConfig> = {}) => Node.create({
    name, group: 'block', content, defining: true,
    parseHTML: () => [{ tag }], renderHTML: ({ HTMLAttributes }) => [tag, HTMLAttributes, 0], ...extra,
  });
  const mark = (name: string, tag: string) => Mark.create({ name,
    parseHTML: () => [{ tag }], renderHTML: () => [tag, {}, 0] });
  return [Document, Text, Paragraph, SoftBreak, Bold, TermMark, TermResize, History, Gapcursor, Dropcursor,
    Extension.create({ name: 'answerEditing',
      addStorage: () => ({ chunked: false }),
      addInputRules() { return [new InputRule({
        find: /(!?\[([^\]\n]*)\]\(([^)\n]+)\))$/,
        handler: ({ state, range, match }) => {
          const image = match[1]!.startsWith('!'), href = normalizeEditorUrl(match[3]!, image);
          if (!href || (!image && !match[2])) return null;
          state.tr.replaceWith(range.to - match[1]!.length, range.to, image
            ? state.schema.nodes.answerImage!.create({ src: href, alt: match[2] })
            : state.schema.text(match[2]!, [state.schema.marks.link!.create({ href })]));
        },
      })]; },
      extendNodeSchema(extension) {
        const role = ({ table: 'table', tableRow: 'row', tableCell: 'cell', tableHeader: 'header_cell' } as Record<string, string>)[extension.name];
        return role ? { tableRole: role } : {};
      },
      addKeyboardShortcuts() { return {
        'Mod-i': () => this.editor.commands.toggleMark('italic'),
        'Mod-Shift-x': () => this.editor.commands.toggleMark('strike'),
        'Mod-e': () => this.editor.commands.toggleMark('code'),
        Tab: () => { if (isInTable(this.editor.state)) goToNextCell(1)(this.editor.state, this.editor.view.dispatch); return true; },
        'Shift-Tab': () => { if (isInTable(this.editor.state)) goToNextCell(-1)(this.editor.state, this.editor.view.dispatch); return true; },
      }; },
      addProseMirrorPlugins() { return [tableEditing(), new Plugin({
        appendTransaction: (transactions, _old, state) => {
          if (!transactions.some(tr => tr.docChanged)) return null;
          const tr = state.tr;
          state.doc.descendants((node, pos) => {
            if (!node.isTextblock || node.type.spec.code) return;
            const text = node.textBetween(0, node.content.size, '', leaf =>
              leaf.type.name === 'softBreak' || leaf.type.name === 'hardBreak' ? '\n' : '\uFFFC');
            for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)) {
              const url = match[0].replace(/[.,;!?)]+$/, '');
              const href = normalizeEditorUrl(url);
              const from = pos + 1 + match.index!, to = from + url.length;
              let blocked = false, matching = true;
              state.doc.nodesBetween(from, to, child => {
                if (!child.isText) return;
                const link = child.marks.find(mark => mark.type.name === 'link');
                if (child.marks.some(mark => mark.type.name === 'code') || (link && !link.attrs.auto)) blocked = true;
                if (link?.attrs.href !== href) matching = false;
              });
              if (href && !blocked && !matching) tr.addMark(from, to, state.schema.marks.link!.create({ href, auto: true }));
            }
            return false;
          });
          return tr.steps.length ? tr : null;
        }, props: {
        decorations: state => {
          if (!this.storage.chunked) return null;
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'paragraph') return;
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'editor-answer-chunked' }));
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
        handlePaste: (_view, event) => {
          const text = event.clipboardData?.getData('text/plain') ?? '';
          if (event.clipboardData?.getData('text/html') || !/(?:^|\n)(?:#{1,6} |[-*>] |\d+\. |```|\|)|\*\*[^*]+\*\*|!?\[[^\]]*\]\([^)]+\)/.test(text)) return false;
          return this.editor.commands.insertContent(answerBodyToDoc(text).content ?? []);
        },
        handleClick: (view, pos, event) => {
          const target = event.target instanceof Element ? event.target.closest('a, img, [data-inline-math], [data-math-block]') : null;
          if (target) {
            event.preventDefault();
            if (target.tagName === 'A') {
              const range = getMarkRange(view.state.doc.resolve(pos), view.state.schema.marks.link!);
              if (range) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
            } else {
              const at = view.posAtDOM(target, 0);
              if (view.state.doc.nodeAt(at)) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
            }
            view.dom.dispatchEvent(new CustomEvent('markdown-edit-target', { bubbles: true, detail: target.tagName === 'A' ? 'link' : target.tagName === 'IMG' ? 'image' : target.hasAttribute('data-math-block') ? 'mathBlock' : 'math' }));
            return true;
          }
          if (!(event.target instanceof HTMLInputElement) || !event.target.matches('[data-task-checkbox]')) return false;
          const resolved = view.state.doc.resolve(pos);
          for (let depth = resolved.depth; depth > 0; depth--) {
            const node = resolved.node(depth);
            if (node.type.name !== 'listItem') continue;
            view.dispatch(view.state.tr.setNodeMarkup(resolved.before(depth), undefined, { ...node.attrs, checked: !node.attrs.checked }));
            return true;
          }
          return false;
        },
      } })]; },
    }),
    mark('italic', 'em'), mark('strike', 's'), mark('code', 'code'), mark('highlight', 'mark'),
    Mark.create({ name: 'comment', parseHTML: () => [{ tag: 'span[data-markdown-comment]' }], renderHTML: () => ['span', { 'data-markdown-comment': '', class: 'editor-comment' }, 0] }),
    Mark.create({ name: 'link', inclusive: false,
      addAttributes: () => ({ href: { default: '' }, title: { default: null }, auto: { default: false, rendered: false } }),
      parseHTML: () => [{ tag: 'a[href]' }],
      renderHTML: ({ HTMLAttributes }) => ['a', mergeAttributes(HTMLAttributes, { href: safeUrl(HTMLAttributes.href), rel: 'noopener noreferrer' }), 0] }),
    Node.create({ name: 'hardBreak', inline: true, group: 'inline', selectable: false,
      parseHTML: () => [{ tag: 'br' }], renderHTML: () => ['br'],
      addKeyboardShortcuts() { return { 'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' }) }; } }),
    Node.create({ name: 'horizontalRule', group: 'block', atom: true,
      parseHTML: () => [{ tag: 'hr' }], renderHTML: () => ['hr'] }),
    Node.create({ name: 'answerImage', inline: true, group: 'inline', atom: true,
      addAttributes: () => ({ src: { default: '' }, alt: { default: '' }, title: { default: null } }),
      parseHTML: () => [{ tag: 'img[src]' }], renderHTML: ({ HTMLAttributes }) => ['img', { ...HTMLAttributes, src: safeUrl(HTMLAttributes.src, true) }] }),
    Node.create({ name: 'inlineMath', inline: true, group: 'inline', atom: true,
      addAttributes: () => ({ value: { default: '' } }),
      renderHTML: ({ node }) => ['span', { 'data-inline-math': node.attrs.value }, node.attrs.value],
      addNodeView() { return ({ node }) => {
        const dom = document.createElement('span'); dom.dataset.inlineMath = node.attrs.value;
        katex.render(node.attrs.value, dom, { throwOnError: false, trust: false, strict: 'ignore' });
        return { dom };
      }; } }),
    Node.create({ name: 'footnoteReference', inline: true, group: 'inline', atom: true,
      addAttributes: () => ({ identifier: { default: '1' } }),
      renderHTML: ({ node }) => ['sup', { class: 'editor-footnote-reference' }, `[${node.attrs.identifier}]`] }),
    block('footnoteDefinition', 'div[data-footnote]', 'block+', {
      addAttributes: () => ({ identifier: { default: '1' } }),
      renderHTML: ({ node }) => ['div', { 'data-footnote': node.attrs.identifier, class: 'editor-footnote' }, ['span', { contenteditable: 'false' }, `[${node.attrs.identifier}] `], ['div', {}, 0]],
    }),
    block('mathBlock', 'pre[data-math-block]', 'text*', { code: true, marks: '', atom: true,
      renderHTML: () => ['pre', { 'data-math-block': '', class: 'editor-math-block' }, 0],
      addNodeView() { return ({ node }) => {
        const dom = document.createElement('div'); dom.dataset.mathBlock = ''; dom.className = 'editor-math-block';
        katex.render(node.textContent, dom, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore' });
        return { dom };
      }; },
    }),
    Node.create({ name: 'rawInline', inline: true, group: 'inline', atom: true,
      addAttributes: () => ({ raw: { default: '' } }),
      parseHTML: () => [{ tag: 'span[data-raw-markdown]' }],
      renderHTML: ({ node }) => ['span', { 'data-raw-markdown': node.attrs.raw }, node.attrs.raw] }),
    block('rawMarkdown', 'pre[data-raw-markdown]', 'text*', { code: true, marks: '',
      renderHTML: () => ['pre', { 'data-raw-markdown': '' }, 0] }),
    block('heading', 'h2', 'inline*', {
      addAttributes: () => ({ level: { default: 2 } }),
      parseHTML: () => [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      renderHTML: ({ node }) => [`h${node.attrs.level}`, {}, 0],
      addInputRules() { return [textblockTypeInputRule({ find: /^(#{1,6})\s$/, type: this.type, getAttributes: match => ({ level: match[1]!.length }) })]; },
    }),
    block('blockquote', 'blockquote', 'block+', { addInputRules() { return [wrappingInputRule({ find: /^>\s$/, type: this.type })]; } }),
    block('callout', 'aside[data-callout]', 'block+', {
      addAttributes: () => ({ kind: { default: 'note' }, title: { default: 'Note' } }),
      renderHTML: ({ node }) => ['aside', { 'data-callout': node.attrs.kind, class: 'editor-callout' },
        ['strong', { contenteditable: 'false' }, node.attrs.title], ['div', {}, 0]],
    }),
    block('bulletList', 'ul', 'listItem+', { addInputRules() { return [wrappingInputRule({ find: /^\s*[-+*]\s$/, type: this.type })]; } }),
    block('orderedList', 'ol', 'listItem+', { addAttributes: () => ({ start: { default: 1 } }) }),
    Node.create({ name: 'listItem', content: 'paragraph block*', defining: true,
      addAttributes: () => ({ checked: { default: null, parseHTML: element => element.hasAttribute('data-checked') ? element.dataset.checked === 'true' : null } }),
      parseHTML: () => [{ tag: 'li' }], renderHTML: ({ node }) => node.attrs.checked == null ? ['li', {}, 0]
        : ['li', { 'data-checked': String(node.attrs.checked), class: 'markdown-task-item' },
          ['input', { type: 'checkbox', 'data-task-checkbox': '', tabindex: '-1', contenteditable: 'false', ...(node.attrs.checked ? { checked: '' } : {}) }], ['div', {}, 0]],
      addKeyboardShortcuts() { return {
        Enter: () => this.editor.commands.command(({ state, dispatch }) => splitListItem(this.type)(state, dispatch)),
        Tab: () => { if (!this.editor.isActive('listItem')) return false; this.editor.commands.command(({ state, dispatch }) => sinkListItem(this.type)(state, dispatch)); return true; },
        'Shift-Tab': () => { if (!this.editor.isActive('listItem')) return false; this.editor.commands.command(({ state, dispatch }) => liftListItem(this.type)(state, dispatch)); return true; },
        Backspace: () => {
          const { selection } = this.editor.state;
          return selection.empty && selection.$from.parentOffset === 0 && this.editor.commands.command(({ state, dispatch }) => liftListItem(this.type)(state, dispatch));
        },
      }; } }),
    block('codeBlock', 'pre', 'text*', { code: true, marks: '',
      addAttributes: () => ({ language: { default: '' } }), renderHTML: () => ['pre', {}, ['code', {}, 0]],
      addKeyboardShortcuts() { return {
        Enter: () => {
          const { selection } = this.editor.state;
          const { $from, empty } = selection;
          // Keep ordinary newlines (including blank lines within code). Like
          // Tiptap's CodeBlock, a third Enter at the end returns to prose.
          if ($from.parent.type !== this.type) return false;
          if (!empty || $from.parentOffset !== $from.parent.content.size
            || !$from.parent.textContent.endsWith('\n\n')) {
            // Handle code before the list-item Enter shortcut can split it.
            return this.editor.commands.newlineInCode();
          }
          return this.editor.chain().deleteRange({ from: $from.pos - 2, to: $from.pos }).exitCode().run();
        },
        ArrowDown: () => {
          const { state } = this.editor;
          const { $from, empty } = state.selection;
          if (!empty || $from.parent.type !== this.type
            || $from.parentOffset !== $from.parent.content.size
            || state.doc.nodeAt($from.after())) return false;
          return this.editor.commands.exitCode();
        },
      }; },
    }),
    block('table', 'table', 'tableRow+', { isolating: true, renderHTML: () => ['table', {}, ['tbody', {}, 0]] }),
    Node.create({ name: 'tableRow', content: '(tableCell | tableHeader)+',
      parseHTML: () => [{ tag: 'tr' }], renderHTML: () => ['tr', {}, 0] }),
    ...['tableCell', 'tableHeader'].map((name) => Node.create({ name, content: 'paragraph+', isolating: true,
      addAttributes: () => ({ align: { default: null }, colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } }),
      parseHTML: () => [{ tag: name === 'tableCell' ? 'td' : 'th' }],
      renderHTML: ({ HTMLAttributes }) => [name === 'tableCell' ? 'td' : 'th', HTMLAttributes, 0] })),
  ];
}
