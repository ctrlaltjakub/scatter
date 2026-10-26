import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineIndicator } from './OfflineIndicator';

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

describe('OfflineIndicator', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    setOnline(true);
  });
  afterEach(() => {
    setOnline(true);
    vi.restoreAllMocks();
  });

  it('appears quietly while offline and clears when connectivity returns', async () => {
    setOnline(false);
    render(<OfflineIndicator />);
    expect(screen.getByRole('status')).toHaveTextContent('offline');

    act(() => { setOnline(true); });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('detects lost internet access even when navigator.onLine stays true', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    render(<OfflineIndicator />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('offline'));
  });
});
