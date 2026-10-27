/**
 * The TipTap schema for the "Edit text" editor — a strict, custom document that
 * mirrors Scatter's storage 1:1 so the serializer (editorSerialize.ts) can round
 * -trip safely.
 *
 * "Forced sections" = the doc's required (non-optional) children, so ProseMirror
 * refuses to delete them. "Bullets are term-only" = the per-node `marks`
 * allowlists: bold/italic literally cannot be stored inside a bullet.
 *
 *   doc(regular) = title freeTextSection bulletSection
 *   doc(explain) = title freeTextSection
 *   freeTextSection = paragraph+        (paragraph: marks bold + term)
 *   bulletSection   = outlineItem+
 *   outlineItem     = l1Title l2List    (l1Title: no marks)
 *   l2List          = l2Item*
 *   l2Item          = l2Name l2Desc?    (l2Name: no marks; l2Desc: marks term)
 */
import { Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Bold from '@tiptap/extension-bold';
import History from '@tiptap/extension-history';
import Gapcursor from '@tiptap/extension-gapcursor';
import Dropcursor from '@tiptap/extension-dropcursor';
import type { NodeType } from '@/store/types';
import { TermMark } from './TermMark';
import { TermResize } from './TermResize';
import { L2NameDeco } from './L2NameDeco';
import { OutlineKeymap } from './OutlineKeymap';
import { SoftBreak } from './SoftBreak';

/** Article title — plain single line, persists to `version.header`. */
const Title = Node.create({
  name: 'title',
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: 'h1.editor-title' }],
  renderHTML: () => ['h1', { class: 'editor-title' }, 0],
});

/** Opening free-text section — one or more rich paragraphs. */
const FreeTextSection = Node.create({
  name: 'freeTextSection',
  content: 'paragraph+',
  parseHTML: () => [{ tag: 'div.editor-freetext' }],
  renderHTML: () => ['div', { class: 'editor-freetext' }, 0],
});

/** A free-text paragraph — bold + term marks allowed. */
const Paragraph = Node.create({
  name: 'paragraph',
  group: 'block',
  content: 'inline*',
  marks: 'bold term',
  parseHTML: () => [{ tag: 'p' }],
  renderHTML: () => ['p', { class: 'editor-para' }, 0],
  addKeyboardShortcuts() { return {
    'Shift-Enter': () => this.editor.isActive('paragraph')
      && this.editor.commands.insertContent({ type: 'softBreak' }),
  }; },
});

/** The bullet outline container (regular nodes only). */
const BulletSection = Node.create({
  name: 'bulletSection',
  content: 'outlineItem+',
  parseHTML: () => [{ tag: 'div.editor-bullets' }],
  renderHTML: () => ['div', { class: 'editor-bullets' }, 0],
});

/** One level-1 bullet = its title + a list of level-2 children. */
const OutlineItem = Node.create({
  name: 'outlineItem',
  content: 'l1Title l2List',
  parseHTML: () => [{ tag: 'div.editor-l1' }],
  renderHTML: () => ['div', { class: 'editor-l1' }, 0],
});

/** Level-1 title — a single line; the whole thing renders bold + underlined like
 *  a term (forced). Allows term marks so a promoted "name: desc" keeps its terms. */
const L1Title = Node.create({
  name: 'l1Title',
  content: 'inline*',
  marks: 'term',
  defining: true,
  parseHTML: () => [{ tag: 'div.editor-l1-title' }],
  renderHTML: () => ['div', { class: 'editor-l1-title' }, 0],
});

/** The list of level-2 children under an L1 (may be empty). */
const L2List = Node.create({
  name: 'l2List',
  content: 'l2Item*',
  parseHTML: () => [{ tag: 'div.editor-l2-list' }],
  renderHTML: () => ['div', { class: 'editor-l2-list' }, 0],
});

/** One level-2 child — a single editable line "name: description". The FIRST colon
 *  (outside a [[term]]) demarcates name|description at render (see L2NameDeco); no
 *  colon ⇒ the whole line is the name. Mirrors the node's parser. */
const L2Item = Node.create({
  name: 'l2Item',
  content: 'inline*',
  marks: 'term',
  defining: true,
  parseHTML: () => [{ tag: 'div.editor-l2' }],
  renderHTML: () => ['div', { class: 'editor-l2' }, 0],
});

/**
 * Build the extension list for a given node type. Explain nodes omit the bullet
 * section from the document content (free text only); every node spec is still
 * registered so the schema is identical otherwise.
 */
export function buildExtensions(nodeType: NodeType) {
  const withBullets = nodeType !== 'explain' && nodeType !== 'media';
  const Doc = Document.extend({
    content: withBullets ? 'title freeTextSection bulletSection' : 'title freeTextSection',
  });

  return [
    Doc,
    Text,
    Bold,
    TermMark,
    Title,
    FreeTextSection,
    Paragraph,
    SoftBreak,
    BulletSection,
    OutlineItem,
    L1Title,
    L2List,
    L2Item,
    L2NameDeco,
    TermResize,
    OutlineKeymap,
    History,
    Gapcursor,
    Dropcursor,
  ];
}
