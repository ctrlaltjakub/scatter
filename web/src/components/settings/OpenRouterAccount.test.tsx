import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAccount } from './OpenRouterAccount';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { readOpenRouterAccount } from '@/lib/openRouterAccount';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));

vi.mock('@/lib/openRouterAccount', () => ({
  readOpenRouterAccount: vi.fn(), openRouterKeyLinks: vi.fn(async () => ({ settings: 'https://openrouter.ai/keys/test-hash', activity: 'https://openrouter.ai/activity' })),
}));
beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'or', preset: 'openrouter', apiKey: 'test-key', enabledModels: [] }] });
});
describe('OpenRouter account settings', () => {
  it('shows cap, remaining allowance and usage, without claiming a wallet balance', async () => {
    vi.mocked(readOpenRouterAccount).mockResolvedValue({ limit: 10, limit_remaining: 0, usage_daily: 0, usage: 10, limit_reset: 'monthly' });
    render(<OpenRouterAccount />);
    expect(await screen.findAllByText('$0.00')).toHaveLength(2);
    expect(screen.getByText(/not your account’s credit balance/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage credits' })).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    expect(screen.getAllByText('Not reported').length).toBeGreaterThan(0);
    expect(screen.queryByText('test-key')).not.toBeInTheDocument();
  });
  it('does not confuse an unlimited cap with unavailable figures', async () => {
    vi.mocked(readOpenRouterAccount).mockResolvedValue({ limit: null, limit_remaining: null });
    render(<OpenRouterAccount />);
    expect(await screen.findByText('No limit set')).toBeInTheDocument();
    expect(screen.getByText('No key limit')).toBeInTheDocument();
  });
  it('never displays a stale response from a replaced key', async () => {
    let finishOld!: (value: { label: string; usage: number }) => void;
    vi.mocked(readOpenRouterAccount).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ label: 'Current connection', usage: 2 });
    render(<OpenRouterAccount />);
    act(() => useSettingsStore.getState().updateProvider('or', { apiKey: 'replacement-test-key' }));
    expect(await screen.findByText('Current connection')).toBeInTheDocument();
    await act(async () => finishOld({ label: 'Old connection', usage: 99 }));
    expect(screen.queryByText('Old connection')).not.toBeInTheDocument();
    expect(screen.queryByText('$99.00')).not.toBeInTheDocument();
  });
  it('labels previously fetched figures when refresh fails and allows retry', async () => {
    vi.mocked(readOpenRouterAccount).mockResolvedValueOnce({ limit: 10 }).mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ limit: 20 });
    render(<OpenRouterAccount />);
    expect(await screen.findByText('$10.00')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Previously fetched');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('$20.00')).toBeInTheDocument();
  });
});
