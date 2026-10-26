import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatNode, appendChatAnswer, updateChatAnswer } from './chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useReadingStore } from '@/store/useReadingStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { handleReadingArrow, exitReading } from './readingController';
import { buildLineModel, readingRects, type SectionModel } from './readingDom';

vi.mock('./readingDom', async (original) => ({ ...await original<object>(), buildLineModel: vi.fn(), readingRects: vi.fn(), paintReading: vi.fn() }));
vi.mock('./chat/actions', () => ({ activateChatAnswer: vi.fn() }));

let scroll: HTMLDivElement;
beforeEach(() => {
  useReadingStore.getState().reset();
  useLiveViewportStore.setState({ zoom: 1 });
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  node = appendChatAnswer(node, { turnId: 't1', createdAt: 2, question: 'Question' });
  node = { ...updateChatAnswer(node, { turnId: 't1', versionCreatedAt: 2 }, { body: 'Answer' }, { state: 'complete' }), generating: false };
  const project = createBlankProject('Chat', 'chat');
  useGraphStore.setState({ project: { ...project, nodes: { chat: node }, selection: ['chat'] } });
  const card = document.createElement('div'); card.dataset.nodeId = 'chat'; card.className = 'chat-node';
  scroll = document.createElement('div'); scroll.dataset.chatScroll = 'chat';
  const answer = document.createElement('div'); answer.className = 'chat-assistant'; answer.dataset.chatAnswer = 't1'; answer.dataset.chatAnswerCreatedAt = '2';
  const markdown = document.createElement('div'); markdown.className = 'chat-markdown';
  const text = document.createTextNode('x'.repeat(100)); markdown.append(text); answer.append(markdown); scroll.append(answer); card.append(scroll); document.body.append(card);
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 400, 120));
  vi.spyOn(markdown, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 80 - scroll.scrollTop, 400, 400));
  const lines = Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, firstClusterIdx: i, lastClusterIdx: i }));
  const model: SectionModel = { text: text.data, spans: [{ node: text, start: 0, end: 100 }],
    clusters: lines.map(({ start, end }) => ({ start, end })), lines,
    shape: { lineCount: 20, clusterCount: 20, firstClusterOnLine: lines.map((l) => l.firstClusterIdx),
      lastClusterOnLine: lines.map((l) => l.lastClusterIdx), clusterHomeLine: lines.map((_, i) => i) } };
  vi.mocked(buildLineModel).mockReturnValue(model);
  vi.mocked(readingRects).mockImplementation((_model, start) => [new DOMRect(20, 80 + start * 20 - scroll.scrollTop, 200, 16)]);
});
afterEach(() => { exitReading(); document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('chat ruler viewport navigation', () => {
  it('starts after the faded edge and keeps the ruler in fully visible text', () => {
    scroll.dataset.readingInsetTop = '26';
    scroll.dataset.readingInsetBottom = '26';
    handleReadingArrow('ArrowDown', 'chat');
    expect(useReadingStore.getState().lineIdx).toBe(3);
    const before = scroll.scrollTop;
    handleReadingArrow('ArrowUp', 'chat');
    expect(scroll.scrollTop).toBeLessThan(before);
  });
  it('starts at the first visible line, not the beginning of the answer', () => {
    handleReadingArrow('ArrowDown', 'chat');
    expect(useReadingStore.getState().lineIdx).toBe(1);
  });
  it('uses the same scroll-aware ruler for a standalone answer without conversation state', () => {
    const node = useGraphStore.getState().project!.nodes.chat!;
    useGraphStore.getState().updateNode(node.id, { chat: undefined, type: 'follow-up', currentVersionIndex: 0,
      versions: [{ ...node.versions[1]!, contentType: 'answer' }] });
    scroll.scrollTop = 80;
    handleReadingArrow('ArrowDown', 'chat');
    expect(useReadingStore.getState().lineIdx).toBe(5);
    const before = scroll.scrollTop;
    handleReadingArrow('ArrowUp', 'chat');
    expect(useReadingStore.getState().lineIdx).toBe(4);
    expect(scroll.scrollTop).toBeLessThan(before);
  });
  it('restarts at the visible top after manual scrolling hides the highlighted line', () => {
    handleReadingArrow('ArrowDown', 'chat');
    scroll.scrollTop = 80;
    handleReadingArrow('ArrowRight', 'chat');
    expect(useReadingStore.getState()).toMatchObject({ lineIdx: 5, clusterIdx: 5 });
  });
  it('scrolls upward to follow keyboard navigation rather than resetting the ruler', () => {
    scroll.scrollTop = 80;
    handleReadingArrow('ArrowDown', 'chat');
    const before = scroll.scrollTop;
    handleReadingArrow('ArrowUp', 'chat');
    expect(useReadingStore.getState().lineIdx).toBe(4);
    expect(scroll.scrollTop).toBeLessThan(before);
  });
});
