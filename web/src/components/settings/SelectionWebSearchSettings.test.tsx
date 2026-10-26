import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { SelectionWebSearchSettings } from './SelectionWebSearchSettings';
import { SelectionWebSearchLink } from '../SelectionWebSearchLink';
import { BUILTIN_SEARCH_ENGINES } from '@/lib/selectionWebSearch';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));

beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS }));

function fillCustom(name = 'My library', url = 'https://example.org/find/{query}?lang=pl') {
  fireEvent.change(screen.getByLabelText('Engine name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('Search URL'), { target: { value: url } });
}

describe('selection web search settings', () => {
  it.each([false, true])('defaults to Google and updates toolbar links without changing AI web search (%s)', webSearch => {
    useSettingsStore.setState({ webSearch });
    render(<><SelectionWebSearchSettings /><SelectionWebSearchLink text="salt & pepper" /></>);
    expect(screen.getByLabelText('Search engine')).toHaveValue('google');
    for (const engine of BUILTIN_SEARCH_ENGINES) {
      fireEvent.change(screen.getByLabelText('Search engine'), { target: { value: engine.id } });
      const link = screen.getByRole('link', { name: 'Web search' });
      expect(link.querySelector('svg')).toBeNull();
      expect(link).toHaveAttribute('href', engine.urlTemplate.replace('{query}', 'salt%20%26%20pepper'));
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    expect(useSettingsStore.getState().webSearch).toBe(webSearch);
  });

  it('adds, edits, and removes multiple custom engines, falling back to Google when removing the selected one', () => {
    render(<><SelectionWebSearchSettings /><SelectionWebSearchLink text="hello world" /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Add custom engine' }));
    fillCustom();
    expect(screen.getByText('https://example.org/find/hello%20world?lang=pl')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add and use engine' }));
    const firstId = useSettingsStore.getState().selectionWebSearch.engineId;
    expect(firstId).toMatch(/^custom-/);
    expect(screen.getByRole('link', { name: 'Web search' })).toHaveAttribute('href', 'https://example.org/find/hello%20world?lang=pl');
    fireEvent.click(screen.getByRole('button', { name: 'Edit engine' }));
    fillCustom('Updated library', 'https://example.net/?term={query}');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(useSettingsStore.getState().selectionWebSearch.engineId).toBe(firstId);
    expect(screen.getByRole('option', { name: 'Updated library' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add custom engine' }));
    fillCustom('Second engine', 'https://example.com/?q={query}');
    fireEvent.click(screen.getByRole('button', { name: 'Add and use engine' }));
    expect(useSettingsStore.getState().selectionWebSearch.customEngines).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Remove engine' }));
    expect(screen.getByLabelText('Search engine')).toHaveValue('google');
    expect(useSettingsStore.getState().selectionWebSearch.customEngines).toHaveLength(1);
  });

  it('keeps invalid drafts and canceled edits out of saved preferences', () => {
    render(<SelectionWebSearchSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Add custom engine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add and use engine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name');
    fillCustom('Unsafe', 'javascript:alert("{query}")');
    fireEvent.click(screen.getByRole('button', { name: 'Add and use engine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('http:// or https://');
    fillCustom('Missing query', 'https://example.com/search');
    fireEvent.click(screen.getByRole('button', { name: 'Add and use engine' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Add {query}');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useSettingsStore.getState().selectionWebSearch.customEngines).toEqual([]);
  });

  it('persists the preference through the normal settings save path', async () => {
    vi.useFakeTimers();
    try {
      const { saveSettings } = await import('@/opfs/settingsIO');
      render(<SelectionWebSearchSettings />);
      fireEvent.change(screen.getByLabelText('Search engine'), { target: { value: 'duckduckgo' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({
        selectionWebSearch: { engineId: 'duckduckgo', customEngines: [] },
      }));
    } finally { vi.useRealTimers(); }
  });
});
