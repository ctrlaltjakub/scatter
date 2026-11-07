import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SidebarModelPicker } from './SidebarModelPicker';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';

afterEach(() => {
  act(() => {
    useSettingsStore.setState({ providers: [], activeModelRef: null, webSearch: false, modelCompatibilityOverrides: {} });
  });
  vi.restoreAllMocks();
});

describe('SidebarModelPicker web-search control', () => {
  it.each(['openai', 'anthropic', 'ollama', 'lm-studio'] as const)('toggles search permission on and off for %s', (preset) => {
    vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockResolvedValue([]);
    const model = preset === 'openai' ? 'gpt-6.1-sol' : 'test-model';
    act(() => {
      useSettingsStore.setState({ providers: [{ id: 'search-test', preset, apiKey: 'test', enabledModels: [model],
        webSearchEndpoint: 'http://localhost:8080' }], activeModelRef: { providerId: 'search-test', model }, webSearch: false });
      useModelCatalogStore.getState().setCatalog('search-test', [{ id: model, caps: { vision: true, tools: true } }]);
    });
    render(<SidebarModelPicker />);
    const button = screen.getByRole('button', { name: 'Allow web search for generation' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(useSettingsStore.getState().webSearch).toBe(true);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(button);
    expect(useSettingsStore.getState().webSearch).toBe(false);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
  it('allows switching to manually selected unverified models without inventing web-search support', () => {
    vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockResolvedValue([]);
    useSettingsStore.setState({ providers: [{ id: 'local', preset: 'custom', apiKey: 'test', enabledModels: ['model-a', 'model-b'] }],
      activeModelRef: { providerId: 'local', model: 'model-a' }, modelCompatibilityOverrides: { main: true } });
    render(<SidebarModelPicker />);
    fireEvent.click(screen.getByRole('button', { name: 'model a' }));
    fireEvent.click(screen.getByRole('button', { name: 'model b' }));
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('model-b');
    expect(screen.getByRole('button', { name: 'Allow web search for generation' })).toBeDisabled();
  });
  it('links to model settings when exactly one model is visible, even if an incompatible saved entry is hidden', () => {
    vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockResolvedValue([]);
    const onManageModels = vi.fn();
    useSettingsStore.setState({ providers: [{ id: 'one', preset: 'custom', apiKey: 'test', enabledModels: ['active', 'hidden'] }],
      activeModelRef: { providerId: 'one', model: 'active' }, modelCompatibilityOverrides: {} });
    render(<SidebarModelPicker onManageModels={onManageModels} />);
    fireEvent.click(screen.getByRole('button', { name: 'active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Models and generation' }));
    expect(onManageModels).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Models and generation' })).toBeNull();
  });

  it('describes search as permission rather than a guarantee', () => {
    act(() => {
      useSettingsStore.setState({
        providers: [{
          id: 'or', preset: 'openrouter', apiKey: 'test',
          enabledModels: ['google/gemini-3.5-flash'],
        }],
        activeModelRef: { providerId: 'or', model: 'google/gemini-3.5-flash' },
        webSearch: true,
      });
    });

    const { container } = render(<SidebarModelPicker />);
    const button = container.querySelector('[aria-label="Allow web search for generation"]');
    expect(button?.getAttribute('data-tip')).toBe('Allow web search: ON');
  });
});
