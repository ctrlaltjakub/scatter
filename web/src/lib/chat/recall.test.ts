import { describe, expect, it } from 'vitest';
import { appendChatAnswer, conversationPath, createChatNode, updateChatAnswer } from './model';
import { conversationSearchTool } from './recall';

function chat(bodies: string[]) {
  let node = createChatNode({ id: 'recall-test', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 600 });
  for (const [i, body] of bodies.entries()) {
    node = appendChatAnswer(node, { turnId: `turn-${i}`, createdAt: i + 2, question: `Study question ${i}` });
    node = updateChatAnswer(node, { turnId: `turn-${i}`, versionCreatedAt: i + 2 }, { body,
      sources: [{ n: 1, title: 'Notes', url: 'https://example.com/notes' }] }, { state: 'complete' });
  }
  return node;
}
describe('bounded conversation recall', () => {
  it('can retrieve original attached document text after the conversation is compacted', async () => {
    const node = chat(['A short answer about the attached notes.']);
    node.versions[1]!.chat!.attachments = [{ id: 'file', name: 'Observations.txt', kind: 'text', text: 'The exact specimen is PHOENIX-928.' }];
    const result = JSON.parse((await conversationSearchTool(node, conversationPath(node)).execute('PHOENIX-928', new AbortController().signal)).text);
    expect(result.matches[0]).toMatchObject({ attachmentName: 'Observations.txt', completeAnswer: false });
    expect(result.matches[0].passage).toContain('PHOENIX-928');
  });
  it('returns a complete short answer with its paired question and citations, and excludes later turns', async () => {
    const node = chat(['The identifier is QUASAR-29. A related explanation follows. ⟦1⟧', 'Hidden later QUASAR-30.']);
    const tool = conversationSearchTool(node, conversationPath(node).slice(0, 1));
    const result = JSON.parse((await tool.execute('QUASAR-29', new AbortController().signal)).text);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ turnId: 'turn-0', question: 'Study question 0', completeAnswer: true });
    expect(result.matches[0].passage).toContain('related explanation');
    expect(result.matches[0].sources[0].url).toBe('https://example.com/notes');
    expect(JSON.stringify(result)).not.toContain('QUASAR-30');
  });
  it('retains table headings and surrounding section when recalling part of a long answer', async () => {
    const table = `# Travel measurements\n\n| Journey | Distance km | Duration hours |\n|---|---|---|\n${Array.from({ length: 100 }, (_, i) => `| Route ${i === 79 ? 'KESTREL' : i} | ${i + 10} | 3 |`).join('\n')}`;
    const node = chat(['Introductory background. '.repeat(100) + '\n\n' + table]);
    const result = JSON.parse((await conversationSearchTool(node, conversationPath(node)).execute('KESTREL', new AbortController().signal)).text);
    expect(result.matches[0]).toMatchObject({ section: 'Travel measurements', completeAnswer: false });
    expect(result.matches[0].passage).toContain('Journey: Route KESTREL; Distance km: 89; Duration hours: 3');
    expect(JSON.stringify(result).length).toBeLessThan(15_000);
  });
  it('reuses a bounded local index for a sizeable conversation', async () => {
    const node = chat(Array.from({ length: 300 }, (_, i) => `Lesson ${i}: ${'Background context and observations. '.repeat(60)} Unique token ZEBRA${i}.`));
    const path = conversationPath(node), start = performance.now();
    const tool = conversationSearchTool(node, path);
    const indexed = performance.now();
    const result = await tool.execute('ZEBRA217', new AbortController().signal);
    const searched = performance.now();
    conversationSearchTool(node, path);
    const reused = performance.now();
    console.info(`Chat recall 300 turns: index ${(indexed - start).toFixed(1)}ms, search ${(searched - indexed).toFixed(1)}ms, reuse ${(reused - searched).toFixed(1)}ms`);
    expect(result.text).toContain('ZEBRA217');
    expect(result.text.length).toBeLessThan(15_000);
  });
});
