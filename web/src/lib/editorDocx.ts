/**
 * Export an EditorModel to a .docx Blob, laid out like a Scatter node: a bold
 * title, the opening prose with its authored paragraphs and line breaks,
 * then the bullet outline using docx's
 * built-in bullet list (level 0 / level 1). The `docx` lib is dynamically
 * imported so it stays out of the editor's initial chunk. Terms export as plain text.
 */
import type { EditorModel, Inline } from './editorSerialize';
import { languageInfo, languageDirection, type GenerationLanguage } from './languages';
import { exportSourceEntries, type ExportSources } from './exportSources';

export async function modelToDocxBlob(m: EditorModel, language: GenerationLanguage = 'en', sources?: ExportSources): Promise<Blob> {
  // docx's browser bundle references global Buffer/process, which webpack doesn't
  // provide in the browser — polyfill them just-in-time (scoped to this export,
  // so no global webpack/Next config change is needed).
  const g = globalThis as unknown as { Buffer?: unknown; process?: unknown };
  if (typeof g.Buffer === 'undefined') g.Buffer = (await import('buffer')).Buffer;
  if (typeof g.process === 'undefined') {
    const proc = await import('process');
    g.process = (proc as { default?: unknown }).default ?? proc;
  }

  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink } = await import('docx');
  const rtl = languageDirection(language) === 'rtl';
  const locale = languageInfo(language).locale;
  const paragraph = { bidirectional: rtl, ...(rtl ? { alignment: 'right' as const } : {}) };

  const toRuns = (rs: Inline[]) =>
    rs.filter((r) => r.text).flatMap((r) => r.text.split('\n').map((text, index) =>
      new TextRun({ text, bold: !!r.bold, ...(index ? { break: 1 } : {}) })));

  const children: InstanceType<typeof Paragraph>[] = [];

  // Title — bold, slightly larger (not a Word "Heading" style, to match the node).
  if (m.title.trim()) {
    children.push(
      new Paragraph({ ...paragraph,
        spacing: { after: 160 },
        children: [new TextRun({ text: m.title.trim(), bold: true, size: 32 })],
      }),
    );
  }

  // The document's paragraph and line boundaries are authored, never inferred.
  for (const p of m.freeText) {
    const runs = toRuns(p);
    if (runs.length) {
      children.push(new Paragraph({ ...paragraph, spacing: { after: 40 }, children: runs }));
    }
  }

  // Bullet outline — docx built-in bullets (reliable, no custom numbering).
  for (const b of m.bullets) {
    const kids = b.children.filter((c) => c.name.trim());
    if (!b.title.trim() && kids.length === 0) continue;
    children.push(new Paragraph({ ...paragraph, bullet: { level: 0 }, spacing: { before: 80 }, children: [new TextRun({ text: b.title.trim() })] }));
    for (const c of kids) {
      const parts = [new TextRun({ text: c.name.trim(), bold: true })];
      const desc = toRuns(c.desc);
      if (desc.length) parts.push(new TextRun({ text: ': ' }), ...desc);
      children.push(new Paragraph({ ...paragraph, bullet: { level: 1 }, children: parts }));
    }
  }

  const bibliography = exportSourceEntries(sources);
  if (bibliography.length) {
    children.push(new Paragraph({ ...paragraph, spacing: { before: 240, after: 120 },
      children: [new TextRun({ text: 'Bibliography', bold: true, size: 28 })] }));
    for (const source of bibliography) {
      children.push(new Paragraph({ ...paragraph, spacing: { after: 100 }, children: [
        new TextRun({ text: `${source.marker} ` }),
        source.url && /^https?:\/\//i.test(source.url)
          ? new ExternalHyperlink({ link: source.url, children: [new TextRun({ text: source.label, style: 'Hyperlink' })] })
          : new TextRun({ text: source.label }),
      ] }));
      if (source.excerpt) children.push(new Paragraph({ ...paragraph, spacing: { after: 100 },
        children: [new TextRun({ text: source.excerpt, italics: true })] }));
    }
  }

  const doc = new Document({ styles: { default: { document: { run: { rightToLeft: rtl, language: { value: locale, eastAsia: locale, bidirectional: locale } } } } }, sections: [{ children }] });
  return Packer.toBlob(doc);
}
