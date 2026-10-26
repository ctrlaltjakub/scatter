import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MainModelLibrary } from './MainModelLibrary';
import { SecondaryTaskModelPicker } from '../SecondaryTaskModelPicker';
import { InteractiveModelPicker } from '../InteractiveModelPicker';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { listSwitchableModels } from '@/store/providerSelectors';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
const catalogs = {
  openai: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.6-sol' }, { id: 'gpt-4o' }],
  anthropic: [{ id: 'claude-sonnet-4-6' }],
};
beforeEach(() => {
  useModelCatalogStore.getState().clear();
  useSettingsStore.setState({
    ...DEFAULT_SETTINGS,
    mainModelOrder: undefined,
    providers: [
      { id: 'openai', preset: 'openai', apiKey: 'test', enabledModels: ['gpt-5.6-luna'] },
      { id: 'anthropic', preset: 'anthropic', apiKey: 'test', enabledModels: ['claude-sonnet-4-6'] },
    ],
    activeModelRef: { providerId: 'openai', model: 'gpt-5.6-luna' },
    secondaryModelRef: { providerId: 'openai', model: 'gpt-5.6-sol' },
    interactiveModelRef: { providerId: 'anthropic', model: 'claude-sonnet-4-6' },
  });
  vi.spyOn(useModelCatalogStore.getState(), 'refreshCatalog').mockImplementation(async (id) => {
    const models = catalogs[id as keyof typeof catalogs] ?? [];
    useModelCatalogStore.getState().setCatalog(id, models);
    return models;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('main model library', () => {
  it('allows unverified main models only with the per-role override, including keyboard cycling', async () => {
    vi.mocked(useModelCatalogStore.getState().refreshCatalog).mockImplementation(async () => []);
    useSettingsStore.setState({ providers: [{ id: 'local', preset: 'custom', apiKey: 'test', enabledModels: [] }], activeModelRef: null });
    useModelCatalogStore.getState().setCatalog('local', [{ id: 'unknown-a' }, { id: 'unknown-b' }]);
    const { unmount } = render(<MainModelLibrary />);
    const available = screen.getByRole('list', { name: 'Available main models' });
    expect(within(available).queryByRole('button', { name: /^unknown/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage provider API keys →' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    fireEvent.click(within(available).getByRole('button', { name: /^unknown-a/ }));
    fireEvent.click(within(available).getByRole('button', { name: /^unknown-b/ }));
    act(() => useSettingsStore.getState().cycleModel(1));
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('unknown-b');
    expect(useSettingsStore.getState().modelCompatibilityOverrides).toEqual({ main: true });
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    expect(within(available).queryByRole('button', { name: /^unknown/ })).not.toBeInTheDocument();
    expect(useSettingsStore.getState().providers[0]?.enabledModels).toEqual(['unknown-a', 'unknown-b']);
    unmount();
    render(<MainModelLibrary />);
    expect(screen.getByRole('switch', { name: /Show all models/ })).not.toBeChecked();
  });

  it('keeps secondary filtering independent of the main-model override', async () => {
    useSettingsStore.setState({ modelCompatibilityOverrides: { main: true } });
    render(<SecondaryTaskModelPicker settingsLayout />);
    await screen.findByRole('option', { name: /^gpt-5.6-sol/ });
    expect(screen.queryByRole('option', { name: /^gpt-4o/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: /Show all models/ }));
    fireEvent.click(screen.getByRole('option', { name: /^gpt-4o/ }));
    expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('gpt-4o');
    expect(useSettingsStore.getState().modelCompatibilityOverrides).toEqual({ main: true, secondary: true });
  });
  it('makes a confirmed local model selectable with search, and keeps it out after search is disconnected', async () => {
    vi.mocked(useModelCatalogStore.getState().refreshCatalog).mockImplementation(async () => []);
    const provider = { id: 'local', preset: 'ollama' as const, apiKey: 'local', enabledModels: [] as string[], webSearchEndpoint: 'https://search.test' };
    useSettingsStore.setState({ providers: [provider], activeModelRef: null });
    useModelCatalogStore.getState().setCatalog('local', [{ id: 'local-vlm', caps: { vision: true, tools: true } }, { id: 'text-only', caps: { vision: false, tools: true } }]);
    render(<MainModelLibrary />);
    const available = screen.getByRole('list', { name: 'Available main models' });
    fireEvent.click(await within(available).findByRole('button', { name: /^local-vlm/ }));
    expect(useSettingsStore.getState().providers[0]?.enabledModels).toEqual(['local-vlm']);
    expect(within(available).queryByRole('button', { name: /^text-only/ })).not.toBeInTheDocument();
    act(() => useSettingsStore.getState().updateProvider('local', { webSearchEndpoint: undefined }));
    expect(within(available).queryByRole('button', { name: /^local-vlm/ })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Selected main models' })).toHaveTextContent('Saved choice · required capabilities not confirmed');
  });
  it('selects multiple providers, keeps selections above search, and shares ordering with keyboard cycling', async () => {
    render(<MainModelLibrary />);
    const available = screen.getByRole('list', { name: 'Available main models' });
    await waitFor(() =>
      expect(within(available).getByRole('button', { name: /^gpt-5.6-sol/ })).toBeInTheDocument(),
    );
    expect(within(available).queryByRole('button', { name: /^gpt-4o/ })).not.toBeInTheDocument();
    fireEvent.click(within(available).getByRole('button', { name: /^gpt-5.6-sol/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Move gpt-5.6-sol up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move gpt-5.6-sol up' }));
    expect(listSwitchableModels(useSettingsStore.getState()).map((ref) => ref.model)).toEqual([
      'gpt-5.6-sol',
      'claude-sonnet-4-6',
      'gpt-5.6-luna',
    ]);
    act(() => useSettingsStore.getState().cycleModel(1));
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('gpt-5.6-sol');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no-match' } });
    const selected = screen.getByRole('list', { name: 'Selected main models' });
    expect(within(selected).getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Remove gpt-5.6-sol from main models' }));
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('claude-sonnet-4-6');
    expect(useSettingsStore.getState().mainModelOrder).not.toContainEqual({
      providerId: 'openai',
      model: 'gpt-5.6-sol',
    });
  });
  it('shows a single secondary choice outside search and removes it without clearing main choices', async () => {
    render(<SecondaryTaskModelPicker settingsLayout />);
    await screen.findByRole('option', { name: /^gpt-5.6-sol/ });
    expect(screen.queryByRole('option', { name: /^gpt-4o/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing' } });
    expect(screen.getByLabelText('Selected secondary model')).toHaveTextContent('gpt-5.6-sol');
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected secondary model' }));
    expect(useSettingsStore.getState().secondaryModelRef).toBeUndefined();
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('gpt-5.6-luna');
  });
  it('removes an interactive override and returns to the main model', () => {
    render(<InteractiveModelPicker settingsLayout />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected interactive model' }));
    expect(useSettingsStore.getState().interactiveModelRef).toBeUndefined();
    expect(screen.getByLabelText('Selected interactive model')).toHaveTextContent('Use main text model');
  });
});
