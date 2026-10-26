import { describe, expect, it } from 'vitest';
import { appendChatAnswer, createChatNode, captureChatParent, conversationPath, updateChatAnswer } from './model';
import { boundedReferencedAnswer, buildChatContext, chatCompactionBatches, chatSystemPrompt,
  chatCompactionBoundary, commitChatMemory, estimateChatTokens, undoChatCompaction } from './context';
import { chatExportMarkdown } from './export';
import { parseChatDraft } from '@/store/useChatRuntimeStore';
import type { ScatterNode } from '@/store/types';

const node = () => createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 620 });
function conversation(): ScatterNode {
  let chat = node();
  for (let i = 1; i <= 4; i++) {
    chat = appendChatAnswer(chat, { turnId: `t${i}`, createdAt: i + 1, question: `Question ${i}` });
    chat = updateChatAnswer(chat, { turnId: `t${i}`, versionCreatedAt: i + 1 }, { body: `Answer **${i}** with [[Go]].` }, { state: 'complete' });
  }
  return { ...chat, generating: false };
}
describe('chat context and durable boundaries', () => {
  it('retains a selected passage in later conversation context and compaction', () => {
    let chat = conversation();
    const reference = { turnId: 't1', versionCreatedAt: 2, title: 'Working memory', selectedText: '作業記憶 — الذاكرة العاملة' };
    chat = appendChatAnswer(chat, { turnId: 't5', createdAt: 10, question: 'What is this?', metadata: { reference } });
    chat = updateChatAnswer(chat, { turnId: 't5', versionCreatedAt: 10 }, { body: 'An explanation.' }, { state: 'complete' });
    chat = appendChatAnswer(chat, { turnId: 't6', createdAt: 11, question: 'Continue' });
    const messages = buildChatContext({ node: chat, answer: chat.versions.at(-1)!, system: 'System' }).messages;
    const question = messages.find(m => m.content.startsWith('What is this?'));
    expect(question?.content).toContain(reference.selectedText);
    expect(chatCompactionBatches(chat, conversationPath(chat)).join('\n')).toContain(reference.selectedText);
  });
  it('omits embedded image byte strings from parent context without mutating the node', () => {
    const parent = node();
    parent.versions[0]!.body = '![Figure](data:image/png;base64,' + 'abcd'.repeat(1000) + ')';
    const chat = appendChatAnswer(node(), { turnId: 'a', createdAt: 2, question: 'Explain the text', parentSnapshot: captureChatParent(parent, 'p1') });
    const { messages } = buildChatContext({ node: chat, answer: chat.versions.at(-1)!, system: 'System' });
    expect(messages.map(message => message.content).join('\n')).not.toContain('base64');
    expect(parent.versions[0]!.body).toContain('data:image/png;base64,');
  });
  it('sends previous answers with only term markers removed, preserving wording, Markdown and citations', () => {
    const chat = appendChatAnswer(conversation(), { turnId: 't5', createdAt: 10, question: 'Continue' });
    chat.versions[1]!.body = '**[[Working memory]]** keeps  information.\\\nA second line. ⟦1⟧\n\n- **Detail**: [[Retrieval]] matters.';
    const messages = buildChatContext({ node: chat, answer: chat.versions.at(-1)!, system: 'System' }).messages;
    expect(messages.find((message) => message.role === 'assistant')?.content)
      .toBe('**Working memory** keeps  information.\\\nA second line. ⟦1⟧\n\n- **Detail**: Retrieval matters.');
  });
  it('does not repeat unchanged parent content with every exchange, but marks a changed parent', () => {
    const parent = node(); parent.versions[0]!.body = 'Original parent context';
    let chat = appendChatAnswer(node(), { turnId: 'a', createdAt: 2, question: 'First', parentSnapshot: captureChatParent(parent, 'p1') });
    chat = appendChatAnswer(chat, { turnId: 'b', createdAt: 3, question: 'More', parentSnapshot: captureChatParent(parent, 'p2') });
    parent.versions[0]!.body = 'Changed parent context';
    chat = appendChatAnswer(chat, { turnId: 'c', createdAt: 4, question: 'Now?', parentSnapshot: captureChatParent(parent, 'p3') });
    const messages = buildChatContext({ node: chat, answer: chat.versions.at(-1)!, system: 'System' }).messages;
    expect(messages.filter((m) => m.content.includes('Original parent context'))).toHaveLength(1);
    expect(messages.filter((m) => m.content.includes('Changed parent context'))).toHaveLength(1);
    expect(messages.find((m) => m.content.includes('Changed parent context'))?.content).toContain('context update');
  });
  it('reverses compaction until used, leaves readable turns untouched, and rejects another path', () => {
    const original = conversation();
    const memory = { id: 'm', summary: 'Earlier facts', createdAt: 10, coveredPath: conversationPath(original).slice(0, 2) };
    const compacted = commitChatMemory(original, memory);
    expect(compacted.chat?.compactions[0]?.afterTurnId).toBe('t4');
    expect(compacted.versions).toBe(original.versions);
    expect(undoChatCompaction(compacted).chat?.memory).toBeUndefined();
    const appended = appendChatAnswer(compacted, { turnId: 't5', createdAt: 11, question: 'Continue' });
    expect(undoChatCompaction(appended)).toBe(appended);
    const context = buildChatContext({ node: appended, answer: appended.versions.at(-1)!, system: 'System' }).messages;
    expect(context.some((m) => m.content === 'Question 1')).toBe(false);
    expect(context.some((m) => m.content === 'Question 3')).toBe(true);
    expect(commitChatMemory(original, { ...memory, coveredPath: [{ turnId: 'wrong', versionCreatedAt: 2 }] })).toBe(original);
  });
  it('keeps compaction input bounded and incremental', () => {
    const chat = conversation();
    chat.versions[1]!.body = 'A long detail. '.repeat(8000);
    const batches = chatCompactionBatches(chat, conversationPath(chat), 2000);
    expect(batches.length).toBeGreaterThan(4);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(2040);
    const compacted = commitChatMemory(chat, { id: 'm', summary: 'Prior', createdAt: 8, coveredPath: conversationPath(chat) });
    expect(chatCompactionBatches(compacted, conversationPath(chat))).toEqual([]);
  });
  it('anchors automatic compaction before the provisional reply, not after it', () => {
    const pending = appendChatAnswer(conversation(), { turnId: 't5', createdAt: 11, question: 'Continue' });
    const compacted = commitChatMemory(pending, { id: 'm', summary: 'Earlier facts', createdAt: 12,
      coveredPath: conversationPath(pending).slice(0, 2) });
    expect(compacted.chat?.compactions[0]?.afterTurnId).toBe('t4');
  });
  it('places legacy notices at the time of compaction, including after reload and later replies', () => {
    const original = conversation();
    const entry = { memory: { id: 'old', summary: 'Earlier facts', createdAt: 10,
      coveredPath: conversationPath(original).slice(0, 1) } };
    expect(chatCompactionBoundary(original, entry)).toBe('t4');
    const continued = appendChatAnswer(original, { turnId: 't5', createdAt: 11, question: 'Later' });
    expect(chatCompactionBoundary(JSON.parse(JSON.stringify(continued)), entry)).toBe('t4');
  });
  it('bounds an explicitly referenced huge answer without substituting another answer', () => {
    const text = 'General learning details. '.repeat(1500) + '\nThe exact quasar identifier is QX991.\n' + 'Other details. '.repeat(1500);
    const result = boundedReferencedAnswer(text, 'quasar QX991', 8000);
    expect(result.excerpted).toBe(true);
    expect(result.text).toContain('QX991');
    expect(result.text.length).toBeLessThan(8500);
  });
  it('applies chat instructions with information chunking on or off', () => {
    expect(chatSystemPrompt(false, 'Please be brief', false)).toContain('Please be brief');
    expect(chatSystemPrompt(true, 'Please be brief', false)).toContain('Please be brief');
    expect(estimateChatTokens('東京')).toBeGreaterThan(0);
    expect(chatSystemPrompt(true, '', false)).toContain('In EVERY sentence, bold its 2-3 most important parts');
    expect(chatSystemPrompt(true, '', false)).toContain('inside list items and table cells');
    expect(chatSystemPrompt(false, '', false)).not.toContain('bold its 2-3');
  });
  it('exports the continuing path and visible enrichment, never hidden memory or alternatives', () => {
    let chat = conversation();
    chat = appendChatAnswer(chat, { turnId: 't4', createdAt: 12, question: 'New question', replaceLatest: true });
    chat = updateChatAnswer(chat, { turnId: 't4', versionCreatedAt: 12 }, { body: 'New answer ⟦1⟧', sources: [{ n: 1, url: 'https://example.com', title: 'Source' }] }, { state: 'complete' });
    chat.chat!.memory = { id: 'm', summary: 'HIDDEN MEMORY', coveredPath: [], createdAt: 9 };
    const output = chatExportMarkdown(chat, 'conversation');
    expect(output).toContain('New question'); expect(output).toContain('https://example.com');
    expect(output).not.toContain('Question 4'); expect(output).not.toContain('HIDDEN MEMORY'); expect(output).not.toContain('[[');
  });
  it('rejects malformed local reference metadata while preserving a typed draft', () => {
    expect(parseChatDraft({ text: 'Keep me', reference: { title: 'bad' }, editingTurnId: 5 }))
      .toEqual({ text: 'Keep me', reference: undefined, editingTurnId: undefined, previousDraft: undefined });
    expect(parseChatDraft({ text: 5 })).toBeUndefined();
  });
});
