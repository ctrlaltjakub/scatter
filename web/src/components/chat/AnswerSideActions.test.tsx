import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerSideActions } from './AnswerSideActions';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useEditorStore } from '@/store/useEditorStore';
import type { ScatterNode } from '@/store/types';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

vi.mock('@/lib/factCheck', () => ({ factCheckAvailability: () => ({ available: false, reason: 'Choose a supported model' }),
  startFactCheck: vi.fn(), stopFactCheck: vi.fn() }));

function setup() {
  let chat = createChatNode({ id: 'source', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  chat = appendChatAnswer(chat, { turnId: 't', createdAt: 2, question: 'Question' });
  chat = updateChatAnswer(chat, { turnId: 't', versionCreatedAt: 2 }, { body: 'A complete answer.' }, { state: 'complete' });
  const node: ScatterNode = { id: 'answer', type: 'follow-up', frozen: false, position: { x: 700, y: 0 }, currentVersionIndex: 0,
    versions: [{ ...chat.versions[1]!, contentType: 'answer' }] };
  const project = { ...createBlankProject('Answer controls', chat.id), nodes: { [node.id]: node, [chat.id]: chat }, selection: [node.id] };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  useChatRuntimeStore.setState({ views: {} });
  return node;
}

beforeEach(() => useCitationPanelStore.getState().close());

describe('answer-specific controls', () => {
  it.each([true, false])('labels pending checks for resume only when boundaries match (current=%s)', current => {
    const node = setup();
    const version = node.versions[0]!;
    version.factCheck = { pending: { schemaVersion: 1,
      bodyFingerprint: current ? factCheckBodyFingerprint(version) : 'old-punctuation-boundaries',
      versionCreatedAt: version.createdAt, providerId: 'test', model: 'test', startedAt: 1,
      complete: false, failedUnitIds: [], units: [] } };
    render(<AnswerSideActions node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show fact-check results' }));
    expect(screen.getByRole('button', { name: current ? 'Continue check' : 'Check again' })).toBeInTheDocument();
  });
  it('offers versions, rich editing and images without conversation-only actions or a panel copy button', () => {
    const node = setup();
    const { container } = render(<AnswerSideActions node={node} />);
    expect([...container.querySelectorAll('.versions-row button')].map((b) => b.getAttribute('aria-label')))
      .toEqual(['Previous version', 'Next version', 'Redo term marking', 'Delete']);
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Compact|Information chunking|History|Fork|Expand|^Copy$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Search for free images' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show sources' })).not.toBeInTheDocument();
    expect(container.querySelector('.answer-side-actions')?.lastElementChild)
      .toBe(screen.getByRole('button', { name: 'Edit or export text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit or export text' }));
    expect(useEditorStore.getState()).toMatchObject({ nodeId: node.id, open: true });
  });
  it('describes every Add node option', () => {
    render(<AnswerSideActions node={setup()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    for (const name of ['Chat', 'Image or video', 'Encyclopedic node', 'Explanation', 'Interactive node', 'Markdown text node'])
      expect(screen.getByRole('button', { name })).toHaveAttribute('data-tip', expect.stringMatching(/.+/));
  });

  it('groups Markdown editing below Add node without changing its actions or undo history', () => {
    const node = setup();
    node.versions[0]!.markdownNote = true;
    const { container } = render(<AnswerSideActions node={node} />);
    const iconRow = container.querySelector('.versions-row');
    expect(container.querySelector('.answer-side-actions')?.firstElementChild).toBe(iconRow);
    const add = screen.getByRole('button', { name: 'Add node' });
    const dropdown = screen.getByRole('button', { name: 'Edit' });
    expect(iconRow?.nextElementSibling).toBe(add);
    expect(add.nextElementSibling).toBe(dropdown);
    expect(screen.queryByRole('button', { name: 'Edit header' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit or export text' })).toBeNull();
    fireEvent.click(dropdown);
    expect(dropdown).toHaveAttribute('aria-expanded', 'true');
    const header = screen.getByRole('button', { name: 'Edit header' });
    const edit = screen.getByRole('button', { name: 'Edit or export text' });
    expect(header.nextElementSibling).toBe(edit);
    fireEvent.click(header);
    expect(useChatRuntimeStore.getState().views[node.id]?.titleEditNonce).toBe(1);
    expect(screen.getAllByRole('button', { name: 'Edit or export text' })).toHaveLength(1);
    fireEvent.click(edit);
    expect(useEditorStore.getState()).toMatchObject({ nodeId: node.id, open: true });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('deletes the snapshot with normal app-level undo', () => {
    const node = setup();
    render(<AnswerSideActions node={node} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useGraphStore.getState().project?.nodes[node.id]).toBeUndefined();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes[node.id]).toEqual(node);
  });
});
