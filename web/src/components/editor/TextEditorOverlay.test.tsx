import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TextEditorOverlay from './TextEditorOverlay';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useEditorStore } from '@/store/useEditorStore';
import { useSettingsStore } from '@/store/useSettingsStore';

beforeEach(() => {
  // jsdom has no layout; ProseMirror uses Range geometry to reveal the caret
  // when switching views. Real scrolling is also checked in the browser.
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => Object.assign(createRange(), {
    getClientRects: () => [], getBoundingClientRect: () => new DOMRect(),
  }));
  const project = createBlankProject('Editor', 'n');
  project.nodes.n = { id: 'n', type: 'manual-empty', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ createdAt: 1, header: 'Custom text', body: '', generatedBy: 'manual', contentType: 'answer', markdownNote: true,
      chat: { turnId: 'n', title: 'Custom text', question: '', state: 'complete', informationChunking: false, contextPath: [] } }] };
  useGraphStore.setState({ project, activeProjectId: project.id });
  useGraphStore.temporal.getState().clear();
  useSettingsStore.setState({ sentencePerLine: false });
  useEditorStore.getState().openEditor('n');
});
afterEach(() => { cleanup(); useEditorStore.getState().close(); vi.restoreAllMocks(); });
const node = () => useGraphStore.getState().project!.nodes.n!;
describe('text editor sessions', () => {
  it('transfers focus and the text selection when switching Source and Visual without saving a version', async () => {
    const body = 'One **bold word** in this paragraph.';
    useGraphStore.getState().updateNode('n', { versions: [{ ...node().versions[0]!, body }] });
    const { container } = render(<TextEditorOverlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement;
    expect(source).toHaveFocus();
    const start = body.indexOf('bold') + 1, end = body.indexOf('word') + 2;
    source.setSelectionRange(start, end, 'backward');
    fireEvent.select(source);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect(container.querySelector('.ProseMirror')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const restored = screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement;
    expect(restored).toHaveFocus();
    expect(restored.selectionStart).toBe(start);
    expect(restored.selectionEnd).toBe(end);
    expect(restored.selectionDirection).toBe('backward');
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(restored).toHaveFocus();
    expect(node().versions.map(version => version.body)).toEqual([body]);
  });

  it('uses a Markdown text section frame in both editing modes, including an empty document', async () => {
    const { container } = render(<TextEditorOverlay />);
    const frame = await screen.findByRole('group', { name: 'Markdown text' });
    expect(frame).toHaveClass('editor-markdown-frame');
    expect(frame.querySelector('.ProseMirror')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveFocus();
    expect(frame).toContainElement(screen.getByRole('textbox', { name: 'Markdown source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    expect(container.querySelector('.ProseMirror')).toHaveFocus();
    expect(node().versions).toHaveLength(1);
  });
  it('does not resurrect a deleted draft from a pending autosave', async () => {
    render(<TextEditorOverlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'First' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'Pending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete version' }));
    expect(node().versions.map(v => v.body)).toEqual(['']);
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(node().versions.map(v => v.body)).toEqual(['']);
  });
  it('flushes pending typing when immediately closing', async () => {
    render(<TextEditorOverlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'First' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: 'Latest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(node().versions.map(v => v.body)).toEqual(['', 'Latest']);
  });
  it('does not create versions for switching editing modes or reading noncanonical source', async () => {
    const body = '*Italic*\n\n* first\n* second';
    useGraphStore.getState().updateNode('n', { versions: [{ ...node().versions[0]!, body }, { ...node().versions[0]!, createdAt: 2, body: 'Other' }] });
    render(<TextEditorOverlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(body);
    fireEvent.click(screen.getByRole('button', { name: 'Visual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(node().versions.map(v => v.body)).toEqual([body, 'Other']);
  });
  it('autosaves one draft version and never discards edits when switching versions or closing', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<TextEditorOverlay />);
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: '**First edit**' } });
    expect(node().versions).toHaveLength(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: '**Latest edit**' } });
    expect(node().versions).toHaveLength(2);
    await waitFor(() => expect(node().versions[1]!.body).toBe('**Latest edit**'));
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('');
    expect(node().versions.map(v => v.body)).toEqual(['', '**Latest edit**']);
    expect(node().currentVersionIndex).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next version' }));
    expect(node().versions.map(v => v.body)).toEqual(['', '**Latest edit**']);
    expect(node().currentVersionIndex).toBe(1);
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('**Latest edit**');
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(node().versions).toHaveLength(2);
    act(() => useEditorStore.getState().openEditor('n'));
    fireEvent.click(await screen.findByRole('button', { name: 'Source' }));
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('**Latest edit**');
  });
  it('uses the explain schema even for a manual-empty node', async () => {
    const current = node();
    useGraphStore.getState().updateNode('n', { versions: [{ ...current.versions[0]!, contentType: 'explain', markdownNote: undefined, body: 'A clear explanation.' }] });
    const { container } = render(<TextEditorOverlay />);
    await screen.findByRole('button', { name: /Information chunking:/ });
    expect(container.querySelector('.text-editor-stage [title]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Demote bullet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Promote bullet' })).toBeNull();
    expect(container.querySelector('.editor-bullets')).toBeNull();
  });
});
