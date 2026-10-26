import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { ChatComposer } from './ChatComposer';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';

vi.mock('@/lib/chat/actions', () => ({ cancelChatEdit: vi.fn(), stopChat: vi.fn(), submitChat: vi.fn() }));
vi.mock('@/lib/chat/availability', () => ({ chatAvailability: () => ({ available: true, reason: '' }) }));

beforeEach(() => {
  const node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
  const project = createBlankProject('Attachment button test', node.id);
  useGraphStore.setState({ project: { ...project, nodes: { [node.id]: node } } });
  useChatRuntimeStore.setState({ views: {}, drafts: {} });
  useNodeTextSelectionStore.getState().clear();
});

afterEach(cleanup);

describe('chat attachment button', () => {
  it.each(['typing', 'newline'])('deactivates fact-check display on %s, not merely focusing the composer', action => {
    useCitationPanelStore.getState().openFact('chat', 1);
    render(<ChatComposer nodeId="chat" />);
    const field = screen.getByRole('textbox', { name: 'Chat message' });
    fireEvent.focus(field);
    expect(useCitationPanelStore.getState().mode).toBe('fact-check');
    if (action === 'typing') fireEvent.change(field, { target: { value: 'A new question' } });
    else fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(useCitationPanelStore.getState().mode).toBeNull();
    expect(useChatRuntimeStore.getState().views.chat?.rightPanelPreference).toBeNull();
  });
  it('shows a selected answer passage without stealing focus and clears it on deselection or click', () => {
    let node = useGraphStore.getState().project!.nodes.chat!;
    node = appendChatAnswer(node, { turnId: 'turn', createdAt: 2, question: 'Original question' });
    node = updateChatAnswer(node, { turnId: 'turn', versionCreatedAt: 2 }, { body: 'Selected 日本語\nعبارة text' }, { state: 'complete' });
    useGraphStore.getState().updateNode('chat', node);
    const projectId = useGraphStore.getState().project!.id;
    useChatRuntimeStore.getState().setDraft(projectId, 'chat', { text: '', reference: { turnId: 'turn', versionCreatedAt: 2, title: 'Original question' } });
    render(<ChatComposer nodeId="chat" />);
    expect(screen.getByText('Asking about: Original question')).toBeVisible();
    const selection = { nodeId: 'chat', versionIndex: node.currentVersionIndex, sourceBody: node.versions.at(-1)!.body,
      start: 0, end: 20, text: 'Selected 日本語\nعبارة text' };
    act(() => useNodeTextSelectionStore.getState().set(selection));
    const label = screen.getByRole('button', { name: 'Stop asking about: Selected 日本語 عبارة text' });
    expect(label).toHaveTextContent('Asking about: Selected 日本語 عبارة text');
    expect(screen.getByRole('textbox', { name: 'Chat message' })).not.toHaveFocus();
    act(() => useNodeTextSelectionStore.getState().clear());
    // The earlier whole-answer scope must not return when the passage clears.
    expect(screen.queryByText(/Asking about:/)).toBeNull();
    act(() => useNodeTextSelectionStore.getState().set(selection));
    fireEvent.click(screen.getByRole('button', { name: /Stop asking about:/ }));
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
    expect(screen.queryByText(/Asking about:/)).toBeNull();
    act(() => useNodeTextSelectionStore.getState().set({ ...selection, nodeId: 'another-node' }));
    expect(screen.queryByText(/Asking about:/)).toBeNull();
  });
  it('keeps button icons beside their labels without squeezing the icons', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/globals.css'), 'utf8');
    const buttonRule = css.match(/\.chat-composer-send-column \.node-followup-btn\s*\{([^}]+)\}/)?.[1];
    expect(buttonRule).toMatch(/flex-direction:\s*row\s*;/);
    expect(buttonRule).toMatch(/gap:\s*5px\s*;/);
    expect(buttonRule).toMatch(/white-space:\s*nowrap\s*;/);
    expect(css).toMatch(/\.chat-composer-send-column \.node-followup-btn svg\s*\{\s*flex:\s*none\s*;/);
  });

  it('shows a paperclip and Attach label, and opens the existing file dialog', async () => {
    render(<ChatComposer nodeId="chat" />);
    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button).toHaveTextContent('Attach');
    const paperclip = button.querySelector('svg.lucide-paperclip');
    const sendIcon = screen.getByRole('button', { name: 'Send message' }).querySelector('svg');
    expect(paperclip).toHaveAttribute('width', '14');
    expect(paperclip).toHaveAttribute('height', '14');
    expect(paperclip?.getAttribute('width')).toBe(sendIcon?.getAttribute('width'));
    expect(paperclip?.getAttribute('height')).toBe(sendIcon?.getAttribute('height'));
    expect(button).toHaveAttribute('data-tip', 'Attach images or files to this message');
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Attach files to message' })).toBeVisible();
  });

  it('remains disabled while the conversation is compacting', () => {
    useChatRuntimeStore.getState().view('chat', { compacting: true });
    render(<ChatComposer nodeId="chat" />);
    const button = screen.getByRole('button', { name: 'Attach files' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
