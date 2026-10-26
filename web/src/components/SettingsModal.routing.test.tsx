import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SettingsModal } from './SettingsModal';

afterEach(() => {
  act(() => useSettingsStore.setState({ openRouterRouting: 'fast-start' }));
});

describe('Settings OpenRouter routing', () => {
  it('defaults to fast start and can switch immediately to cheapest providers', () => {
    act(() => useSettingsStore.setState({
      providers: [{ id: 'router', preset: 'openrouter', apiKey: 'test', enabledModels: [] }], activeModelRef: null, openRouterRouting: 'fast-start',
    }));
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Models and generation' }));
    expect(screen.queryByLabelText('OpenRouter routing')).not.toBeInTheDocument();
    expect(screen.queryByText('Speed, cost, and reasoning')).not.toBeInTheDocument();
    expect(screen.queryByText('Model icons, context, and prices')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'AI providers' }));
    fireEvent.click(screen.getByRole('button', { name: 'OpenRouter connection' }));
    const select = screen.getByLabelText('OpenRouter routing') as HTMLSelectElement;
    expect(select.value).toBe('fast-start');
    fireEvent.change(select, { target: { value: 'lowest-cost' } });
    expect(useSettingsStore.getState().openRouterRouting).toBe('lowest-cost');
  });
});
