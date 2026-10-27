import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBody } from './ChatBody';
import { appendChatAnswer, conversationPath, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { commitChatMemory } from '@/lib/chat/context';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';

beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
beforeEach(() => {
  useChatRuntimeStore.setState({ views: {} });
  useCitationPanelStore.getState().close();
  useGraphStore.getState().setProject(null);
  useGraphStore.getState().requestPanTo(null);
  useNodeTextSelectionStore.getState().clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});
afterEach(() => { vi.useRealTimers(); window.getSelection()?.removeAllRanges(); });

describe('chat body interaction', () => {
  it.each(['streaming', 'marking', 'previews', 'complete'] as const)(
    'keeps version controls working during %s and warns only after another reply starts', stage => {
      const ref = (versionCreatedAt: number) => ({ turnId: 'first', versionCreatedAt });
      let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
      node = appendChatAnswer(node, { turnId: 'first', createdAt: 2, question: 'Question' });
      node = updateChatAnswer(node, ref(2), { body: 'Original answer.' }, { state: 'complete' });
      node = appendChatAnswer(node, { turnId: 'first', createdAt: 3, question: 'Question', replaceLatest: true });
      node = updateChatAnswer(node, ref(3), { body: 'New answer.',
        ...(stage === 'marking' ? { answerTermMarking: { fingerprint: 'pending', state: 'pending' as const } } : {}),
      }, { state: stage === 'streaming' ? 'generating' : 'complete' });
      node = { ...node, generating: stage === 'streaming', streamingText: stage === 'streaming' };
      const project = { ...createBlankProject('Version navigation', node.id), nodes: { chat: node } };
      useGraphStore.setState({ project, activeProjectId: project.id });
      // Reproduce the temporary preview left behind by switching while writing.
      useChatRuntimeStore.getState().view('chat', { previews: { first: 2 } });
      function LiveChat() {
        const current = useGraphStore(state => state.project!.nodes.chat!);
        return <ChatBody node={current} selected={false} />;
      }
      const { container } = render(<LiveChat />);
      const warning = 'Alternative version — not used in later replies';
      expect(screen.queryByText(warning)).toBeNull();
      for (const versionCreatedAt of [3, 2, 3, 2]) {
        fireEvent.click(screen.getByRole('button', { name: versionCreatedAt === 3 ? 'Next answer' : 'Previous answer' }));
        expect(container.querySelector('[data-chat-turn="first"]')).toHaveAttribute('data-chat-version', `${versionCreatedAt}`);
        expect(useGraphStore.getState().project?.nodes.chat?.chat?.turns[0]?.selectedVersionCreatedAt).toBe(versionCreatedAt);
        expect(screen.queryByText(warning)).toBeNull();
      }
      act(() => {
        const current = useGraphStore.getState().project!.nodes.chat!;
        useGraphStore.getState().updateNode('chat', appendChatAnswer(current, { turnId: 'second', createdAt: 4, question: 'Continue' }));
      });
      fireEvent.click(screen.getByRole('button', { name: 'Next answer' }));
      expect(screen.getByText(warning)).toBeInTheDocument();
      const current = useGraphStore.getState().project!.nodes.chat!;
      expect(current.versions.at(-1)?.chat?.contextPath).toEqual([ref(2)]);
      expect(current.chat?.turns[0]?.selectedVersionCreatedAt).toBe(2);
      fireEvent.click(screen.getByRole('button', { name: 'Previous answer' }));
      expect(screen.queryByText(warning)).toBeNull();
    },
  );
  it('disables fact-check on unfocus without restoring it on refocus', () => {
    const node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    const project = createBlankProject('chat', node.id);
    useGraphStore.setState({ project: { ...project, nodes: { chat: node }, selection: ['chat'] } });
    useCitationPanelStore.getState().openFact('chat', 1);
    render(<ChatBody node={node} selected />);
    act(() => useGraphStore.getState().setSelection([]));
    expect(useCitationPanelStore.getState().mode).toBeNull();
    act(() => useGraphStore.getState().setSelection(['chat']));
    expect(useCitationPanelStore.getState().mode).toBeNull();
  });
  it.each(['native range', 'finished selection', 'no selection'] as const)('resolves delayed scroll focus correctly with %s', kind => {
    vi.useFakeTimers();
    let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    for (let i = 1; i <= 2; i++) {
      node = appendChatAnswer(node, { turnId: `t${i}`, createdAt: i + 1, question: `Question ${i}` });
      node = updateChatAnswer(node, { turnId: `t${i}`, versionCreatedAt: i + 1 }, { body: `Answer ${i}.` }, { state: 'complete' });
    }
    const project = createBlankProject('Selected answer', node.id);
    useGraphStore.setState({ project: { ...project, nodes: { chat: node }, selection: [node.id] } });
    const { container } = render(<div data-node-id="chat"><ChatBody node={node} selected /></div>);
    const region = screen.getByRole('region', { name: 'Conversation' });
    Object.defineProperties(region, { clientHeight: { value: 300 }, scrollHeight: { value: 900 } });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 600, 300));
    const turns = container.querySelectorAll<HTMLElement>('[data-chat-turn]');
    vi.spyOn(turns[0]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 110, 600, 120));
    vi.spyOn(turns[1]!, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 240, 600, 120));
    // The first answer is nearest the top, but the user selects the second.
    fireEvent.scroll(region);
    if (kind === 'native range') {
      const range = document.createRange(); range.selectNodeContents(turns[1]!.querySelector('.chat-markdown p')!);
      window.getSelection()!.addRange(range);
    } else if (kind === 'finished selection') {
      useNodeTextSelectionStore.getState().set({ nodeId: 'chat', versionIndex: 2,
        sourceBody: 'Answer 2.', text: 'Answer 2', start: 0, end: 8 });
    }
    act(() => vi.advanceTimersByTime(150));
    expect(useGraphStore.getState().project?.nodes.chat?.currentVersionIndex).toBe(kind === 'no selection' ? 1 : 2);
  });
  it.each(['conversation', 'fact-check', undefined, null] as const)(
    'does not restore %s panels or steal focus during multi-selection, but restores them when selected alone', (preference) => {
      let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
      for (let i = 1; i <= 2; i++) {
        node = appendChatAnswer(node, { turnId: `t${i}`, createdAt: i + 1, question: `Question ${i}` });
        node = updateChatAnswer(node, { turnId: `t${i}`, versionCreatedAt: i + 1 }, { body: `Answer ${i}.` }, { state: 'complete' });
      }
      const project = createBlankProject('multi-select chat', 'other');
      const other = { ...node, id: 'other' };
      useGraphStore.getState().setProject({ ...project, nodes: { chat: node, other }, selection: ['other', 'chat'] });
      useChatRuntimeStore.getState().view('chat', { rightPanelPreference: preference });
      render(<ChatBody node={node} selected />);
      expect(useGraphStore.getState().project?.selection).toEqual(['other', 'chat']);
      expect(useCitationPanelStore.getState().nodeId).toBeNull();
      act(() => useGraphStore.getState().setSelection(['chat']));
      expect(useCitationPanelStore.getState()).toMatchObject(preference === null
        ? { nodeId: null, mode: null } : { nodeId: 'chat', mode: preference ?? 'conversation' });
      // Restoring a panel during focus leaves movement to the focus/spawn
      // request. Otherwise it could bypass disabled automatic camera settings.
      expect(useGraphStore.getState().panTo).toBeNull();
    },
  );

  it('keeps the completed compaction notice at the point where it happened, even at the end', () => {
    let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    for (let i = 1; i <= 3; i++) {
      node = appendChatAnswer(node, { turnId: `t${i}`, createdAt: i + 1, question: `Question ${i}` });
      node = updateChatAnswer(node, { turnId: `t${i}`, versionCreatedAt: i + 1 }, { body: `Answer ${i}.` }, { state: 'complete' });
    }
    node = { ...node, generating: false };
    node = commitChatMemory(node, { id: 'memory', summary: 'Earlier context', createdAt: 10,
      coveredPath: conversationPath(node).slice(0, 1) });
    const { container, rerender } = render(<ChatBody node={node} selected={false} />);
    let notice = screen.getByText('Context compacted — earlier messages remain available');
    expect(container.querySelector('[data-chat-turn="t3"]')?.nextElementSibling).toBe(notice);
    expect(notice.closest('[data-chat-turn]')).toBeNull();
    // Persistence and a later answer must not move or remove the boundary.
    node = JSON.parse(JSON.stringify(node));
    node = appendChatAnswer(node, { turnId: 't4', createdAt: 11, question: 'Continue' });
    rerender(<ChatBody node={node} selected={false} />);
    notice = screen.getByText('Context compacted — earlier messages remain available');
    expect(notice.nextElementSibling).toHaveAttribute('data-chat-turn', 't4');
  });
  it('centers welcoming parent-aware copy for an empty chat', () => {
    const node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300, parentNodeId: 'parent' });
    render(<ChatBody node={node} selected={false} />);
    expect(screen.getByText('This chat can access the parent node’s contents, project sources, and files sent here.').closest('.chat-turns')).toHaveClass('is-empty');
  });
  it('does not imply a parent exists for a root chat', () => {
    const node = createChatNode({ id: 'root-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    render(<ChatBody node={node} selected={false} />);
    expect(screen.getByText('This chat can access project sources and files sent here.')).toBeInTheDocument();
    expect(screen.queryByText(/parent node/)).toBeNull();
  });
  it.each([false, true])('keeps scrolling inside a chat but passes pinch zoom to the canvas (selected=%s)', (selected) => {
    const zoom = vi.fn();
    const node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    render(<div onWheel={zoom}><ChatBody node={node} selected={selected} /></div>);
    const region = screen.getByRole('region', { name: 'Conversation' });
    fireEvent.wheel(region, { deltaY: 120 });
    expect(zoom).not.toHaveBeenCalled();
    fireEvent.wheel(region, { deltaY: 120, ctrlKey: true });
    fireEvent.wheel(region, { deltaY: -120, metaKey: true });
    expect(zoom).toHaveBeenCalledTimes(2);
  });
  it.each([0.5, 0.75, 1, 1.5])('never slows or cancels native wheel travel at canvas zoom %s', (zoom) => {
    useLiveViewportStore.setState({ zoom });
    let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 650 });
    node = appendChatAnswer(node, { turnId: 't1', createdAt: 2, question: 'First' });
    const { container } = render(<ChatBody node={node} selected={false} />);
    const region = screen.getByRole('region', { name: 'Conversation' });
    Object.defineProperties(region, { clientHeight: { value: 650 }, scrollHeight: { value: 2000 } });
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 500 * zoom, 650 * zoom));
    const turn = container.querySelector('[data-chat-turn]')!;
    vi.spyOn(turn, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 100 + (514 - region.scrollTop) * zoom, 500 * zoom, 400 * zoom));
    region.scrollTop = 25;
    expect(fireEvent.wheel(region, { deltaY: 450, cancelable: true })).toBe(true);
    // Simulate the native 450px movement, then cross the 500px boundary.
    region.scrollTop = 475;
    expect(fireEvent.wheel(region, { deltaY: 450, cancelable: true })).toBe(true);
    expect(fireEvent.wheel(region, { deltaY: -1800, cancelable: true })).toBe(true);
    expect(region.scrollTop).toBe(475);
  });
});
