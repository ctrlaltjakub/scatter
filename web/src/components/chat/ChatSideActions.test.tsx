import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSideActions } from './ChatSideActions';
import { AppTooltips } from '@/components/AppTooltips';
import { appendChatAnswer, conversationPath, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { commitChatMemory } from '@/lib/chat/context';
import { useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import type { Project, ScatterNode } from '@/store/types';

vi.mock('@/lib/chat/actions', () => ({
  askAboutChatAnswer: vi.fn(), compactChat: vi.fn(), deleteLastChatTurn: vi.fn(),
  editLastChatQuestion: vi.fn(), forkChat: vi.fn(), reverseChatCompaction: vi.fn(), submitChat: vi.fn(), stopChat: vi.fn(),
}));
vi.mock('@/lib/factCheck', () => ({
  factCheckAvailability: () => ({ available: false }), startFactCheck: vi.fn(), stopFactCheck: vi.fn(),
}));
vi.mock('@/lib/chat/export', () => ({ exportChat: vi.fn() }));

function conversation(turns: number): ScatterNode {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  for (let i = 0; i < turns; i++) {
    const ref = { turnId: `turn-${i}`, versionCreatedAt: i + 2 };
    node = appendChatAnswer(node, { turnId: ref.turnId, createdAt: ref.versionCreatedAt, question: `Question ${i}` });
    node = updateChatAnswer(node, ref, { body: `Answer ${i}` }, { state: 'complete' });
  }
  return { ...node, generating: false };
}

function renderActions(node: ScatterNode) {
  const project: Project = {
    id: 'tooltip-test', name: 'Tooltip test', createdAt: 1, updatedAt: 1,
    rootNodeId: node.id, selection: [node.id], viewport: { x: 0, y: 0, zoom: 1 },
    nodes: { [node.id]: node }, groups: {}, arrows: {},
  };
  useGraphStore.setState({ project });
  return render(<><ChatSideActions node={node} /><AppTooltips /></>);
}

beforeEach(() => {
  useChatRuntimeStore.setState({ views: {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('chat compaction tooltips', () => {
  it('labels the top row before the delete action', () => {
    renderActions(conversation(3));
    const label = screen.getByText('Chat node');
    const row = label.closest('.chat-utility-row');
    expect(row).not.toBeNull();
    expect(row?.firstElementChild).toBe(label);
    expect(row).toContainElement(screen.getByRole('button', { name: 'Delete chat node' }));
  });
  it('calls the history action chat history when opening and closing it', () => {
    useCitationPanelStore.getState().close();
    renderActions(conversation(3));
    fireEvent.click(screen.getByRole('button', { name: 'Show chat history' }));
    expect(useCitationPanelStore.getState().mode).toBe('conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Hide chat history' }));
    expect(screen.getByRole('button', { name: 'Show chat history' })).toBeVisible();
  });
  it('puts disclosures above individual actions, and compaction last', () => {
    const { container } = renderActions(conversation(3));
    const buttons = [...container.querySelectorAll('.chat-side-actions button')];
    expect(buttons.slice(0, 5).map((button) => button.getAttribute('aria-label') || button.textContent))
      .toEqual(['Delete chat node', 'Add node', 'Edit header', 'Group', 'Information chunking: On New and regenerated answers']);
    expect(buttons.at(-1)?.textContent).toBe('Compact conversation');
    expect(screen.getByRole('button', { name: 'Edit header' })).toHaveClass('side-action');
    fireEvent.click(screen.getByRole('button', { name: 'Edit header' }));
    expect(useChatRuntimeStore.getState().views.chat?.titleEditNonce).toBe(1);
  });
  it('keeps only conversation-wide actions in the side panel', () => {
    const node = conversation(3);
    renderActions(node);
    expect(screen.getByRole('button', { name: /Information chunking: On/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Information chunking: On/ })).toHaveAttribute('data-state-in-label');
    expect(screen.getByRole('button', { name: /Information chunking: On/ })).toHaveAttribute('data-tip', expect.stringContaining('one idea per sentence'));
    expect(screen.getByRole('button', { name: /chat history/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Export|Fork|Fact-check|Regenerate|Edit last|Delete last/ })).not.toBeInTheDocument();
    expect(document.querySelector('.chat-action-target')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Information chunking: On/ }));
    expect(useGraphStore.getState().project?.nodes.chat?.chat?.informationChunking).toBe(false);
    expect(node.versions.filter((version) => version.chat).every((version) => version.chat!.informationChunking)).toBe(true);
  });
  it.each([0, 1, 2])('explains the minimum for %s turns even while the button is disabled', async (turns) => {
    renderActions(conversation(turns));
    const button = screen.getByRole('button', { name: 'Compact conversation' });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button);
    expect(await screen.findByText('Needs at least 3 turns. The latest 2 are kept in full.')).toBeVisible();
    expect(button).toHaveAttribute('aria-description', button.getAttribute('data-tip'));
  });

  it('explains what compaction preserves once a third turn is available', async () => {
    renderActions(conversation(3));
    const button = screen.getByRole('button', { name: 'Compact conversation' });
    expect(button).toBeEnabled();
    fireEvent.mouseOver(button);
    expect(await screen.findByText('Summarize older turns; keep the latest 2 in full. Messages stay visible.')).toBeVisible();
  });

  it('explains that an answer is still generating, ahead of the turn-count reason', async () => {
    renderActions({ ...conversation(1), generating: true });
    const button = screen.getByRole('button', { name: 'Compact conversation' });
    expect(button).toBeDisabled();
    fireEvent.mouseOver(button);
    expect(await screen.findByText('Wait for the current answer to finish, or stop it first.')).toBeVisible();
  });

  it('updates the hovered tooltip when compaction starts and finishes', async () => {
    renderActions(conversation(3));
    const button = screen.getByRole('button', { name: 'Compact conversation' });
    fireEvent.mouseOver(button);
    act(() => useChatRuntimeStore.getState().view('chat', { compacting: true }));
    expect(button).toBeDisabled();
    await waitFor(() => expect(screen.getByText('Compaction is already running. Wait or stop it first.')).toBeVisible());
    act(() => useChatRuntimeStore.getState().view('chat', { compacting: false }));
    expect(button).toBeEnabled();
    await waitFor(() => expect(screen.getByText('Summarize older turns; keep the latest 2 in full. Messages stay visible.')).toBeVisible());
  });

  it('explains undoing an unused compaction without changing the conversation', async () => {
    const node = conversation(3);
    renderActions(commitChatMemory(node, {
      id: 'memory', summary: 'Earlier conversation', createdAt: 10, coveredPath: conversationPath(node).slice(0, 1),
    }));
    const button = screen.getByRole('button', { name: 'Undo compaction' });
    expect(button).toBeEnabled();
    fireEvent.mouseOver(button);
    expect(await screen.findByText('Restore the previous context. Your messages stay unchanged.')).toBeVisible();
  });
});
