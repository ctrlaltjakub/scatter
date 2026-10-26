import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SelectionToolbar } from './SelectionToolbar';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import type { ScatterNode } from '@/store/types';
import { spawnRoutedExplain, spawnTermClick } from '@/lib/generate';
import { configuredImageModelAvailable, spawnImageFromSelection } from '@/lib/imageGeneration';
import { useSettingsStore } from '@/store/useSettingsStore';

vi.mock('@/lib/generate', () => ({ spawnTermClick: vi.fn(), spawnRoutedExplain: vi.fn() }));
vi.mock('@/lib/imageGeneration', () => ({
  configuredImageModelAvailable: vi.fn(() => false),
  spawnImageFromSelection: vi.fn(),
}));

const body = 'Opening.\n\n- Topic\n  - First: repeated alpha\n  - Second: repeated beta';
const node: ScatterNode = {
  id: 'n1', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
  versions: [{ header: 'Node', body, createdAt: 0, generatedBy: 'term-click' }],
  currentVersionIndex: 0,
};

function selectText(element: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  range.setStart(element.firstChild!, start);
  range.setEnd(element.firstChild!, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('SelectionToolbar exact node selection', () => {
  let highlights: Map<string, unknown>;

  beforeEach(() => {
    useSettingsStore.setState({ selectionWebSearch: { engineId: 'google', customEngines: [] } });
    vi.mocked(spawnTermClick).mockReset();
    vi.mocked(spawnRoutedExplain).mockReset();
    vi.mocked(spawnImageFromSelection).mockReset();
    vi.mocked(configuredImageModelAvailable).mockReturnValue(false);
    highlights = new Map();
    class TestHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) { this.ranges = ranges; }
    }
    Object.defineProperty(window, 'Highlight', { configurable: true, value: TestHighlight });
    Object.defineProperty(CSS, 'highlights', {
      configurable: true,
      value: {
        set: (name: string, value: unknown) => highlights.set(name, value),
        delete: (name: string) => highlights.delete(name),
      },
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 10, right: 90, top: 50, bottom: 70, width: 80, height: 20, x: 10, y: 50, toJSON() {} }),
    });
    useNodeTextSelectionStore.getState().clear();
    const project = createBlankProject('selection', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
    document.body.innerHTML = `
      <div data-node-id="n1"><div class="sc-ab-root">
        <span data-sc-source-field="b:0:c:1:desc">repeated beta</span>
      </div></div>`;
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    useNodeTextSelectionStore.getState().clear();
    useGraphStore.getState().setProject(null);
    highlights.clear();
  });

  it('stores the exact source range and focuses its node without requesting a pan', async () => {
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore' })).toBeInTheDocument());
    const exact = useNodeTextSelectionStore.getState().selection;
    expect(exact).not.toBeNull();
    expect(body.slice(exact!.start, exact!.end)).toBe('repeated');
    expect(useGraphStore.getState().project?.selection).toEqual(['n1']);
    expect(useGraphStore.getState().panTo).toBeNull();
  });

  it('offers Image when configured and passes the exact semantic selection', async () => {
    vi.mocked(configuredImageModelAvailable).mockReturnValue(true);
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    const button = await screen.findByRole('button', { name: 'Image' });
    fireEvent.click(button);
    expect(spawnImageFromSelection).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ nodeId: 'n1', text: 'repeated' }),
    );
  });

  it('searches only the selected phrase in a safe new tab without generating a node', async () => {
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    const link = await screen.findByRole('link', { name: 'Web search' });
    expect(link).toHaveAttribute('href', 'https://www.google.com/search?q=repeated');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const exact = useNodeTextSelectionStore.getState().selection;
    fireEvent.mouseDown(link);
    expect(useNodeTextSelectionStore.getState().selection).toBe(exact);
    act(() => useSettingsStore.setState({ selectionWebSearch: { engineId: 'bing', customEngines: [] } }));
    expect(link).toHaveAttribute('href', 'https://www.bing.com/search?q=repeated');
    expect(spawnTermClick).not.toHaveBeenCalled();
    expect(spawnRoutedExplain).not.toHaveBeenCalled();
    expect(spawnImageFromSelection).not.toHaveBeenCalled();
  });

  it('clears the toolbar and selected-text scope when wheel scrolling changes the visible content', async () => {
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore' })).toBeInTheDocument());

    fireEvent.wheel(field, { deltaY: 80 });

    expect(screen.queryByRole('button', { name: 'Explore' })).not.toBeInTheDocument();
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
  });

  it('retains and visibly paints the exact selection when the user starts typing in the follow-up bar', async () => {
    const input = document.createElement('textarea');
    input.className = 'node-followup-input';
    const followup = document.createElement('div');
    followup.className = 'node-followup-bar';
    followup.append(input);
    document.body.append(followup);
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    await waitFor(() => expect(useNodeTextSelectionStore.getState().selection).not.toBeNull());

    fireEvent.pointerDown(input);
    expect(screen.queryByRole('button', { name: 'Explore' })).not.toBeInTheDocument();
    expect(highlights.has('sc-preserved-selection')).toBe(true);
    act(() => window.getSelection()?.removeAllRanges());
    act(() => document.dispatchEvent(new Event('selectionchange')));
    fireEvent.mouseUp(input);

    expect(useNodeTextSelectionStore.getState().selection?.text).toBe('repeated');
    expect(highlights.has('sc-preserved-selection')).toBe(true);

    fireEvent.pointerDown(document.body);
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
    expect(highlights.has('sc-preserved-selection')).toBe(false);
  });

  it('passes the immutable exact selection to Explore and Explain before dismissing it', async () => {
    render(<SelectionToolbar />);
    const field = document.querySelector<HTMLElement>('[data-sc-source-field]')!;
    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explore' })).toBeInTheDocument());
    const exact = useNodeTextSelectionStore.getState().selection!;

    fireEvent.click(screen.getByRole('button', { name: 'Explore' }));
    expect(spawnTermClick).toHaveBeenCalledWith('n1', 'repeated', { sourceSelection: exact });

    selectText(field, 0, 8);
    fireEvent.mouseUp(field);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Explain' })).toBeInTheDocument());
    const explainExact = useNodeTextSelectionStore.getState().selection!;
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(spawnRoutedExplain).toHaveBeenCalledWith('n1', 'repeated', { sourceSelection: explainExact });
  });
});
