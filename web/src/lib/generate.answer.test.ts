import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { appendChatAnswer, createChatNode, updateChatAnswer } from './chat/model';
import { modifyNode, generateTextVersionFromHeader, saveManualEdit, redoTermMarking } from './generate';
import { resetGenerationSessionsForTests } from './generationSession';
import { versionSupportsWikimedia } from './wikimediaDiscovery';
import type { ScatterNode } from '@/store/types';

const fake = vi.hoisted(() => ({ prompts: [] as string[], marked: [] as string[], images: [] as number[], body: '' }));
const BODY = 'A **memory** fact. ⟦1⟧\n\n## Comparison\n\n| Kind | Limit |\n|---|---|\n| Working | Small |\n\nA final paragraph.';
// Preview enrichment has its own lifecycle/request tests; this suite counts
// the primary answer requests to detect accidental encyclopedia restructuring.
vi.mock('./termPreviews', () => ({ generateTermPreviews: vi.fn(async () => {}) }));
vi.mock('@/providers/registry', async (original) => ({ ...await original<typeof import('@/providers/registry')>(),
  getAdapter: () => ({ capabilities: {}, async *streamChat(_key: string, opts: { messages: { content: string }[] }) {
    fake.prompts.push(opts.messages.map((m) => m.content).join('\n'));
    yield { delta: fake.body, done: false }; yield { delta: '', done: true };
  } }),
}));
vi.mock('./chat/termMarking', () => ({ markChatTerms: async (body: string) => {
  fake.marked.push(body); return { body: body.replace('**memory**', '**[[memory]]**'), failed: 0 };
} }));
vi.mock('./wikimediaDiscovery', async (original) => ({ ...await original<typeof import('./wikimediaDiscovery')>(),
  startWikimediaDiscovery: async (_id: string, createdAt: number) => { fake.images.push(createdAt); },
}));
function setup(chunked: boolean) {
  let chat = createChatNode({ id: 'origin', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  chat = appendChatAnswer(chat, { turnId: 't', createdAt: 2, question: 'Memory', metadata: { informationChunking: chunked } });
  chat = updateChatAnswer(chat, { turnId: 't', versionCreatedAt: 2 }, { body: BODY,
    sources: [{ n: 1, url: 'https://example.com', title: 'Evidence' }] }, { state: 'complete' });
  const node: ScatterNode = { id: 'answer', type: 'follow-up', position: { x: 10, y: 20 }, frozen: false, currentVersionIndex: 0,
    versions: [{ ...chat.versions[1]!, header: 'Memory', contentType: 'answer', width: 610, bodyMaxHeight: 320 }] };
  const project = { ...createBlankProject('Answers', node.id), nodes: { [node.id]: node } };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  return node;
}
beforeEach(() => {
  fake.prompts = []; fake.marked = []; fake.images = []; fake.body = BODY;
  resetGenerationSessionsForTests();
  useRewriteStore.setState({ activeByNode: {}, workingBody: {}, snapshot: {}, pendingSnapDown: {} });
  useSettingsStore.setState({ providers: [{ id: 'p', preset: 'openrouter', apiKey: 'test', enabledModels: ['m'] }],
    activeModelRef: { providerId: 'p', model: 'm' }, webSearch: false, normalChatInstructions: '', generationLanguage: 'en' });
});
afterEach(() => { resetGenerationSessionsForTests(); });

describe('standalone answer versions', () => {
  it('preserves source language for edits but uses the selector for full regeneration', async () => {
    const node = setup(false);
    useGraphStore.getState().updateNode(node.id, { versions: [{ ...node.versions[0]!, language: 'ja' }] });
    useSettingsStore.setState({ generationLanguage: 'pl' });
    await modifyNode(node.id, 'Clarify');
    expect(fake.prompts[0]).toContain('Japanese (ja-JP)');
    expect(useGraphStore.getState().project!.nodes.answer!.versions.at(-1)?.language).toBe('ja');
    await generateTextVersionFromHeader(node.id, { subject: 'New topic' });
    expect(fake.prompts.at(-1)).toContain('Polish (pl-PL)');
    expect(useGraphStore.getState().project!.nodes.answer!.versions.at(-1)?.language).toBe('pl');
  });
  it('keeps embedded images through AI editing without sending their bytes as text', async () => {
    const node = setup(false);
    const image = 'data:image/gif;base64,' + 'abcd'.repeat(1000);
    const original = { ...node.versions[0]!, markdownNote: true, body: `Original text. ![Figure](${image})` };
    useGraphStore.getState().updateNode(node.id, { versions: [original] });
    fake.body = 'Revised text. ![Figure](app-embedded-image://image-1)';
    await modifyNode(node.id, 'Clarify the text and keep the figure');
    expect(fake.prompts[0]).not.toContain('base64');
    const edited = useGraphStore.getState().project!.nodes.answer!.versions.at(-1)!;
    expect(edited.body).toBe(`Revised text. ![Figure](${image})`);
    expect(edited.markdownNote).toBe(true);
  });
  it.each([true, false])('modifies rich Markdown, retaining the render mode and one undo step (chunked=%s)', async (chunked) => {
    const original = setup(chunked);
    await modifyNode(original.id, 'Clarify the comparison');
    const node = useGraphStore.getState().project!.nodes.answer!;
    const version = node.versions[node.currentVersionIndex]!;
    expect(node.versions).toHaveLength(2);
    expect(version).toMatchObject({ contentType: 'answer', width: 610, bodyMaxHeight: 320, chat: { informationChunking: chunked } });
    expect(version.body).toContain('| Kind | Limit |');
    expect(version.body).toContain('**[[memory]]**');
    expect(version.sources).toHaveLength(1);
    expect(fake.prompts[0]).toContain('Clarify the comparison');
    expect(fake.prompts[0]).toContain('Do not force a two-level encyclopedic outline');
    expect(fake.prompts[0]?.includes('Information chunking is ON')).toBe(chunked);
    expect(fake.marked).toHaveLength(1);
    expect(fake.images).toEqual([version.createdAt]);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes.answer?.versions).toEqual(original.versions);
  });
  it('regenerates from the header without an encyclopedic restructure pass', async () => {
    setup(false);
    await generateTextVersionFromHeader('answer', { subject: 'New topic' });
    const node = useGraphStore.getState().project!.nodes.answer!;
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toContain('New topic');
    expect(node.versions[node.currentVersionIndex]).toMatchObject({ header: 'New topic', contentType: 'answer', chat: { informationChunking: false } });
  });
  it('manual edits retain dimensions, citations and answer rendering without retaining stale fact checks', () => {
    setup(true); saveManualEdit('answer', 'Edited title', BODY);
    const version = useGraphStore.getState().project!.nodes.answer!.versions[1]!;
    expect(version).toMatchObject({ width: 610, bodyMaxHeight: 320, contentType: 'answer', chat: { informationChunking: true } });
    expect(version.sources).toHaveLength(1);
    expect(version.factCheck).toBeUndefined();
    expect(versionSupportsWikimedia(version)).toBe(true);
    expect(versionSupportsWikimedia({ ...version, contentType: 'chat' })).toBe(false);
  });
  it('redo terms creates an independent version using the rich Markdown marker', async () => {
    const original = setup(true); await redoTermMarking('answer');
    const node = useGraphStore.getState().project!.nodes.answer!;
    expect(node.versions).toHaveLength(2);
    expect(node.versions[0]).toEqual(original.versions[0]);
    expect(node.versions[1]?.body).toContain('**[[memory]]**');
    expect(node.versions[1]?.chat?.informationChunking).toBe(true);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });
});
