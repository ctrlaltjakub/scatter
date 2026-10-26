import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatOutlinePanel } from './ChatOutlinePanel';
import { activateChatAnswer } from '@/lib/chat/actions';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';

vi.mock('@/lib/chat/actions', () => ({ activateChatAnswer: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  node = appendChatAnswer(node, { turnId: 'turn', createdAt: 2, question: 'The original user question, not its summary' });
  node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: 2 }, { body: 'Answer' }, { state: 'complete', title: 'Old AI summary' });
  node = appendChatAnswer(node, { turnId: 'turn', createdAt: 3, question: 'An edited question', replaceLatest: true });
  const project = createBlankProject('History', 'chat');
  useGraphStore.setState({ project: { ...project, nodes: { chat: node }, selection: ['chat'] } });
  useCitationPanelStore.setState({ nodeId: 'chat', mode: 'conversation' });
  useChatRuntimeStore.setState({ views: {} });
  useChatRuntimeStore.getState().view('chat', { active: { turnId: 'turn', versionCreatedAt: 2 }, previews: { turn: 2 } });
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it('shows the displayed alternative’s question and jumps to that exact turn', () => {
  render(<ChatOutlinePanel />);
  expect(screen.getByText('Chat history')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Close chat history' })).toBeVisible();
  expect(screen.queryByText('Old AI summary')).toBeNull();
  const entry = screen.getByRole('button', { name: /^The original user question, not its summary/ });
  expect(entry).toHaveAttribute('aria-current', 'true');
  expect(entry.querySelector('time')).toHaveAttribute('datetime', new Date(2).toISOString());
  expect(entry.querySelector('time')).toHaveTextContent(new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(2));
  fireEvent.click(entry);
  expect(activateChatAnswer).toHaveBeenCalledWith('chat', { turnId: 'turn', versionCreatedAt: 2 });
  expect(useChatRuntimeStore.getState().views.chat?.jump.turnId).toBe('turn');
});

it('timestamps every entry and follows the question alternative being displayed', () => {
  const project = useGraphStore.getState().project!;
  const node = appendChatAnswer(project.nodes.chat!, { turnId: 'next', createdAt: 4, question: 'Another question' });
  useGraphStore.setState({ project: { ...project, nodes: { chat: node } } });
  const { container } = render(<ChatOutlinePanel />);
  expect([...container.querySelectorAll('time')].map((time) => time.dateTime))
    .toEqual([new Date(2).toISOString(), new Date(4).toISOString()]);
  act(() => useChatRuntimeStore.getState().view('chat', { previews: { turn: 3 } }));
  const edited = screen.getByRole('button', { name: /^An edited question/ });
  expect(edited.querySelector('time')).toHaveAttribute('datetime', new Date(3).toISOString());
});
