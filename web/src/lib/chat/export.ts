import type { NodeVersion, ScatterNode } from '@/store/types';
import type { ChatAnswerRef } from '@/store/chatTypes';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { withExportBibliography } from '@/lib/exportSources';
import { downloadBlob, sanitizeFilename } from '@/lib/download';
import { answerVersion, conversationPath } from './model';
import { parseChatMarkdown, type ChatMdNode } from './markdownFields';
import { markdownText } from './markdown';
import { languageInfo, languageDirection, versionLanguage, type GenerationLanguage } from '../languages';

function answerMarkdown(version: NodeVersion): string {
  // Remove semantic term marks before serializing Markdown. Removing brackets
  // afterwards joins separate emphasis delimiters into invalid `****` runs.
  return withExportBibliography(answerDocToBody(answerBodyToDoc(version.body), { stripTerms: true }), version);
}
export function chatExportMarkdown(node: ScatterNode, scope: 'answer' | 'conversation', selected?: ChatAnswerRef): string {
  if (!node.chat) throw new Error('Chat is unavailable.');
  if (scope === 'answer') {
    const version = selected && answerVersion(node, selected);
    if (!version?.chat) throw new Error('The selected answer is unavailable.');
    return `# ${version.chat.title}\n\n${answerMarkdown(version)}\n`;
  }
  return `# ${node.chat.title}\n\n${conversationPath(node).map((ref) => {
    const version = answerVersion(node, ref)!;
    return `## ${version.chat!.title}\n\n### You\n\n${version.chat!.question}\n\n### Scatter\n\n${answerMarkdown(version)}`;
  }).join('\n\n---\n\n')}\n`;
}

/** Reuse docx's lazy browser export, but preserve ordinary Markdown structure
 * instead of converting chat tables/lists into the encyclopedic editor model. */
export async function chatMarkdownToDocx(markdown: string | Array<{ markdown: string; language: GenerationLanguage }>, language: GenerationLanguage = 'en'): Promise<Blob> {
  const global = globalThis as unknown as { Buffer?: unknown; process?: unknown };
  if (!global.Buffer) global.Buffer = (await import('buffer')).Buffer;
  if (!global.process) { const process = await import('process'); global.process = process.default ?? process; }
  const { Document, Packer, Paragraph, TextRun, ExternalHyperlink, Table, TableRow, TableCell, WidthType } = await import('docx');
  type Run = InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>;
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  let paragraph = { bidirectional: false, alignment: 'left' as 'left' | 'right' };
  let runLanguage = { rightToLeft: false, language: { value: 'en-US', eastAsia: 'en-US', bidirectional: 'en-US' } };
  const inline = (node: ChatMdNode, style: { bold?: boolean; italics?: boolean; font?: string; size?: number } = {}): Run[] => {
    if (node.type === 'break') return [new TextRun({ break: 1, ...runLanguage, ...style })];
    if (node.type === 'link' && node.url && /^https?:\/\//i.test(node.url)) {
      return [new ExternalHyperlink({ link: node.url, children: [new TextRun({ ...runLanguage, text: markdownText(node) || node.url, style: 'Hyperlink' })] })];
    }
    if (node.value != null) return node.value.split('\n').map((text, index) => new TextRun({ ...runLanguage, text, ...style,
      ...(index ? { break: 1 } : {}), ...(node.type === 'inlineCode' ? { font: 'Consolas', rightToLeft: false } : {}) }));
    return node.children?.flatMap((child) => inline(child, { ...style,
      ...(node.type === 'strong' ? { bold: true } : {}), ...(node.type === 'emphasis' ? { italics: true } : {}) })) ?? [];
  };
  const blocks = (nodes: ChatMdNode[], depth = 0): Block[] => nodes.flatMap((node): Block[] => {
    if (node.type === 'table') return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
      rows: (node.children ?? []).map((row, index) => new TableRow({ tableHeader: index === 0,
        children: (row.children ?? []).map((cell) => new TableCell({ children: [new Paragraph({ ...paragraph, children: inline(cell, { bold: index === 0 }) })] })) })) })];
    if (node.type === 'list') return (node.children ?? []).flatMap((item, index) => {
      const contents = item.children ?? [];
      const first = contents[0];
      return [new Paragraph({ ...paragraph, indent: { [paragraph.bidirectional ? 'right' : 'left']: (depth + 1) * 280 }, spacing: { after: 80 },
        children: [new TextRun({ text: node.ordered ? `${(node.start ?? 1) + index}. ` : '• ' }), ...first ? inline(first) : []] }),
      ...blocks(contents.slice(1), depth + 1)];
    });
    if (node.type === 'blockquote') return blocks(node.children ?? [], depth + 1);
    if (node.type === 'thematicBreak') return [new Paragraph({ children: [new TextRun({ text: '—' })], spacing: { before: 180, after: 180 } })];
    if (node.type === 'code') return (node.value ?? '').split('\n').map((text) => new Paragraph({ children: [new TextRun({ text, font: 'Consolas', size: 20 })] }));
    if (node.type === 'html') return [];
    return [new Paragraph({ ...paragraph, spacing: { before: node.type === 'heading' ? 200 : 0, after: 120 },
      indent: depth ? { [paragraph.bidirectional ? 'right' : 'left']: depth * 280 } : undefined,
      children: node.type === 'heading' ? inline(node, { bold: true, size: node.depth === 1 ? 32 : 28 }) : inline(node) })];
  });
  const fragments = typeof markdown === 'string' ? [{ markdown, language }] : markdown;
  const children = fragments.flatMap(fragment => {
    const rtl = languageDirection(fragment.language) === 'rtl';
    const locale = languageInfo(fragment.language).locale;
    paragraph = { bidirectional: rtl, alignment: rtl ? 'right' : 'left' };
    runLanguage = { rightToLeft: rtl, language: { value: locale, eastAsia: locale, bidirectional: locale } };
    return blocks(parseChatMarkdown(fragment.markdown).children ?? []);
  });
  return Packer.toBlob(new Document({ sections: [{ children }] }));
}

export async function exportChat(node: ScatterNode, scope: 'answer' | 'conversation', format: 'md' | 'docx', ref?: ChatAnswerRef): Promise<void> {
  const markdown = chatExportMarkdown(node, scope, ref);
  const fragments = scope === 'conversation' ? [{ markdown: `# ${node.chat?.title ?? 'Chat'}`, language: versionLanguage(node.versions[node.currentVersionIndex]) },
    ...conversationPath(node).map(answerRef => { const version = answerVersion(node, answerRef)!;
      return { markdown: `## ${version.chat!.title}\n\n### You\n\n${version.chat!.question}\n\n### Scatter\n\n${answerMarkdown(version)}`, language: versionLanguage(version) }; })] : undefined;
  const blob = format === 'md' ? new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    : await chatMarkdownToDocx(fragments ?? markdown, versionLanguage(ref ? answerVersion(node, ref) : undefined));
  downloadBlob(blob, `${sanitizeFilename(node.chat?.title ?? 'chat')}-${scope}.${format}`);
}
