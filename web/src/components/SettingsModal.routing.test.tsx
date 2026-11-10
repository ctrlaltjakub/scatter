import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { SettingsModal } from './SettingsModal';

afterEach(() => {
  act(() => useSettingsStore.setState({ openRouterRouting: DEFAULT_SETTINGS.openRouterRouting }));
});

describe('Settings OpenRouter routing', () => {
  it('selects the second option by default and can still switch to fast start', () => {
    act(() => useSettingsStore.setState({
      providers: [{ id: 'router', preset: 'openrouter', apiKey: 'test', enabledModels: [] }], activeModelRef: null, openRouterRouting: DEFAULT_SETTINGS.openRouterRouting,
    }));
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Models and generation' }));
    expect(screen.queryByLabelText('OpenRouter routing')).not.toBeInTheDocument();
    expect(screen.queryByText('Speed, cost, and reasoning')).not.toBeInTheDocument();
    expect(screen.queryByText('Model icons, context, and prices')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'AI providers' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenRouter connection' }));
    const select = screen.getByLabelText('OpenRouter routing') as HTMLSelectElement;
    expect(Array.from(select.options, option => option.text)).toEqual(['Fast start — lowest wait for first text', 'Cheapest providers']);
    expect(select.selectedIndex).toBe(1);
    expect(select.value).toBe('lowest-cost');
    fireEvent.change(select, { target: { value: 'fast-start' } });
    expect(useSettingsStore.getState().openRouterRouting).toBe('fast-start');
  });
});
