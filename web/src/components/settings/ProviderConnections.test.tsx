import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvidersTab, SettingsModal } from '../SettingsModal';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [], activeModelRef: null }));

describe('provider connections', () => {
  it.each([false, true])('keeps the local guide last throughout connection setup (onboarding: %s)', (onboarding) => {
    render(<ProvidersTab onboarding={onboarding} />);
    const chooser = screen.getByLabelText('Choose a provider');
    for (const preset of ['ollama', 'lm-studio', 'custom']) {
      fireEvent.change(chooser, { target: { value: preset } });
      const link = screen.getByRole('button', { name: 'Local providers: connection guide' });
      expect(link.closest('.settings-add-provider')?.lastElementChild).toBe(link);
    }
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    const link = screen.getByRole('button', { name: 'Local providers: connection guide' });
    const body = link.closest('.settings-provider-body');
    expect(body?.lastElementChild).toBe(link);
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:1234/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'local' } });
    for (const mode of ['lmstudio-mcp', 'responses-mcp', 'localai', 'searxng']) {
      fireEvent.change(screen.getByLabelText('Search connection'), { target: { value: mode } });
      expect(body?.lastElementChild).toBe(link);
      expect(within(body as HTMLElement).getAllByRole('button', { name: 'Local providers: connection guide' })).toHaveLength(1);
    }
    for (const preset of ['ollama', 'lm-studio', 'custom']) {
      fireEvent.change(screen.getByLabelText('Provider'), { target: { value: preset } });
      expect(body?.lastElementChild).toBe(link);
    }
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } });
    expect(screen.queryByRole('button', { name: 'Local providers: connection guide' })).not.toBeInTheDocument();
  });
  it('retains saved Gemini connections but explains why direct integration is disabled', () => {
    useSettingsStore.getState().addProvider('gemini');
    render(<ProvidersTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Google Gemini connection' }));
    expect(screen.getByText(/Direct Gemini API integration is disabled/)).toHaveTextContent('terms are too restrictive');
    expect(screen.getByText('Disabled', { exact: true })).toBeInTheDocument();
    expect(useSettingsStore.getState().providers[0]?.preset).toBe('gemini');
    expect(within(screen.getByLabelText('Provider')).getByRole('option', { name: 'Google Gemini' })).toBeDisabled();
  });
  it.each([false, true])('adds new connections above existing ones (onboarding: %s)', (onboarding) => {
    const settings = useSettingsStore.getState();
    const openrouter = settings.addProvider('openrouter');
    const openai = settings.addProvider('openai');
    const existingOrder = useSettingsStore.getState().providers.map(provider => provider.id);
    useSettingsStore.setState({ activeModelRef: { providerId: openrouter, model: 'existing-model' } });
    render(<ProvidersTab onboarding={onboarding} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByLabelText('Choose a provider'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    const connections = screen.getAllByRole('button', { name: / connection$/ });
    expect(connections.map(button => button.getAttribute('aria-label'))).toEqual([
      'Anthropic connection', 'OpenAI connection', 'OpenRouter connection',
    ]);
    expect(connections[0]).toHaveAttribute('aria-expanded', 'true');
    expect(useSettingsStore.getState().providers.slice(1).map(provider => provider.id)).toEqual(existingOrder);
    expect(useSettingsStore.getState().activeModelRef).toEqual({ providerId: openrouter, model: 'existing-model' });
    expect(settings.addProvider('openai')).toBe(openai);
    expect(useSettingsStore.getState().providers[0]?.preset).toBe('anthropic');
  });
  it.each([false, true])('lists OpenRouter first when choosing a provider (onboarding: %s)', (onboarding) => {
    render(<ProvidersTab onboarding={onboarding} />);
    const select = screen.getByLabelText('Choose a provider');
    expect(within(select).getAllByRole('option')[0]).toHaveValue('openrouter');
    expect(within(select).getAllByRole('option')[0]).toHaveTextContent('OpenRouter (model aggregator)');
    expect(select).toHaveValue('openrouter');
    expect(within(select).getByRole('option', { name: 'Google Gemini — currently disabled due to too restrictive terms and conditions' })).toBeDisabled();
  });
  it('keeps an already-connected OpenRouter first but disabled', () => {
    useSettingsStore.getState().addProvider('openrouter');
    render(<ProvidersTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    const select = screen.getByLabelText('Choose a provider');
    const first = within(select).getAllByRole('option')[0];
    expect(first).toHaveValue('openrouter');
    expect(first).toBeDisabled();
    expect(select).toHaveValue('openai');
  });
  it('explains all four roles below the connections, including the optional image model', () => {
    useSettingsStore.getState().addProvider('openrouter');
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI providers' }));
    const table = screen.getByRole('table', { name: 'Recommended model roles' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual([
      'https://artificialanalysis.ai/evaluations/omniscience',
      'https://artificialanalysis.ai/#intelligence-comparison-tabs',
      'https://artificialanalysis.ai/agents/coding-agents',
      'https://artificialanalysis.ai/#media-leaderboards-tabs',
    ]);
    expect(table).toHaveTextContent('Vision is required');
    expect(table).toHaveTextContent('Image editing is required');
    for (const role of ['Main models', 'Secondary tasks', 'Interactive nodes', 'Image generation Optional']) {
      expect(within(table).getByRole('rowheader', { name: role })).toBeInTheDocument();
    }
    const connection = screen.getByRole('button', { name: 'OpenRouter connection' });
    expect(connection.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/AI image generation and modification are disabled/)).toBeInTheDocument();
    expect(screen.getByText(/Assign your connected models in/)).toBeInTheDocument();
    expect(screen.queryByText(/Verify facts and labels/)).not.toBeInTheDocument();
  });
  it.each(['openrouter', 'openai', 'anthropic', 'gemini'] as const)('prevents duplicate %s connections, including preset changes', (preset) => {
    const settings = useSettingsStore.getState();
    const original = settings.addProvider(preset);
    expect(settings.addProvider(preset)).toBe(original);
    const custom = settings.addProvider('custom');
    settings.updateProvider(custom, { preset });
    expect(useSettingsStore.getState().providers.filter((p) => p.preset === preset)).toHaveLength(1);
    expect(useSettingsStore.getState().providers.find((p) => p.id === custom)?.preset).toBe('custom');
  });
  it('allows multiple named local connections and shows the name in their cards', () => {
    const settings = useSettingsStore.getState();
    const one = settings.addProvider('ollama');
    const two = settings.addProvider('ollama');
    expect(one).not.toBe(two);
    settings.updateProvider(two, { name: 'Desktop server' });
    render(<SettingsModal open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI providers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Desktop server connection' }));
    fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Home server' } });
    expect(useSettingsStore.getState().providers.find((p) => p.id === two)?.name).toBe('Home server');
    expect(screen.getByRole('button', { name: 'Home server connection' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://home-server:11434/v1' } });
    expect(useSettingsStore.getState().providers.find((p) => p.id === two)?.baseUrl).toBe('http://home-server:11434/v1');
    fireEvent.change(screen.getByLabelText('SearXNG URL'), { target: { value: 'http://home-server:8080' } });
    expect(useSettingsStore.getState().providers.find((p) => p.id === two)?.webSearchEndpoint).toBe('http://home-server:8080');
    expect(screen.getByRole('button', { name: 'Test search connection' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('SearXNG URL'), { target: { value: 'not a URL' } });
    expect(screen.getByRole('button', { name: 'Test search connection' })).toBeDisabled();
    expect(screen.queryByLabelText('OpenRouter routing')).not.toBeInTheDocument();
  });
});
