import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WelcomeScreenB } from './WelcomeScreenB';
import { useSettingsStore } from '@/store/useSettingsStore';
import { generateRoot } from '@/lib/generate';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { createScatter, deleteScatter, switchScatter } from '@/store/projectActions';
import { startChatRoot, startImageRoot, prepareProjectImage } from '@/lib/projectStart';

// Mock the heavy / interaction-only deps so the test only exercises render
// logic (the "Recommend" button's disabled state vs. topic history). None of
// these run on mount — they're click handlers / a sibling control.
vi.mock('@/lib/generate', () => ({
  generateRoot: vi.fn(),
  oneShotCompletion: vi.fn(),
}));
vi.mock('@/opfs/settingsIO', () => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
}));
vi.mock('@/store/projectActions', () => ({
  createScatter: vi.fn(),
  deleteScatter: vi.fn(),
  switchScatter: vi.fn(),
}));
vi.mock('@/components/SidebarModelPicker', () => ({
  SidebarModelPicker: () => null,
}));
vi.mock('@/lib/projectStart', () => ({ startChatRoot: vi.fn(), startImageRoot: vi.fn(), prepareProjectImage: vi.fn() }));

const recommendBtn = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>('.topic-recommend')!;

function renderTopicPicker() {
  const result = render(<WelcomeScreenB />);
  fireEvent.click(screen.getByRole('tab', { name: 'Topic' }));
  return result;
}

describe('WelcomeScreenB — Recommend button', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    useSettingsStore.setState({ topicHistory: undefined, chatStartHistory: undefined });
    const project = createBlankProject('Topic draft', 'root');
    useGraphStore.setState({
      project,
      activeProjectId: project.id,
      projectList: [{
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        color: project.color,
      }],
      pickerOpen: true,
    });
    useSourceRuntimeStore.setState({ jobs: {} });
    useSourceUiStore.setState({ managerOpen: false, topicDraft: null });
    vi.mocked(generateRoot).mockReset();
    vi.mocked(createScatter).mockReset();
    vi.mocked(deleteScatter).mockReset();
    vi.mocked(switchScatter).mockReset();
    vi.mocked(startChatRoot).mockReset();
    vi.mocked(startImageRoot).mockReset();
    vi.mocked(prepareProjectImage).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is disabled when there is no recently-explored history', () => {
    useSettingsStore.setState({ topicHistory: undefined });
    const { container } = renderTopicPicker();
    const btn = recommendBtn(container);
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
  });
  it('opens settings without discarding the prompt, tab, or sources state', () => {
    const open = vi.fn();
    const { container, rerender } = render(<WelcomeScreenB onOpenSettings={open} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: /add sources/i }));
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(open).toHaveBeenCalledOnce();
    expect(useGraphStore.getState().pickerOpen).toBe(true);
    rerender(<WelcomeScreenB onOpenSettings={open} settingsOpen />);
    expect(container.querySelector('.welcome-picker-frame')).toHaveAttribute('inert');
    rerender(<WelcomeScreenB onOpenSettings={open} />);
    expect(screen.getByRole('textbox', { name: 'First message' })).toHaveValue('Keep this draft');
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    expect(screen.getByRole('tab', { name: 'Start with a chat' })).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('.welcome-picker-frame')).not.toHaveAttribute('inert');
  });

  it('edits the same draft in the expanded window and returns it without submitting', async () => {
    const { container } = renderTopicPicker();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Initial topic' } });
    const expand = screen.getByRole('button', { name: 'Expand topic editor' });
    expand.focus();
    fireEvent.click(expand);
    const editor = screen.getByRole('textbox', { name: 'Topic in expanded editor' });
    expect(editor).toHaveValue('Initial topic');
    expect(editor).toHaveFocus();
    expect(container.querySelector('.welcome-picker-frame')).toHaveAttribute('inert');
    fireEvent.change(editor, { target: { value: 'A long topic\nwith multiple lines' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(generateRoot).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /what do you want/i })).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('A long topic\nwith multiple lines');
    expect(useGraphStore.getState().pickerOpen).toBe(true);
    expect(container.querySelector('.welcome-picker-frame')).not.toHaveAttribute('inert');
    await waitFor(() => expect(expand).toHaveFocus());
  });

  it('submits from the expanded window using Ctrl+Enter and preserves the existing flow', () => {
    renderTopicPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Expand topic editor' }));
    const editor = screen.getByRole('textbox', { name: 'Topic in expanded editor' });
    expect(screen.getByRole('button', { name: 'Explore' })).toBeDisabled();
    fireEvent.change(editor, { target: { value: 'Detailed topic\nwith context' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    expect(generateRoot).toHaveBeenCalledWith('Detailed topic\nwith context', { skipPendingSources: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not submit while Enter confirms an input-method composition', () => {
    render(<WelcomeScreenB />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '日本語' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(generateRoot).not.toHaveBeenCalled();
    expect(startChatRoot).not.toHaveBeenCalled();
  });

  it('is disabled when the history array is empty', () => {
    useSettingsStore.setState({ topicHistory: [] });
    const { container } = renderTopicPicker();
    expect(recommendBtn(container).disabled).toBe(true);
  });

  it.each([undefined, []])('keeps the History section visible with empty history (%j)', (topicHistory) => {
    useSettingsStore.setState({ topicHistory });
    renderTopicPicker();
    const heading = screen.getByText('History');
    const empty = screen.getByText('No history yet.');
    const alternative = screen.getByText('Or');
    expect(heading).toBeVisible();
    expect(empty).toBeVisible();
    expect(empty).toHaveClass('recent-query', 'recent-empty');
    expect(empty.parentElement).toHaveClass('recent-rows');
    expect(empty.parentElement?.firstElementChild).toBe(empty);
    expect(heading.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(empty.compareDocumentPosition(alternative) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove all' })).toBeNull();
    expect(screen.queryByRole('button', { name: /page$/ })).toBeNull();
  });

  it('uses each text tab’s own empty state and keeps history hidden on the image tab', () => {
    useSettingsStore.setState({ topicHistory: ['Saved topic'], chatStartHistory: [] });
    render(<WelcomeScreenB />);
    expect(screen.getByText('No history yet.')).toBeVisible();
    expect(screen.queryByText('Saved topic')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Topic' }));
    expect(screen.queryByText('No history yet.')).toBeNull();
    expect(screen.getByText('Saved topic')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    expect(screen.getByText('History')).not.toBeVisible();
    expect(screen.getByText('Saved topic')).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Topic' }));
    expect(screen.getByText('Saved topic')).toBeVisible();
    expect(screen.queryByText('No history yet.')).toBeNull();
  });

  it('shows the empty state when the final history entry is removed', () => {
    useSettingsStore.setState({ topicHistory: ['Saved topic'] });
    renderTopicPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Remove "Saved topic" from history' }));
    expect(screen.getByText('History')).toBeVisible();
    expect(screen.getByText('No history yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove all' })).toBeNull();
    expect(generateRoot).not.toHaveBeenCalled();
  });

  it('is enabled once there is at least one explored topic', () => {
    useSettingsStore.setState({ topicHistory: ['photosynthesis'] });
    const { container } = renderTopicPicker();
    expect(recommendBtn(container).disabled).toBe(false);
  });

  it('shows four history entries per column and opens sources from an empty project', () => {
    useSettingsStore.setState({ topicHistory: Array.from({ length: 10 }, (_, index) => `Topic ${index + 1}`) });
    const { container } = renderTopicPicker();

    expect(container.querySelectorAll('.recent-row')).toHaveLength(8);
    expect(container.querySelectorAll('.recent-row-actions')).toHaveLength(8);
    expect(container.querySelectorAll('.recent-row-action.sidebar-row-action')).toHaveLength(8);
    const firstRow = container.querySelector<HTMLElement>('.recent-row')!;
    expect(firstRow).toHaveClass('has-accent');
    expect(firstRow.querySelector('.recent-query')?.tagName).toBe('SPAN');
    fireEvent.click(firstRow.querySelector('.recent-row-action')!);
    expect(generateRoot).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().topicHistory).not.toContain('Topic 1');
    fireEvent.click(screen.getByRole('button', { name: /add sources/i }));
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    expect(useSourceUiStore.getState().importOpen).toBe(false);
  });

  it('starts with sources closed and keeps them open across tab changes and backdrop pointerdown', () => {
    useGraphStore.setState({ pickerOpen: true });
    useSourceUiStore.setState({ managerOpen: true });
    const { container } = render(<WelcomeScreenB />);
    const sourceToggle = () => container.querySelector<HTMLButtonElement>('.topic-source-controls .source-manager-button')!;
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
    fireEvent.click(sourceToggle());
    fireEvent.click(screen.getByRole('tab', { name: 'Topic' }));
    fireEvent.pointerDown(container.querySelector('.welcome')!);
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    fireEvent.click(sourceToggle());
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(sourceToggle());
    expect(useSourceUiStore.getState().managerOpen).toBe(true);
    fireEvent.click(sourceToggle());
    expect(useSourceUiStore.getState().managerOpen).toBe(false);
  });

  it('defaults to Chat, orders tabs Chat–Topic–Image, and keeps independent drafts with keyboard navigation', () => {
    const { container } = render(<WelcomeScreenB />);
    const chatTab = screen.getByRole('tab', { name: 'Start with a chat' });
    expect(screen.getAllByRole('tab').map(tab => tab.id)).toEqual(['start-tab-chat', 'start-tab-topic', 'start-tab-image']);
    expect(chatTab).toHaveAttribute('aria-selected', 'true');
    expect(container.querySelector('.welcome-picker-shell')?.contains(chatTab)).toBe(false);
    expect(screen.queryByRole('button', { name: /recommend based/i })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), { target: { value: 'Chat draft' } });
    fireEvent.keyDown(chatTab, { key: 'ArrowRight' });
    const topicTab = screen.getByRole('tab', { name: 'Start with a topic' });
    expect(topicTab).toHaveFocus();
    fireEvent.change(screen.getByRole('textbox', { name: 'Topic or question' }), { target: { value: 'Topic draft' } });
    fireEvent.keyDown(topicTab, { key: 'ArrowRight' });
    const imageTab = screen.getByRole('tab', { name: 'Start with an image' });
    expect(imageTab).toHaveFocus();
    fireEvent.keyDown(imageTab, { key: 'ArrowLeft' });
    expect(topicTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('textbox', { name: 'Topic or question' })).toHaveValue('Topic draft');
    fireEvent.keyDown(topicTab, { key: 'Home' });
    expect(chatTab).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'First message' })).toHaveValue('Chat draft');
    fireEvent.keyDown(chatTab, { key: 'End' });
    expect(imageTab).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Start with an image' })).toHaveAttribute('aria-selected', 'true');
  });

  it('starts a standalone conversation and records only its first prompt in chat-start history', () => {
    useSettingsStore.setState({ topicHistory: ['Biology'], chatStartHistory: ['An earlier conversation'] });
    render(<WelcomeScreenB />);
    expect(screen.getByText('An earlier conversation')).toBeVisible();
    expect(screen.queryByText('Biology')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), { target: { value: 'Help me understand code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(startChatRoot).toHaveBeenCalledWith('Help me understand code', { skipPendingSources: false });
    expect(generateRoot).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().chatStartHistory?.[0]).toBe('Help me understand code');
    expect(useSettingsStore.getState().topicHistory).toEqual(['Biology']);
  });

  it('prefixes chat suggestions but replays history prompts verbatim', () => {
    const { container } = render(<WelcomeScreenB />);
    expect(screen.getByText('Tell me about')).toBeVisible();
    const suggestion = container.querySelector<HTMLButtonElement>('.suggest-pill')!;
    const prompt = `Tell me about: ${suggestion.textContent}`;
    fireEvent.click(suggestion);
    expect(startChatRoot).toHaveBeenCalledWith(prompt, { skipPendingSources: false });
    fireEvent.click(container.querySelector('.recent-row')!);
    expect(startChatRoot).toHaveBeenLastCalledWith(prompt, { skipPendingSources: false });
  });

  it('clears chat-start history without affecting topic history', () => {
    useSettingsStore.setState({ topicHistory: ['Biology'], chatStartHistory: ['Hello'] });
    render(<WelcomeScreenB />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
    expect(useSettingsStore.getState().chatStartHistory).toBeUndefined();
    expect(useSettingsStore.getState().topicHistory).toEqual(['Biology']);
    expect(screen.getByText('History')).toBeVisible();
    expect(screen.getByText('No history yet.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove all' })).toBeNull();
  });

  it('starts chat with ready sources when requested', () => {
    const projectId = useGraphStore.getState().activeProjectId!;
    useSourceRuntimeStore.getState().upsertJob({ schemaVersion: 1, id: 'pending', projectId,
      title: 'Reference', kind: 'text', status: 'indexing', createdAt: 1, checkedOnSuccess: true });
    render(<WelcomeScreenB />);
    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), { target: { value: 'Explain this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));
    expect(startChatRoot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start now' }));
    expect(startChatRoot).toHaveBeenCalledWith('Explain this', { skipPendingSources: true });
  });

  it('previews an image link, preserves it across tabs, and starts without AI or prompt history', async () => {
    const image = { title: 'Diagram', previewUrl: 'https://example.com/image.png', media: {
      source: 'link' as const, kind: 'image' as const, url: 'https://example.com/image.png', naturalWidth: 800, naturalHeight: 600 } };
    vi.mocked(prepareProjectImage).mockResolvedValue(image);
    vi.mocked(startImageRoot).mockResolvedValue('image-root');
    render(<WelcomeScreenB />);
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    expect(screen.getByRole('button', { name: 'Start project' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Image link' }), { target: { value: image.previewUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Add image' }));
    await screen.findByRole('img', { name: 'Diagram' });
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    expect(screen.getByRole('img', { name: 'Diagram' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Start project' }));
    await waitFor(() => expect(useGraphStore.getState().pickerOpen).toBe(false));
    expect(startImageRoot).toHaveBeenCalledWith(image);
    expect(startChatRoot).not.toHaveBeenCalled(); expect(generateRoot).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().topicHistory).toBeUndefined();
    expect(useSettingsStore.getState().chatStartHistory).toBeUndefined();
  });

  it('closes an overlay without deleting or creating a project', () => {
    const existing = useGraphStore.getState().project!;
    useGraphStore.setState({
      project: {
        ...existing,
        nodes: {
          root: {
            id: 'root',
            type: 'root',
            position: { x: 0, y: 0 },
            frozen: true,
            versions: [{ header: 'Existing topic', body: 'Body.', createdAt: 1, generatedBy: 'root' }],
            currentVersionIndex: 0,
          },
        },
      },
      pickerOpen: true,
    });
    render(<WelcomeScreenB />);

    fireEvent.click(screen.getByRole('button', { name: 'Close topic picker' }));

    expect(useGraphStore.getState().pickerOpen).toBe(false);
    expect(useGraphStore.getState().activeProjectId).toBe(existing.id);
    expect(createScatter).not.toHaveBeenCalled();
    expect(deleteScatter).not.toHaveBeenCalled();
    expect(switchScatter).not.toHaveBeenCalled();
  });

  it('restores the project behind a committed source draft before deleting the draft', async () => {
    const draft = useGraphStore.getState().project!;
    const original = createBlankProject('Original project', '');
    useGraphStore.setState({
      project: draft,
      activeProjectId: draft.id,
      projectList: [
        { id: draft.id, name: draft.name, createdAt: draft.createdAt, updatedAt: draft.updatedAt, color: draft.color },
        { id: original.id, name: original.name, createdAt: original.createdAt, updatedAt: original.updatedAt, color: original.color },
      ],
      pickerOpen: true,
    });
    useSourceUiStore.setState({
      topicDraft: { projectId: draft.id, returnProjectId: original.id },
    });
    vi.mocked(switchScatter).mockImplementation(async () => {
      useGraphStore.setState({ project: original, activeProjectId: original.id });
    });
    vi.mocked(deleteScatter).mockResolvedValue(undefined);
    render(<WelcomeScreenB />);

    fireEvent.click(screen.getByRole('button', { name: 'Close topic picker' }));

    await waitFor(() => expect(deleteScatter).toHaveBeenCalledWith(draft.id));
    expect(switchScatter).toHaveBeenCalledWith(original.id);
    expect(vi.mocked(switchScatter).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deleteScatter).mock.invocationCallOrder[0]!,
    );
    expect(useSourceUiStore.getState().topicDraft).toBeNull();
    expect(useGraphStore.getState().pickerOpen).toBe(false);
  });

  it('warns before starting with unfinished sources and can proceed with ready sources only', () => {
    const projectId = useGraphStore.getState().activeProjectId!;
    useSourceRuntimeStore.getState().upsertJob({
      schemaVersion: 1,
      id: 'pending-source',
      projectId,
      title: 'Long reference',
      kind: 'text',
      status: 'indexing',
      createdAt: 1,
      checkedOnSuccess: true,
    });
    const { getByLabelText, getByRole } = renderTopicPicker();

    fireEvent.change(getByRole('textbox'), { target: { value: 'A resilient city' } });
    fireEvent.click(getByLabelText('Submit topic'));

    expect(getByRole('dialog', { name: 'Sources are still processing' })).toBeVisible();
    expect(generateRoot).not.toHaveBeenCalled();

    fireEvent.click(getByRole('button', { name: 'Start now' }));
    expect(generateRoot).toHaveBeenCalledWith('A resilient city', { skipPendingSources: true });
  });
});
