import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJSON } from '@/opfs/storage';
import { applySettingsUiPreferences } from '@/lib/settingsTransfer';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { defaultSyncConfig, defaultSyncLedger } from '@/sync/local';
import { DEFAULT_SETTINGS } from '@/store/types';
import { settingsSnapshot } from '@/store/settingsSnapshot';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useImageModelCatalogStore } from '@/store/useImageModelCatalogStore';
import { MODEL_ROLES, RECOMMENDED_MODELS } from '@/lib/recommendedModels';
import { readOnboardingSession, saveOnboardingSession } from '@/lib/onboardingSession';
import { initializeSyncCoordinator, restoreSetupFromSync } from '@/sync/coordinator';
import { applySyncedPreferences, createSyncedPreferences } from '@/sync/preferences';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import { WelcomeScreenA } from './WelcomeScreenA';

vi.mock('@/opfs/storage', async (original) => ({
  ...await original<typeof import('@/opfs/storage')>(), writeJSON: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/settingsTransfer', async (original) => ({
  ...await original<typeof import('@/lib/settingsTransfer')>(), applySettingsUiPreferences: vi.fn(),
}));
vi.mock('@/providers/registry', async (original) => ({
  ...await original<typeof import('@/providers/registry')>(),
  getAdapter: () => ({ listModels: async () => [
    { id: 'test-model', caps: { vision: true, tools: true } },
    ...MODEL_ROLES.filter(role => role !== 'image').map(role => ({ id: RECOMMENDED_MODELS[role].id, caps: { vision: true, tools: true } })),
  ] }),
  getImageAdapter: () => ({ edit: vi.fn(), listModels: async () => [{ id: RECOMMENDED_MODELS.image.id, supportsImageEditing: true }, { id: 'openai/gpt-image-2', supportsImageEditing: true }] }),
}));
vi.mock('@/lib/openRouterAccount', () => ({ readOpenRouterAccount: vi.fn(async () => ({ limit: null })), openRouterKeyLinks: vi.fn(async () => ({})) }));
vi.mock('@/lib/openRouterConnect', () => ({ beginOpenRouterConnection: vi.fn(async () => undefined) }));
vi.mock('@/sync/coordinator', async original => ({
  ...await original<typeof import('@/sync/coordinator')>(), initializeSyncCoordinator: vi.fn(async () => () => {}),
  restoreSetupFromSync: vi.fn(),
}));
vi.mock('@/sync/providers/googleDrive', async original => ({
  ...await original<typeof import('@/sync/providers/googleDrive')>(), googleDriveTokenNeedsRefresh: () => false,
}));

const exported = (overrides = {}) => JSON.stringify({
  format: 'scatter-settings', formatVersion: 1,
  settings: {
    providers: [{ id: 'restored', preset: 'openrouter', apiKey: 'test-key', enabledModels: ['test-model'] }],
    activeModelRef: { providerId: 'restored', model: 'test-model' },
    outputTokenCap: 24000,
  },
  uiPreferences: { theme: 'light' }, ...overrides,
});
function pick(contents: string) {
  const file = new File([contents], 'scatter-settings.json', { type: 'application/json' });
  // jsdom File does not implement the browser's Blob.text() in every runtime.
  Object.defineProperty(file, 'text', { value: async () => contents });
  fireEvent.change(screen.getByLabelText('Settings file'), { target: { files: [file] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.dataset.theme = 'latte';
  document.documentElement.dataset.themePreference = 'system';
  useModelCatalogStore.getState().clear();
  useImageModelCatalogStore.getState().clear();
  vi.mocked(writeJSON).mockResolvedValue(undefined);
  useSettingsStore.setState({ ...settingsSnapshot(DEFAULT_SETTINGS), hydrated: true, forceWelcomeA: true });
  useSyncStore.setState({ hydrated: true, config: defaultSyncConfig(), ledger: defaultSyncLedger() });
  // jsdom reports full-page reload as unimplemented; the browser test checks it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('onboarding settings import', () => {
  it.each(['google-drive', 'webdav'] as const)('unlocks onboarding after a failed %s restore and allows retry or another setup method', async provider => {
    useSyncStore.setState({ running: false, error: null, config: { ...defaultSyncConfig(), provider,
      webdav: { baseUrl: 'https://test.invalid', username: 'test', appPassword: 'test', folder: 'test' } } });
    vi.mocked(restoreSetupFromSync).mockRejectedValueOnce(new Error('Cloud settings could not be downloaded.'));
    render(<WelcomeScreenA />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore from sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved setup' }));
    await screen.findByText('Cloud settings could not be downloaded.');
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restore saved setup' })).toBeEnabled();

    vi.mocked(restoreSetupFromSync).mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved setup' }));
    await screen.findByText(/The sync request did not finish in time/);
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: /Quick setup/ })).toBeEnabled();
    expect(restoreSetupFromSync).toHaveBeenCalledTimes(2);
  });

  it.each(['google-drive', 'webdav'] as const)('recognizes opted-in API keys restored from %s and skips reconnecting providers', async provider => {
    const source = { ...DEFAULT_SETTINGS, syncApiKeys: true,
      providers: [{ id: 'restored', preset: 'openrouter' as const, apiKey: 'test-key', enabledModels: ['test-model'] }],
      activeModelRef: { providerId: 'restored', model: 'test-model' } };
    const preferences = createSyncedPreferences(source, []);
    vi.mocked(restoreSetupFromSync).mockImplementationOnce(() => applySyncedPreferences(preferences));
    useSyncStore.setState({ config: { ...defaultSyncConfig(), provider,
      webdav: { baseUrl: 'https://test.invalid', username: 'test', appPassword: 'test', folder: 'test' } } });
    render(<WelcomeScreenA />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore from sync' }));
    expect(screen.getByText(/API keys are restored if/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved setup' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(useSettingsStore.getState().providers[0]?.apiKey).toBe('test-key');
    expect(useSettingsStore.getState().syncApiKeys).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reconnect OpenRouter' })).toBeNull();
    expect(readOnboardingSession()).toMatchObject({ path: 'restore', step: 'review', restoreSync: true });
  });

  it('still requests missing provider keys when key syncing was disabled', async () => {
    const preferences = createSyncedPreferences({ ...DEFAULT_SETTINGS,
      providers: [{ id: 'restored', preset: 'openrouter', apiKey: 'test-key', enabledModels: ['test-model'] }],
      activeModelRef: { providerId: 'restored', model: 'test-model' } }, []);
    vi.mocked(restoreSetupFromSync).mockImplementationOnce(() => applySyncedPreferences(preferences));
    useSyncStore.setState({ config: { ...defaultSyncConfig(), provider: 'google-drive' } });
    render(<WelcomeScreenA />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore from sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved setup' }));
    expect(await screen.findByRole('heading', { name: 'Settings restored' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect OpenRouter' })).toBeInTheDocument();
    expect(useSettingsStore.getState().providers[0]?.apiKey).toBe('');
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('test-model');
  });
  it('opens a JSON file picker instead of the unsupported placeholder', () => {
    render(<WelcomeScreenA />);
    const input = screen.getByLabelText('Settings file') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Import settings file' }));
    expect(click).toHaveBeenCalledOnce();
    expect(input.accept).toBe('.json,application/json');
  });

  it('persists validated settings before activating them and applies UI preferences', async () => {
    let finishSave!: () => void;
    vi.mocked(writeJSON).mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    render(<WelcomeScreenA />);
    pick(exported());
    await waitFor(() => expect(writeJSON).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Importing settings…' })).toBeDisabled();
    expect(useSettingsStore.getState().providers).toEqual([]);
    expect(applySettingsUiPreferences).not.toHaveBeenCalled();
    await act(async () => finishSave());
    await waitFor(() => expect(useSettingsStore.getState().providers[0]?.id).toBe('restored'));
    expect(useSettingsStore.getState().activeModelRef).toEqual({ providerId: 'restored', model: 'test-model' });
    expect(useSettingsStore.getState().outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap); // Legacy export has no defaults baseline.
    expect(useSettingsStore.getState().forceWelcomeA).toBe(true);
    expect(applySettingsUiPreferences).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    const confirmations = screen.getAllByRole('checkbox');
    expect(confirmations).toHaveLength(1);
    const confirmation = screen.getByRole('checkbox', { name: 'I confirm and accept all statements above.' });
    expect(confirmation).not.toBeChecked();
    expect(confirmation).toHaveAccessibleDescription(/I confirm that I am 18 or older/);
    expect(confirmation).toHaveAccessibleDescription(/I understand that AI models can hallucinate/);
    expect(confirmation).toHaveAccessibleDescription(/token usage, provider charges/);
    fireEvent.click(confirmation);
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
    fireEvent.click(confirmation);
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(useSettingsStore.getState().forceWelcomeA).toBe(false));
    expect(readOnboardingSession()).toBeNull();
    expect(initializeSyncCoordinator).toHaveBeenCalledOnce();
  });

  it('requires a fresh acknowledgment after reloading the final step', () => {
    saveOnboardingSession('custom', 'confirm');
    const view = render(<WelcomeScreenA />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'I confirm and accept all statements above.' }));
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled();
    view.unmount();
    render(<WelcomeScreenA />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    expect(initializeSyncCoordinator).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', 'not JSON', 'doesn’t look like a Scatter settings export'],
    ['wrong file', '{"nodes":[]}', 'doesn’t look like a Scatter settings export'],
    ['newer export', exported({ formatVersion: 99 }), 'newer Scatter version'],
  ])('shows a helpful error for %s without replacing settings', async (_name, raw, error) => {
    render(<WelcomeScreenA />);
    pick(raw);
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
    expect(writeJSON).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().providers).toEqual([]);
    expect(screen.getByRole('button', { name: 'Import settings file' })).toBeEnabled();
  });

  it('leaves onboarding and settings intact when saving fails, and allows retry', async () => {
    vi.mocked(writeJSON).mockRejectedValueOnce(new Error('Disk full'));
    render(<WelcomeScreenA />);
    pick(exported());
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(useSettingsStore.getState().providers).toEqual([]);
    expect(useSettingsStore.getState().forceWelcomeA).toBe(true);
    expect(applySettingsUiPreferences).not.toHaveBeenCalled();
    pick(exported());
    await waitFor(() => expect(applySettingsUiPreferences).toHaveBeenCalledOnce());
    expect(vi.mocked(writeJSON).mock.calls.filter(([path]) => path === 'settings.json')).toHaveLength(1);
  });

  it('does nothing when the file chooser is cancelled', () => {
    render(<WelcomeScreenA />);
    fireEvent.change(screen.getByLabelText('Settings file'), { target: { files: [] } });
    expect(writeJSON).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('restores a credential-free file and keeps its models while asking to reconnect', async () => {
    const raw = JSON.parse(exported());
    raw.settings.providers[0].apiKey = '';
    render(<WelcomeScreenA />);
    pick(JSON.stringify(raw));
    expect(await screen.findByRole('heading', { name: 'Settings restored' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect OpenRouter' })).toBeInTheDocument();
    expect(useSettingsStore.getState().providers[0]).toMatchObject({ apiKey: '', enabledModels: ['test-model'] });
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('test-model');
    expect(useSettingsStore.getState().forceWelcomeA).toBe(true);
    expect(readOnboardingSession()).toMatchObject({ path: 'restore', step: 'connect', restoreSync: false });
    act(() => useSettingsStore.getState().updateProvider('restored', { apiKey: 'reconnected-key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review restored setup' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('test-model');
  });

  it('resumes a sync restoration after authorization without applying quick-setup models', async () => {
    saveOnboardingSession('restore', 'review', { restoreSync: true });
    useSettingsStore.setState({ providers: [{ id: 'restored', preset: 'openrouter', apiKey: 'test-key', enabledModels: ['test-model'] }],
      activeModelRef: { providerId: 'restored', model: 'test-model' } });
    render(<WelcomeScreenA />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('test-model');
    expect(readOnboardingSession()).toMatchObject({ path: 'restore', restoreSync: true });
  });

  it('assigns all four recommendations once and leaves later manual choices alone', async () => {
    saveOnboardingSession('quick', 'review');
    useSettingsStore.setState({ providers: [{ id: 'or', preset: 'openrouter', apiKey: 'test-key', enabledModels: [] }] });
    render(<WelcomeScreenA />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    const state = useSettingsStore.getState();
    expect(state.activeModelRef?.model).toBe(RECOMMENDED_MODELS.main.id);
    expect(state.secondaryModelRef?.model).toBe(RECOMMENDED_MODELS.secondary.id);
    expect(state.interactiveModelRef?.model).toBe(RECOMMENDED_MODELS.interactive.id);
    expect(state.imageModelRef?.model).toBe(RECOMMENDED_MODELS.image.id);
    expect(screen.queryByRole('checkbox', { name: 'Enable' })).not.toBeInTheDocument();
    expect(MODEL_ROLES.every(role => state.modelRecommendations?.[role].autoUpdate)).toBe(true);
    act(() => { state.setEnabledModels('or', ['test-model']); state.setActiveModel('or', 'test-model'); });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use existing OpenRouter connection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(useSettingsStore.getState().activeModelRef?.model).toBe('test-model');
    expect(useSettingsStore.getState().modelRecommendations?.main.autoUpdate).toBe(false);
  });
});

describe('onboarding copy and entry controls', () => {
  it('explains later provider changes and omits settings-only guidance from onboarding', () => {
    render(<WelcomeScreenA />);
    expect(screen.getByText('You can change models or add more API providers later.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick setup/ })).toHaveAttribute('data-tip', 'Set up OpenRouter with recommended models');
    expect(screen.getByRole('button', { name: /Choose your own models/ })).toHaveAttribute('data-tip', 'Set up your own providers and models');
    fireEvent.click(screen.getByRole('button', { name: /Choose your own models/ }));
    expect(screen.getByRole('table', { name: 'Recommended model roles' })).toBeInTheDocument();
    expect(screen.queryByText(/Assign your connected models in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Verify facts and labels/)).not.toBeInTheDocument();
  });

  it.each([
    { preset: 'openrouter', apiKey: 'test-key' },
    { preset: 'openrouter', apiKey: '' },
    { preset: 'openai', apiKey: 'test-key' },
  ] as const)('omits the setup credit notice ($preset / $apiKey)', async ({ preset, apiKey }) => {
    saveOnboardingSession('custom', 'review');
    useSettingsStore.setState({ providers: [{ id: 'provider', preset, apiKey, enabledModels: [] }] });
    render(<WelcomeScreenA />);
    await screen.findByRole('heading', { name: 'Review model configuration' });
    expect(screen.queryByText('Setup does not spend credits.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Paid models require OpenRouter credits/)).not.toBeInTheDocument();
  });

  it('replaces the static rail summary with the shared theme button without changing the setup step', () => {
    const { container } = render(<WelcomeScreenA />);
    expect(container.querySelector('.onboarding-rail-note')).toBeNull();
    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(button).toHaveClass('icon-btn');
    expect(button.closest('.onboarding-theme-control')).not.toBeNull();
    fireEvent.click(button);
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(document.documentElement.dataset.theme).toBe('mocha');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('heading', { name: 'Configure AI models' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Quick setup/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('latte');
    expect(screen.getByRole('heading', { name: 'Connect OpenRouter' })).toBeInTheDocument();
    expect(readOnboardingSession()).toMatchObject({ path: 'quick', step: 'connect' });
  });
  it('uses descriptive setup language without marketing slogans', () => {
    render(<WelcomeScreenA />);
    expect(screen.getByRole('heading', { name: 'Configure AI models' })).toBeInTheDocument();
    expect(screen.getByText('Model configuration', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Use recommended models, configure providers manually, or restore an existing setup.')).toBeInTheDocument();
    expect(screen.queryByText(/curiosity/i)).not.toBeInTheDocument();
  });

  it('emphasizes model roles and identifies the two free-image catalogs', async () => {
    saveOnboardingSession('quick', 'review');
    useSettingsStore.setState({ providers: [{ id: 'or', preset: 'openrouter', apiKey: 'test-key', enabledModels: [] }] });
    render(<WelcomeScreenA />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByText('Automatic model updates', { selector: 'summary' }));
    for (const role of MODEL_ROLES) {
      expect(screen.getByText(role, { selector: 'strong', exact: true })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: new RegExp(`Keep ${role} model updated`) })).toBeChecked();
    }
    fireEvent.click(screen.getByText('Automatic activity', { selector: 'summary' }));
    const imageToggle = screen.getByRole('switch', { name: /Search for free images automatically/ });
    expect(imageToggle).not.toBeChecked();
    expect(imageToggle).toHaveAccessibleName(/Wikimedia Commons and Openverse/);
    expect(imageToggle).toHaveAccessibleName(/secondary model generates search queries and reviews results/);
    expect(screen.queryByText(/image licenses are separate/i)).not.toBeInTheDocument();
  });

  it.each([
    { preset: 'openrouter', apiKey: '', visible: false },
    { preset: 'openrouter', apiKey: '   ', visible: false },
    { preset: 'openai', apiKey: 'test-key', visible: false },
    { preset: 'openrouter', apiKey: 'test-key', visible: true },
  ] as const)('offers an existing connection only for a saved OpenRouter key ($preset / $visible)', ({ preset, apiKey, visible }) => {
    useSettingsStore.setState({ providers: [{ id: 'provider', preset, apiKey, enabledModels: [] }] });
    render(<WelcomeScreenA />);
    fireEvent.click(screen.getByRole('button', { name: /Quick setup/ }));
    const button = screen.queryByRole('button', { name: 'Use existing OpenRouter connection' });
    if (visible) expect(button).toBeInTheDocument();
    else expect(button).not.toBeInTheDocument();
  });

  it('does not offer a return shortcut during first-time setup', () => {
    render(<WelcomeScreenA />);
    expect(screen.queryByRole('button', { name: 'Return to app' })).not.toBeInTheDocument();
  });

  it.each([true, false])('offers return for an existing model without an onboarding session, irrespective of forceWelcomeA=%s', (forceWelcomeA) => {
    useSettingsStore.setState({ activeModelRef: { providerId: 'existing', model: 'test-model' }, forceWelcomeA });
    render(<WelcomeScreenA />);
    expect(screen.getByRole('button', { name: 'Return to app' })).toBeInTheDocument();
  });

  it('does not offer return when resuming unfinished setup, even with a model selected', () => {
    useSettingsStore.setState({ activeModelRef: { providerId: 'existing', model: 'test-model' } });
    saveOnboardingSession('restore', 'connect');
    render(<WelcomeScreenA />);
    expect(screen.queryByRole('button', { name: 'Return to app' })).not.toBeInTheDocument();
  });
});
