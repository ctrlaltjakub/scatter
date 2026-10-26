/**
 * Serializer between Scatter's stored node body and the TipTap "Edit text"
 * editor document. Pure, no DOM — covered by editorSerialize.test.ts.
 *
 * Both directions route through a neutral `EditorModel` so the .md / .docx
 * exporters can reuse one walk (see editorMarkdown.ts / editorDocx.ts).
 *
 * Storage grammar (same shape as `bulletsToPlainText`, but markers PRESERVED):
 *
 *     <free-text paragraph(s)>
 *     - <L1 title>
 *       - <L2 name>: <L2 desc>
 *       - <L2 name>                 (desc optional)
 *
 * Blocks are separated by a blank line. Free text keeps `**bold**` + `[[term]]`;
 * L1 titles / L2 names are plain whole-string terms (no inline markers emitted);
 * L2 descriptions keep word-level `[[term]]` only. Italic is intentionally not a
 * concept here (see the editor plan).
 *
 * Reuses the canvas parser (`parseBody`, `splitSentences`) and the term
 * helper (`wholeTerm`) so the editor and the canvas always agree on structure.
 */
import type { JSONContent } from '@tiptap/core';
import type { NodeType } from '@/store/types';
import { parseBody, separatorColonIndex, splitSentences } from './bulletParse';
import { wholeTerm } from './bulletTerms';

// ── Neutral model ──────────────────────────────────────────────────────────

/** One run of inline text with its marks. (No italic — dropped by design.) */
export interface Inline {
  text: string;
  bold?: boolean;
  term?: boolean;
}

export interface EditorModel {
  title: string;
  /** Paragraphs of the opening free-text section (always ≥1, may be empty). */
  freeText: Inline[][];
  /** The bullet outline (empty for explain nodes / no-bullet bodies). */
  bullets: { title: string; children: { name: string; desc: Inline[] }[] }[];
}

const hasBulletSection = (nodeType: NodeType): boolean =>
  nodeType !== 'explain' && nodeType !== 'media';

// ── Inline tokenizer (markdown markers → runs) ─────────────────────────────

/**
 * Scan a string into runs, recognising `**bold**` and `[[term]]` (nesting both
 * ways, e.g. `[[**x**]]`). Unbalanced markers are left as literal text. `marks`
 * carries the active marks down through recursion.
 */
function tokenize(s: string, marks: { bold?: boolean; term?: boolean } = {}): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...(marks.bold ? { bold: true } : {}), ...(marks.term ? { term: true } : {}) });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    if (s[i] === '[' && s[i + 1] === '[') {
      const end = s.indexOf(']]', i + 2);
      if (end >= 0) {
        flush();
        out.push(...tokenize(s.slice(i + 2, end), { ...marks, term: true }));
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end >= 0) {
        flush();
        out.push(...tokenize(s.slice(i + 2, end), { ...marks, bold: true }));
        i = end + 2;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/** Serialize runs back to markdown markers (used for free text + descriptions). */
function runsToMarkdown(runs: Inline[]): string {
  return runs
    .map((r) => {
      if (!r.text) return '';
      if (r.term && r.bold) return `[[**${r.text}**]]`;
      if (r.term) return `[[${r.text}]]`;
      if (r.bold) return `**${r.text}**`;
      return r.text;
    })
    .join('');
}

// ── body → model → doc ─────────────────────────────────────────────────────

export function modelFromBody(
  body: string,
  header: string,
  withBullets: boolean,
  chunkIntro = true,
): EditorModel {
  const normalized = body.replace(/\r\n?/g, '\n');
  const parsed = parseBody(normalized) ?? { freeText: '', bullets: [] };

  // Free text → ONE paragraph per sentence when chunking is on (matches the
  // node's sentence-per-line), else ONE flowing paragraph. Lossless either way:
  // the stored body always re-joins with spaces (see modelToBody).
  const freeText: Inline[][] = chunkIntro
    ? splitSentences(parsed.freeText).map((s) => tokenize(s.trim()))
    : [tokenize(parsed.freeText.replace(/\s+/g, ' ').trim())];
  if (freeText.length === 0) freeText.push([]);

  const bullets = withBullets
    ? parsed.bullets.map((b) => ({
        title: wholeTerm(b.title),
        children: b.children.map((c) => ({
          name: wholeTerm(c.name),
          desc: tokenize(c.desc).map((r) => ({ text: r.text, ...(r.term ? { term: true } : {}) })),
        })),
      }))
    : [];

  return { title: header.trim(), freeText, bullets };
}

const textNode = (s: string): JSONContent => ({ type: 'text', text: s });

const runsToNodes = (runs: Inline[]): JSONContent[] =>
  runs
    .filter((r) => r.text)
    .map((r) => {
      const m: JSONContent['marks'] = [];
      if (r.bold) m.push({ type: 'bold' });
      if (r.term) m.push({ type: 'term' });
      return m.length ? { type: 'text', text: r.text, marks: m } : { type: 'text', text: r.text! };
    });

/** A textblock node — content omitted when empty (ProseMirror dislikes []-text). */
const block = (type: string, nodes: JSONContent[]): JSONContent =>
  nodes.length ? { type, content: nodes } : { type };

/** Inline content of one single-line l2Item: "name: description". The name is
 *  wrapped as a [[term]] when it contains a colon, so the first split-colon stays
 *  the real demarcation (matches the node's separatorColonIndex). */
function l2ItemNodes(c: { name: string; desc: Inline[] }): JSONContent[] {
  const nameStr = c.name.includes(':') ? `[[${c.name}]]` : c.name;
  const nameNodes = runsToNodes(tokenize(nameStr));
  const hasDesc = c.desc.some((r) => r.text.trim());
  const descNodes = hasDesc ? [textNode(': '), ...runsToNodes(c.desc)] : [];
  return [...nameNodes, ...descNodes];
}

export function modelToDoc(model: EditorModel, withBullets: boolean): JSONContent {
  const content: JSONContent[] = [
    block('title', model.title ? [textNode(model.title)] : []),
    {
      type: 'freeTextSection',
      content: model.freeText.map((runs) => block('paragraph', runsToNodes(runs))),
    },
  ];

  if (withBullets) {
    const items: JSONContent[] = (model.bullets.length ? model.bullets : [{ title: '', children: [] }]).map(
      (b) => ({
        type: 'outlineItem',
        content: [
          block('l1Title', b.title ? [textNode(b.title)] : []),
          {
            type: 'l2List',
            content: b.children.map((c) => block('l2Item', l2ItemNodes(c))),
          },
        ],
      }),
    );
    content.push({ type: 'bulletSection', content: items });
  }

  return { type: 'doc', content };
}

export function bodyToDoc(
  body: string,
  nodeType: NodeType,
  header: string,
  chunkIntro = true,
): JSONContent {
  const withBullets = hasBulletSection(nodeType);
  return modelToDoc(modelFromBody(body, header, withBullets, chunkIntro), withBullets);
}

// ── doc → model → body ─────────────────────────────────────────────────────

const find = (doc: JSONContent, type: string): JSONContent | undefined =>
  (doc.content ?? []).find((n) => n.type === type);

const plainText = (node: JSONContent | undefined): string =>
  (node?.content ?? [])
    .filter((n) => n.type === 'text')
    .map((n) => n.text ?? '')
    .join('');

const readRuns = (node: JSONContent | undefined): Inline[] =>
  (node?.content ?? [])
    .filter((n) => n.type === 'text')
    .map((n) => {
      const marks = (n.marks ?? []).map((m) => m.type);
      return { text: n.text ?? '', ...(marks.includes('bold') ? { bold: true } : {}), ...(marks.includes('term') ? { term: true } : {}) };
    });

export function docToModel(doc: JSONContent): EditorModel {
  const title = plainText(find(doc, 'title')).trim();

  const freeSection = find(doc, 'freeTextSection');
  const freeText: Inline[][] = (freeSection?.content ?? [])
    .filter((p) => p.type === 'paragraph')
    .map((p) => readRuns(p));
  if (freeText.length === 0) freeText.push([]);

  const bulletSection = find(doc, 'bulletSection');
  const bullets = (bulletSection?.content ?? [])
    .filter((it) => it.type === 'outlineItem')
    .map((it) => {
      const titleNode = (it.content ?? []).find((n) => n.type === 'l1Title');
      const listNode = (it.content ?? []).find((n) => n.type === 'l2List');
      return {
        title: plainText(titleNode).trim(),
        children: (listNode?.content ?? [])
          .filter((li) => li.type === 'l2Item')
          .map((li) => {
            // Reconstruct the line "name: desc" (with [[ ]] for terms), split at the
            // first colon outside a term — exactly like the node's parser.
            const md = runsToMarkdown(readRuns(li));
            const ci = separatorColonIndex(md);
            if (ci >= 0) {
              return { name: wholeTerm(md.slice(0, ci)), desc: tokenize(md.slice(ci + 1).trim()) };
            }
            return { name: wholeTerm(md), desc: [] as Inline[] };
          }),
      };
    });

  return { title, freeText, bullets };
}

export function modelToBody(model: EditorModel): string {
  const blocks: string[] = [];

  // Re-join the sentence paragraphs into one free-text block (the node + parser
  // re-split into sentences on render).
  const ft = model.freeText.map((p) => runsToMarkdown(p).trim()).filter(Boolean).join(' ');
  if (ft) blocks.push(ft);

  for (const b of model.bullets) {
    const children = b.children.filter((c) => c.name.trim());
    if (!b.title.trim() && children.length === 0) continue; // drop the empty starter bullet
    const lines = [`- ${b.title.replace(/^\s*[-*+]\s+/, '').trim()}`];
    for (const c of children) {
      const name = c.name.trim();
      const nameOut = name.includes(':') ? `[[${name}]]` : name;
      const desc = runsToMarkdown(c.desc).trim();
      lines.push(desc ? `  - ${nameOut}: ${desc}` : `  - ${nameOut}`);
    }
    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

export function docToBody(doc: JSONContent): string {
  return modelToBody(docToModel(doc));
}
