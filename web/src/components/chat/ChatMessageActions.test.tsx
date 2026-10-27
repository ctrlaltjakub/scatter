import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatAssistantActions, ChatUserActions } from './ChatMessageActions';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { activateChatAnswer, askAboutChatAnswer, deleteChatAnswer, deleteLastChatTurn, editLastChatQuestion, forkChat, spawnChatAnswer, submitChat } from '@/lib/chat/actions';
import { startFactCheck } from '@/lib/factCheck';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

vi.mock('@/lib/chat/actions', () => ({ activateChatAnswer: vi.fn(), askAboutChatAnswer: vi.fn(),
  deleteChatAnswer: vi.fn(), deleteLastChatTurn: vi.fn(), editLastChatQuestion: vi.fn(), forkChat: vi.fn(() => 'forked-chat'), spawnChatAnswer: vi.fn(), submitChat: vi.fn() }));
vi.mock('@/lib/factCheck', () => ({ factCheckAvailability: () => ({ available: true }),
  startFactCheck: vi.fn(async () => {}), stopFactCheck: vi.fn() }));

const answerProps = { turnId: 'turn', versionCreatedAt: 2, answerCount: 1 };

function version() {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  node = appendChatAnswer(node, { turnId: 'turn', createdAt: 2, question: 'Original question' });
  node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: 2 }, { body: '**[[Working memory]]** has limits. ⟦1⟧' }, { state: 'complete' });
  return node.versions.at(-1)!;
}

function checkedVersion(createdAt = 2) {
  const answer = { ...version(), createdAt };
  answer.factCheck = { complete: { schemaVersion: 1, bodyFingerprint: 'body', versionCreatedAt: createdAt,
    providerId: 'test', model: 'test', startedAt: 1, completedAt: 2, complete: true, failedUnitIds: [], units: [] } };
  return answer;
}

beforeEach(() => {
  vi.clearAllMocks();
  useCitationPanelStore.setState({ nodeId: null, mode: 'conversation', factVersionCreatedAt: null });
  useFactCheckTaskStore.setState({ tasks: {} });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});

describe('chat message actions', () => {
  it('only shows editing actions below the latest question', () => {
    const view = render(<ChatUserActions {...answerProps} nodeId="chat" question="Question" latest={false} busy={false} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Copy text']);
    view.rerender(<ChatUserActions {...answerProps} nodeId="chat" question="Question" latest busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete turn' }));
    expect(editLastChatQuestion).toHaveBeenCalledWith('chat');
    expect(submitChat).toHaveBeenCalledWith('chat', { regenerate: true });
    expect(deleteLastChatTurn).toHaveBeenCalledWith('chat');
  });
  it('deletes the displayed alternative and returns to Delete turn when one answer remains', () => {
    const displayed = { turnId: 'turn', versionCreatedAt: 3 };
    const view = render(<ChatUserActions nodeId="chat" question="Edited question" {...displayed} answerCount={3} latest busy={false} />);
    expect(screen.queryByRole('button', { name: 'Delete turn' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete answer' }));
    expect(deleteChatAnswer).toHaveBeenCalledWith('chat', displayed);
    expect(deleteLastChatTurn).not.toHaveBeenCalled();
    view.rerender(<ChatUserActions {...answerProps} nodeId="chat" question="Question" latest busy={false} />);
    expect(screen.queryByRole('button', { name: 'Delete answer' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete turn' }));
    expect(deleteLastChatTurn).toHaveBeenCalledWith('chat');
  });
  it('disables answer deletion while generating or compacting', () => {
    render(<ChatUserActions {...answerProps} nodeId="chat" question="Question" answerCount={2} latest busy />);
    expect(screen.getByRole('button', { name: 'Delete answer' })).toBeDisabled();
  });
  it('copies a question verbatim', async () => {
    render(<ChatUserActions {...answerProps} nodeId="chat" question={'Original\nquestion'} latest={false} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Original\nquestion');
  });
  it('copies answer Markdown without internal term markers', async () => {
    render(<ChatAssistantActions nodeId="chat" version={version()} latest={false} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('**Working memory** has limits. ⟦1⟧');
  });
  it('targets the owning answer for fork, follow-up and fact checking', () => {
    render(<ChatAssistantActions nodeId="chat" version={version()} latest={false} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy to node' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask about' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fact-check' }));
    const ref = { turnId: 'turn', versionCreatedAt: 2 };
    expect(forkChat).toHaveBeenCalledWith('chat', ref);
    expect(spawnChatAnswer).toHaveBeenCalledWith('chat', ref);
    expect(askAboutChatAnswer).toHaveBeenCalledWith('chat', ref);
    expect(activateChatAnswer).toHaveBeenCalledWith('chat', ref);
    expect(startFactCheck).toHaveBeenCalledWith('chat', 'new');
    expect(vi.mocked(activateChatAnswer).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startFactCheck).mock.invocationCallOrder[0]!);
  });
  it('keeps Copy available while edits and generation actions are blocked', () => {
    render(<ChatUserActions {...answerProps} nodeId="chat" question="Question" latest busy />);
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeEnabled();
    for (const name of ['Edit', 'Regenerate', 'Delete turn']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });
  it.each([true, false])('only offers resume when pending units match authored boundaries (current=%s)', current => {
    const answer = checkedVersion();
    answer.factCheck = { pending: { ...answer.factCheck!.complete!, complete: false,
      bodyFingerprint: current ? factCheckBodyFingerprint(answer) : 'old-punctuation-boundaries' } };
    render(<ChatAssistantActions nodeId="chat" version={answer} latest busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show fact-check' }));
    expect(startFactCheck).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: current ? 'Continue check' : 'Check again' });
    fireEvent.click(button);
    expect(startFactCheck).toHaveBeenCalledWith('chat', current ? 'continue' : 'again');
  });
  it('reports clipboard failure without an unhandled rejection', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Denied'));
    render(<ChatUserActions {...answerProps} nodeId="chat" question="Question" latest={false} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toHaveAttribute('data-tip', expect.stringContaining('manually'));
  });
  it.each([true, false])('rewrites the exact checked answer (latest=%s), forking older turns first', (latest) => {
    const answer = version();
    answer.factCheck = { complete: { schemaVersion: 1, bodyFingerprint: 'body', versionCreatedAt: 2,
      providerId: 'test', model: 'test', startedAt: 1, completedAt: 2, complete: true, failedUnitIds: [], units: [] } };
    render(<ChatAssistantActions nodeId="chat" version={answer} latest={latest} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show fact-check' }));
    expect(useCitationPanelStore.getState()).toMatchObject({ nodeId: 'chat', mode: 'fact-check', factVersionCreatedAt: 2 });
    fireEvent.click(screen.getByRole('button', { name: latest ? 'Rewrite with evidence' : 'Fork and rewrite with evidence' }));
    expect(submitChat).toHaveBeenCalledWith(latest ? 'chat' : 'forked-chat', { regenerate: true, evidence: answer.factCheck.complete });
    if (!latest) expect(forkChat).toHaveBeenCalledWith('chat', { turnId: 'turn', versionCreatedAt: 2 });
  });
  it('keeps fact-check pressed only while its answer panel is open, including external panel changes', () => {
    render(<ChatAssistantActions nodeId="chat" version={checkedVersion()} latest busy={false} />);
    const button = screen.getByRole('button', { name: 'Show fact-check' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(button).toHaveAccessibleName('Hide fact-check');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    act(() => useCitationPanelStore.getState().openFact('chat', 2));
    expect(button).toHaveAttribute('aria-pressed', 'true');
    act(() => useCitationPanelStore.getState().openConversation('chat'));
    expect(button).toHaveAttribute('aria-pressed', 'false');
    act(() => useCitationPanelStore.getState().openFact('chat', 2));
    act(() => useCitationPanelStore.getState().close());
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
  it('keeps fact-check last and shows its extra actions only while this answer is reviewed', () => {
    render(<ChatAssistantActions nodeId="chat" version={checkedVersion()} latest busy={false} />);
    const buttons = within(screen.getByRole('group', { name: 'Answer actions' })).getAllByRole('button');
    const button = buttons.at(-1)!;
    expect(button).toHaveAccessibleName('Show fact-check');
    expect(screen.queryByRole('group', { name: 'Fact-check actions' })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    act(() => useCitationPanelStore.getState().close('navigation'));
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Fact-check actions' })).not.toBeInTheDocument();
    act(() => useCitationPanelStore.getState().openFact('chat', 2));
    expect(screen.getByRole('button', { name: 'Rewrite with evidence' })).toBeVisible();
    act(() => useCitationPanelStore.getState().openFact('chat', 3));
    expect(screen.queryByRole('group', { name: 'Fact-check actions' })).not.toBeInTheDocument();
  });
  it('highlights only the answer whose fact-check is being shown', () => {
    render(<>
      <ChatAssistantActions nodeId="chat" version={checkedVersion()} latest={false} busy={false} />
      <ChatAssistantActions nodeId="chat" version={checkedVersion(3)} latest busy={false} />
    </>);
    const groups = screen.getAllByRole('group', { name: 'Answer actions' });
    const first = within(groups[0]!).getByRole('button', { name: 'Show fact-check' });
    const second = within(groups[1]!).getByRole('button', { name: 'Show fact-check' });
    fireEvent.click(first);
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(second);
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(second).toHaveAttribute('aria-pressed', 'true');
    act(() => useCitationPanelStore.getState().openFact('another-chat', 3));
    expect(second).toHaveAttribute('aria-pressed', 'false');
  });
});
