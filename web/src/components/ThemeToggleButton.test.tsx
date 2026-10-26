import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { ThemeToggleButton } from './ThemeToggleButton';
import { THEME_STORAGE_KEY } from '@/lib/theme';

describe('ThemeToggleButton', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.dataset.theme = 'latte';
    document.documentElement.dataset.themePreference = 'system';
  });

  it('shows the current mode and toggles to an explicit opposite preference', () => {
    const { container } = render(<ThemeToggleButton />);
    const button = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(button).not.toHaveAttribute('aria-pressed');
    expect(container.querySelector('.lucide-sun')).not.toBeNull();

    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe('mocha');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' }))
      .not.toHaveAttribute('aria-pressed');
    expect(container.querySelector('.lucide-moon')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.dataset.theme).toBe('latte');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it.each(['dark', 'light'] as const)('hydrates safely when the bootstrap script has already applied %s mode', async mode => {
    const host = document.createElement('div');
    host.innerHTML = renderToString(<ThemeToggleButton />);
    expect(host.querySelector('.lucide-moon')).not.toBeNull();
    document.documentElement.dataset.theme = mode === 'dark' ? 'mocha' : 'latte';
    document.documentElement.dataset.themePreference = mode;
    document.body.append(host);
    const recoverable = vi.fn();
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => { root = hydrateRoot(host, <ThemeToggleButton />, { onRecoverableError: recoverable }); });
    try {
      expect(recoverable).not.toHaveBeenCalled();
      expect(host.querySelector(mode === 'dark' ? '.lucide-moon' : '.lucide-sun')).not.toBeNull();
      expect(host.querySelector('button')).toHaveAttribute('aria-label', `Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`);
    } finally {
      act(() => root!.unmount());
      host.remove();
    }
  });
});
