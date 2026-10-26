import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SidebarShortcuts } from './SidebarShortcuts';
import { useSettingsStore } from '@/store/useSettingsStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useFollowUpFocusStore } from '@/store/useFollowUpFocusStore';
import { useReadingStore } from '@/store/useReadingStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useCanvasSelectionStore } from '@/store/useCanvasSelectionStore';

beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, keybindings: {} });
  const project = createBlankProject('Shortcuts', 'n');
  project.nodes.n = { id: 'n', type: 'root', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: 'Topic', body: 'Some text', generatedBy: 'root', createdAt: 1 }] };
  project.selection = ['n'];
  useGraphStore.setState({ project });
  useGraphStore.temporal.getState().clear();
  useFollowUpFocusStore.setState({ focused: false });
  useReadingStore.getState().reset();
  useImageSelectionStore.getState().clear();
  useNodeTextSelectionStore.getState().clear();
  useCanvasSelectionStore.getState().setMarquee(null);
  useChatRuntimeStore.setState({ views: {} });
});
afterEach(() => vi.useRealTimers());

describe('contextual shortcut hints', () => {
  it('describes initial generation rather than a follow-up for blank text cards', () => {
    const node = useGraphStore.getState().project!.nodes.n!;
    useGraphStore.getState().updateNode('n', { versions: [{ ...node.versions[0]!, emptyText: true, body: '' }] });
    render(<><div className="node-followup-bar"><textarea aria-label="New topic"
      onFocus={() => useFollowUpFocusStore.getState().setFocused(true)} /></div><SidebarShortcuts /></>);
    expect(screen.queryByText('reading ruler')).toBeNull();
    act(() => screen.getByRole('textbox').focus());
    expect(screen.getByText('generate node')).toBeVisible();
    expect(screen.queryByText('ask follow-up')).toBeNull();
  });
  it('hides canvas keys while typing and uses chat-specific send wording', () => {
    render(<><div className="chat-composer"><textarea aria-label="Chat message"
      onFocus={() => useFollowUpFocusStore.getState().setFocused(true)} /></div><SidebarShortcuts /></>);
    expect(screen.getByText('control camera')).toBeVisible();
    act(() => screen.getByRole('textbox').focus());
    expect(screen.queryByText('control camera')).toBeNull();
    expect(screen.queryByText('zoom camera')).toBeNull();
    expect(screen.getByText('send message')).toBeVisible();
    expect(screen.getByText('new line')).toBeVisible();
    expect(screen.getByText('leave text field')).toBeVisible();
    expect(screen.getByText('search')).toBeVisible();
  });
  it('only offers model cycling with multiple models and shows both rebound shortcuts', () => {
    render(<SidebarShortcuts />);
    expect(screen.queryByText('model (⇧ prev)')).toBeNull();
    act(() => useSettingsStore.setState({ providers: [{ id: 'p', preset: 'openrouter', apiKey: 'test', enabledModels: ['a', 'b'] }],
      keybindings: { search: [{ key: 'j', meta: true }, { key: 'k', alt: true }] } }));
    expect(screen.getByText('model (⇧ prev)')).toBeVisible();
    expect(screen.getByText('search').previousElementSibling).toHaveTextContent('Ctrl/⌘+J / Alt+K');
  });
  it('offers collapsed exploration only for an unlinked hovered term and force zoom over chat scroll', () => {
    render(<><span className="ref-chip unexplored">New term</span><span className="ref-chip explored">Linked term</span>
      <div className="chat-scroll">Chat content</div><SidebarShortcuts /></>);
    fireEvent.mouseOver(screen.getByText('New term'));
    expect(screen.getByText('explore collapsed')).toBeVisible();
    fireEvent.mouseOver(screen.getByText('Linked term'));
    act(() => vi.advanceTimersByTime(501));
    expect(screen.queryByText('explore collapsed')).toBeNull();
    fireEvent.mouseOver(screen.getByText('Chat content'));
    expect(screen.getByText('force zoom')).toBeVisible();
  });
  it('describes the actual Escape action for the reading ruler and marquee', () => {
    render(<SidebarShortcuts />);
    act(() => useReadingStore.getState().begin('n', 0, 0, null));
    expect(screen.getByText('exit reading ruler')).toBeVisible();
    expect(screen.queryByText('deselect')).toBeNull();
    act(() => {
      useReadingStore.getState().reset();
      useCanvasSelectionStore.getState().setMarquee({ projectId: useGraphStore.getState().project!.id, rect: { x: 0, y: 0, w: 100, h: 100 } });
    });
    expect(screen.getByText('cancel selection')).toBeVisible();
    expect(screen.queryByText('deselect')).toBeNull();
  });
});

describe('compact shortcut layout', () => {
  it('combines the camera gestures without hiding either set of keys', () => {
    render(<SidebarShortcuts />);
    expect(screen.getAllByText('control camera')).toHaveLength(1);
    expect(screen.getByText('control camera').previousElementSibling).toHaveTextContent('WASD Q/E');
    expect(screen.queryByText('pan camera')).toBeNull();
    expect(screen.queryByText('zoom camera')).toBeNull();
  });

  it('gives long selection gestures a break before Shift+drag, keeping the gesture intact', () => {
    render(<SidebarShortcuts />);
    const keys = screen.getByText('add to selection').previousElementSibling!;
    expect(keys).toHaveTextContent('Ctrl/⌘+Shift+drag');
    expect([...keys.querySelectorAll('.shortcut-key-part')].map(part => part.textContent)).toEqual(['Ctrl/⌘+', 'Shift+drag']);
    expect([...keys.children].map(part => part.tagName)).toEqual(['SPAN', 'WBR', 'SPAN', 'WBR']);
    expect(keys.querySelector('.cmd-glyph')).toHaveTextContent('⌘');
  });

  it('keeps compact selection hints context-sensitive', () => {
    render(<><div className="node" data-node-id="n">Node title</div><SidebarShortcuts /></>);
    expect(screen.getByText('select nodes')).toBeVisible();
    expect(screen.queryByText('toggle selection')).toBeNull();
    fireEvent.mouseOver(screen.getByText('Node title'));
    expect(screen.getByText('toggle selection')).toBeVisible();
  });
});
