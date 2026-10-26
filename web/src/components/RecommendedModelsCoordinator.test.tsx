import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecommendedModelsCoordinator } from './RecommendedModelsCoordinator';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import type { ModelInfo } from '@/providers/types';
import { modelUpdatePreferences, pendingRecommendedRoles, RECOMMENDED_MODELS } from '@/lib/recommendedModels';
import { listSwitchableModels } from '@/store/providerSelectors';
import { saveSettings } from '@/opfs/settingsIO';

const mocks = vi.hoisted(() => ({ list: vi.fn(), images: vi.fn(), busy: vi.fn(() => false) }));
vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(), loadSettings: vi.fn() }));
vi.mock('@/store/bgGen', () => ({ anyProjectGenerating: mocks.busy }));
vi.mock('@/providers/registry', () => ({
  getAdapter: () => ({ listModels: mocks.list }), getImageAdapter: () => ({ listModels: mocks.images }),
  resolveBaseUrl: (_preset: string, base?: string) => base,
}));

function setup() {
  const settings: Settings = { ...DEFAULT_SETTINGS,
    providers: [{ id: 'direct', preset: 'openai', apiKey: 'direct-key', enabledModels: ['main'] },
      { id: 'local', preset: 'custom', apiKey: 'local-key', enabledModels: [] },
      { id: 'unused', preset: 'openrouter', apiKey: 'unused-key', enabledModels: [] }],
    activeModelRef: { providerId: 'direct', model: 'main' },
    secondaryUseSameModel: false, secondaryModelRef: { providerId: 'direct', model: 'old-secondary' },
    interactiveModelRef: { providerId: 'local', model: 'old-local' }, imageModelRef: null,
  };
  useSettingsStore.setState({ ...settings, hydrated: true, forceWelcomeA: false,
    modelRecommendations: modelUpdatePreferences(settings, ['secondary', 'interactive'], true) });
}

function setupMainUpdate() {
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, hydrated: true, forceWelcomeA: false,
    providers: [{ id: 'or', preset: 'openrouter', apiKey: 'or-key', enabledModels: ['old-main', 'extra-main'] },
      { id: 'direct', preset: 'openai', apiKey: 'direct-key', enabledModels: ['other-main'] }],
    activeModelRef: { providerId: 'direct', model: 'other-main' },
    mainModelOrder: [{ providerId: 'direct', model: 'other-main' }, { providerId: 'or', model: 'old-main' }],
    secondaryUseSameModel: false, secondaryModelRef: { providerId: 'direct', model: 'other-main' }, imageModelRef: null,
    modelRecommendations: { main: { autoUpdate: true, ref: { providerId: 'or', model: 'old-main' }, version: 'old' },
      secondary: { autoUpdate: false }, interactive: { autoUpdate: false }, image: { autoUpdate: false } },
  });
  mocks.list.mockResolvedValue([{ id: RECOMMENDED_MODELS.main.id, caps: { vision: true, tools: true } }]);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.busy.mockReturnValue(false);
  mocks.list.mockImplementation(async (key: string) => key === 'direct-key'
    ? [{ id: 'gpt-6-luna' }] : [{ id: 'gpt-6.1-sol', caps: { tools: true, vision: true } }]);
  mocks.images.mockResolvedValue([]);
  useModelCatalogStore.getState().clear();
  useImageModelCatalogStore.getState().clear();
  setup();
});
afterEach(() => { vi.useRealTimers(); });

describe('provider-aware update coordination', () => {
  it('waits for generation to finish, then persists one main model without removing connections or other role assignments', async () => {
    setupMainUpdate();
    vi.useFakeTimers();
    mocks.busy.mockReturnValue(true);
    await act(async () => { render(<RecommendedModelsCoordinator />); });
    expect(listSwitchableModels(useSettingsStore.getState())).toHaveLength(3);
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('other-main');
    mocks.busy.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    const ref = { providerId: 'or', model: RECOMMENDED_MODELS.main.id };
    expect(listSwitchableModels(useSettingsStore.getState())).toEqual([{ ...ref, preset: 'openrouter' }]);
    expect(useSettingsStore.getState().activeModelRef).toEqual(ref);
    expect(useSettingsStore.getState().mainModelOrder).toEqual([ref]);
    expect(useSettingsStore.getState().secondaryModelRef).toEqual({ providerId: 'direct', model: 'other-main' });
    expect(useSettingsStore.getState().providers).toHaveLength(2);
    expect(mocks.list.mock.calls.map(([key]) => key)).toEqual(['or-key']);
    expect(screen.getByRole('status')).toHaveTextContent(RECOMMENDED_MODELS.main.name);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ activeModelRef: ref, mainModelOrder: [ref] }));
  });
  it('preserves a main list edited manually while the catalog request is in flight', async () => {
    setupMainUpdate();
    let finish!: (models: ModelInfo[]) => void;
    mocks.list.mockReturnValue(new Promise<ModelInfo[]>(resolve => { finish = resolve; }));
    render(<RecommendedModelsCoordinator />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    act(() => useSettingsStore.getState().setEnabledModels('or', ['old-main', 'extra-main', 'new-choice']));
    await act(async () => { finish([{ id: RECOMMENDED_MODELS.main.id, caps: { vision: true, tools: true } }]); });
    expect(listSwitchableModels(useSettingsStore.getState())).toHaveLength(4);
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('other-main');
    expect(useSettingsStore.getState().modelRecommendations?.main.autoUpdate).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('checks each enrolled connection and never uses an unrelated OpenRouter key', async () => {
    render(<RecommendedModelsCoordinator />);
    await waitFor(() => expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('gpt-6-luna'));
    expect(useSettingsStore.getState().interactiveModelRef).toEqual({ providerId: 'local', model: 'gpt-6.1-sol' });
    expect(mocks.list.mock.calls.map(([key]) => key)).toEqual(['direct-key', 'local-key']);
    expect(mocks.images).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Recommended models updated');
  });
  it('does not replace a model from stale metadata after its catalog refresh fails', async () => {
    useModelCatalogStore.getState().setCatalog('direct', [{ id: 'gpt-6-luna' }], 0);
    mocks.list.mockRejectedValue(new Error('Offline'));
    render(<RecommendedModelsCoordinator />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('could not be verified'));
    expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('old-secondary');
    expect(useSettingsStore.getState().interactiveModelRef?.model).toBe('old-local');
  });
  it('waits for active generations before replacing models', async () => {
    vi.useFakeTimers();
    mocks.busy.mockReturnValue(true);
    await act(async () => { render(<RecommendedModelsCoordinator />); });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('old-secondary');
    mocks.busy.mockReturnValue(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('gpt-6-luna');
  });
  it.each(['connection changed', 'updates disabled'] as const)('ignores in-flight results after %s', async change => {
    let finish!: (models: ModelInfo[]) => void;
    const deferred = new Promise<ModelInfo[]>(resolve => { finish = resolve; });
    mocks.list.mockImplementation((key: string) => key === 'direct-key' ? deferred : Promise.resolve([]));
    render(<RecommendedModelsCoordinator />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    act(() => {
      if (change === 'connection changed') useSettingsStore.getState().updateProvider('direct', { apiKey: 'different-key' });
      else useSettingsStore.getState().setModelAutoUpdate('secondary', false);
    });
    await act(async () => { finish([{ id: 'gpt-6-luna' }]); });
    expect(useSettingsStore.getState().secondaryModelRef?.model).toBe('old-secondary');
  });
  it('persists a successful same-model check without repeating it or claiming a replacement', async () => {
    const state = useSettingsStore.getState();
    const next = { ...state, secondaryModelRef: { providerId: 'direct', model: 'gpt-6-luna' } };
    useSettingsStore.setState({ ...next, modelRecommendations: {
      ...modelUpdatePreferences(next, ['secondary'], true), interactive: { autoUpdate: false },
    } });
    render(<RecommendedModelsCoordinator />);
    await waitFor(() => expect(pendingRecommendedRoles(useSettingsStore.getState())).toEqual([]));
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
