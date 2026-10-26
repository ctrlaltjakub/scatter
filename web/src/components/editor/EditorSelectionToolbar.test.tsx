import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import { EditorSelectionToolbar } from './EditorSelectionToolbar';
import { useSettingsStore } from '@/store/useSettingsStore';

afterEach(() => { vi.restoreAllMocks(); window.getSelection()?.removeAllRanges(); });

describe('editor selection web search', () => {
  it('opens a search for the editor selection without changing editor content', () => {
    useSettingsStore.setState({ selectionWebSearch: { engineId: 'duckduckgo', customEngines: [] } });
    const callbacks = new Map<string, () => void>();
    const textBetween = vi.fn(() => 'alpha & beta');
    const chain = vi.fn();
    const editor = {
      isDestroyed: false, isFocused: true,
      state: { selection: { empty: false, from: 2, to: 14, $from: { depth: 0, node: () => ({ type: { name: 'doc' } }) } }, doc: { textBetween } },
      on: (event: string, callback: () => void) => callbacks.set(event, callback),
      off: (event: string) => callbacks.delete(event),
      chain,
    } as unknown as Editor;
    const view = render(<><p>alpha &amp; beta</p><EditorSelectionToolbar editor={editor} /></>);
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('alpha & beta'));
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => ({ left: 5, width: 100, top: 70, height: 20 } as DOMRect),
    });
    window.getSelection()!.addRange(range);
    act(() => callbacks.get('selectionUpdate')!());
    const link = screen.getByRole('link', { name: 'Web search' });
    expect(textBetween).toHaveBeenCalledWith(2, 14, ' ');
    expect(link).toHaveAttribute('href', 'https://duckduckgo.com/?q=alpha%20%26%20beta');
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.mouseDown(link);
    expect(chain).not.toHaveBeenCalled();
    view.unmount();
    expect(callbacks.size).toBe(0);
  });
});
