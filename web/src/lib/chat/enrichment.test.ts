import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secondaryTaskCompletion } from '@/lib/secondaryTaskCompletion';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { appendChatAnswer, createChatNode, updateChatAnswer } from './model';
import { enrichChatAnswer, redoChatTerms } from './enrichment';
import { generateTermPreviews } from '../termPreviews';
import { nodeArrowLabelHeader } from '../asciiAura/arrowLabels';

vi.mock('@/lib/secondaryTaskCompletion', () => ({ secondaryTaskCompletion: vi.fn() }));
vi.mock('../termPreviews', () => ({ generateTermPreviews: vi.fn(async () => {}) }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(secondaryTaskCompletion).mockImplementation(async (options) => options.system.includes('short topical title')
    ? '{"chatTitle":"Memory systems"}' : '{"terms":[]}');
});

describe('chat history no longer needs AI turn summaries', () => {
  it('can re-mark a standalone answer without adding conversation state or changing its title', async () => {
    let node = createChatNode({ id: 'answer', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    node = appendChatAnswer(node, { turnId: 't', createdAt: 2, question: 'Memory?' });
    node = updateChatAnswer(node, { turnId: 't', versionCreatedAt: 2 }, { body: '**Working memory** matters.', header: 'My saved answer' }, { state: 'complete' });
    node = { ...node, chat: undefined, type: 'follow-up', currentVersionIndex: 0, generating: false,
      versions: [{ ...node.versions[1]!, contentType: 'answer' }] };
    const project = { ...createBlankProject('Answer enrichment', node.id), nodes: { [node.id]: node } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    vi.mocked(secondaryTaskCompletion).mockImplementation(async () => '{"terms":["Working memory"]}');
    await redoChatTerms(node.id, { turnId: 't', versionCreatedAt: 2 });
    const changed = useGraphStore.getState().project!.nodes[node.id]!;
    expect(changed.chat).toBeUndefined();
    expect(changed.versions).toHaveLength(1);
    expect(changed.versions[0]).toMatchObject({ body: '**[[Working memory]]** matters.', header: 'My saved answer', contentType: 'answer' });
    expect(secondaryTaskCompletion).toHaveBeenCalledTimes(1);
    expect(generateTermPreviews).toHaveBeenCalledWith(node.id, 2, true);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes[node.id]?.versions[0]?.body).toBe('**Working memory** matters.');
  });
  it('records manual re-marking as one undoable action without creating another answer', async () => {
    let node = createChatNode({ id: 'manual-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    node = appendChatAnswer(node, { turnId: 't', createdAt: 2, question: 'Memory?' });
    node = updateChatAnswer(node, { turnId: 't', versionCreatedAt: 2 }, { body: '**Working memory** matters.' }, { state: 'complete' });
    node = { ...node, generating: false, generatingVersionIndex: undefined, streamingText: false };
    const project = { ...createBlankProject('Manual enrichment', node.id), nodes: { [node.id]: node } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    vi.mocked(secondaryTaskCompletion).mockImplementation(async () => '{"terms":["Working memory"]}');
    await redoChatTerms(node.id, { turnId: 't', versionCreatedAt: 2 });
    expect(useGraphStore.getState().project?.nodes[node.id]?.versions).toHaveLength(2);
    expect(useGraphStore.getState().project?.nodes[node.id]?.versions[1]?.body).toBe('**[[Working memory]]** matters.');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes[node.id]?.versions[1]?.body).toBe('**Working memory** matters.');
  });
  it('does not apply late marking to an answer that changed while the request ran', async () => {
    let node = createChatNode({ id: 'stale-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    node = appendChatAnswer(node, { turnId: 't', createdAt: 2, question: 'Memory?' });
    node = updateChatAnswer(node, { turnId: 't', versionCreatedAt: 2 }, { body: 'Working memory matters.' }, { state: 'complete' });
    const project = { ...createBlankProject('Stale enrichment', node.id), nodes: { [node.id]: node } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    vi.mocked(secondaryTaskCompletion).mockImplementation(async () => {
      useGraphStore.getState().updateNode(node.id, updateChatAnswer(node, { turnId: 't', versionCreatedAt: 2 }, { body: 'Edited answer.' }));
      return '{"terms":["Working memory"]}';
    });
    await redoChatTerms(node.id, { turnId: 't', versionCreatedAt: 2 });
    expect(useGraphStore.getState().project?.nodes[node.id]?.versions[1]?.body).toBe('Edited answer.');
  });
  it.each([1, 2])('only enriches terms after turn %s (plus the initial node title)', async (count) => {
    let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    for (let i = 1; i <= count; i++) {
      node = appendChatAnswer(node, { turnId: `t${i}`, createdAt: i + 1, question: `Question ${i}` });
      node = updateChatAnswer(node, { turnId: `t${i}`, versionCreatedAt: i + 1 }, { body: '**Working memory** has **limited capacity**.' }, { state: 'complete' });
    }
    const project = { ...createBlankProject('Enrichment', 'chat'), nodes: { chat: node } };
    useGraphStore.setState({ project, activeProjectId: project.id });
    expect(nodeArrowLabelHeader(node)).toBe('Question 1');
    await enrichChatAnswer(project.id, 'chat', { turnId: `t${count}`, versionCreatedAt: count + 1 }, new AbortController().signal);
    expect(secondaryTaskCompletion).toHaveBeenCalledTimes(count === 1 ? 2 : 1);
    const prompts = vi.mocked(secondaryTaskCompletion).mock.calls.map(([options]) => options.system).join('\n');
    expect(prompts).not.toContain('outlineParentTurnId');
    expect(prompts).not.toContain('turnTitle');
    if (count === 1) expect(useGraphStore.getState().project?.nodes.chat?.chat?.title).toBe('Memory systems');
    expect(nodeArrowLabelHeader(useGraphStore.getState().project?.nodes.chat))
      .toBe(count === 1 ? 'Memory systems' : 'Question 1');
  });
});
