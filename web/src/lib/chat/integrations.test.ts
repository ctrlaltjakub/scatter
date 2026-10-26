import { describe, expect, it } from 'vitest';
import { appendChatAnswer, createChatNode, updateChatAnswer, conversationPath } from './model';
import { buildSearchIndex, searchNodes } from '@/lib/searchNodes';
import { chatExportMarkdown, chatMarkdownToDocx } from './export';
import { sourceFieldProjection } from '@/lib/nodeTextSelection';
import { createArrowSourceSelection, resolveArrowSourceSelection } from '@/lib/sourceSelection';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';
import JSZip from 'jszip';

function conversation() {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
  node = appendChatAnswer(node, { turnId: 'a', createdAt: 2, question: 'A paired question' });
  node = updateChatAnswer(node, { turnId: 'a', versionCreatedAt: 2 }, { body: 'The original **[[archipelago]]** answer. (1) ⟦2⟧',
    internalSources: [{ n: 1, sourceId: 's', revisionId: 'r', passageId: 'p', sourceTitle: 'Notes', excerpt: 'Original excerpt' }],
    sources: [{ n: 2, url: 'https://example.com', title: 'Example' }] }, { state: 'complete' });
  node = appendChatAnswer(node, { turnId: 'b', createdAt: 3, question: 'Another question' });
  node = updateChatAnswer(node, { turnId: 'b', versionCreatedAt: 3 }, { body: 'A hidden chrysanthemum answer.' }, { state: 'complete' });
  node = appendChatAnswer(node, { turnId: 'b', createdAt: 4, question: 'Alternative question', replaceLatest: true });
  node = updateChatAnswer(node, { turnId: 'b', versionCreatedAt: 4 }, { body: 'A visible bougainvillea answer.' }, { state: 'complete' });
  return node;
}
describe('chat cross-surface integration', () => {
  it('keeps evidence attached through optional term marking and outline renaming', () => {
    const answer = conversation().versions[1]!;
    const before = factCheckBodyFingerprint(answer);
    expect(factCheckBodyFingerprint({ ...answer, body: answer.body.replace(/\[\[|\]\]/g, ''),
      chat: { ...answer.chat!, title: 'Renamed outline entry' } })).toBe(before);
    expect(factCheckBodyFingerprint({ ...answer, body: answer.body + ' A changed fact.' })).not.toBe(before);
  });
  it('searches every visible paired turn, not hidden alternatives or memory', () => {
    const node = conversation();
    node.chat!.memory = { id: 'm', createdAt: 5, summary: 'Secret quokka memory', coveredPath: conversationPath(node).slice(0, 1) };
    const index = buildSearchIndex([node]);
    expect(searchNodes(index, 'archipelago')[0]?.sourceAnswer).toEqual({ turnId: 'a', versionCreatedAt: 2 });
    expect(searchNodes(index, 'chrysanthemum')).toHaveLength(0);
    expect(searchNodes(index, 'quokka')).toHaveLength(0);
    expect(searchNodes(index, 'bougainvillea')[0]?.sourceAnswer?.versionCreatedAt).toBe(4);
    const preview = buildSearchIndex([node], { chat: { previews: { b: 3 } } });
    expect(searchNodes(preview, 'chrysanthemum')[0]?.sourceAnswer?.versionCreatedAt).toBe(3);
  });
  it('exports the established conversation path with paired questions and scoped source lists', async () => {
    const node = conversation();
    const markdown = chatExportMarkdown(node, 'conversation');
    expect(markdown).toContain('A paired question');
    expect(markdown).toContain('archipelago');
    expect(markdown).not.toContain('[[archipelago]]');
    expect(markdown).not.toContain('chrysanthemum');
    expect(markdown).toContain('## Bibliography');
    const selected = chatExportMarkdown(node, 'answer', { turnId: 'b', versionCreatedAt: 3 });
    expect(selected).toContain('chrysanthemum');
    const doc = await chatMarkdownToDocx(`${markdown}\n\n## A **bold heading**\n\n[**Bold link**](https://example.com)\n\n| Key | Value |\n|---|---|\n| Test | 42 |\n\nFirst verse\\\nSecond verse`);
    expect(doc.size).toBeGreaterThan(1000);
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = reject; reader.readAsArrayBuffer(doc);
    });
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    expect(xml).toContain('bold heading');
    expect(xml).toContain('Bold link');
    expect(xml).toMatch(/First verse<\/w:t>[\s\S]*?<w:br\/>[\s\S]*?Second verse/);
  });
  it('retains exact selection anchors through Markdown bold text and table cells', () => {
    const body = 'A **bold word** ends here.\n\n| Name | Value |\n|---|---|\n| Item | A value |';
    const start = body.indexOf('bold word');
    const anchor = createArrowSourceSelection({ nodeId: 'chat', versionIndex: 1, sourceBody: body,
      start, end: start + 9, text: 'bold word', parts: [{ sourceField: 'chat:0', start, end: start + 9, text: 'bold word' }] }, 2, 3);
    expect(resolveArrowSourceSelection(body, 2, anchor)?.parts[0]).toMatchObject({ displayStart: 2, displayEnd: 11, text: 'bold word' });
    expect(sourceFieldProjection(body, 'chat:4')?.text).toBe('A value');
  });
  it('maps escaped Markdown, decoded entities, and multi-backtick code without shifting words', () => {
    const body = 'Use &amp; literal \\*stars\\* and `` **raw** `code` `` or [[term]].';
    const projection = sourceFieldProjection(body, 'chat:0')!;
    expect(projection.text).toBe('Use & literal *stars* and **raw** `code` or term.');
    for (const word of ['literal', 'stars', '**raw**', '`code`', 'term']) {
      const from = projection.text.indexOf(word);
      expect(body.slice(projection.raw[from], projection.rawEnds[from + word.length - 1])).toBe(word);
    }
    const amp = projection.text.indexOf('&');
    expect(body.slice(projection.raw[amp], projection.rawEnds[amp])).toBe('&amp;');
  });
});
