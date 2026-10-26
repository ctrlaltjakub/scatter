import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyThemePreference,
  normalizeThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_BOOTSTRAP_SCRIPT,
  THEME_CHANGE_EVENT,
} from './theme';

describe('app theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'latte';
    document.documentElement.dataset.themePreference = 'system';
  });

  afterEach(() => vi.restoreAllMocks());

  it('migrates old names and defaults preference-free installs to Dark', () => {
    expect(normalizeThemePreference('latte')).toBe('light');
    expect(normalizeThemePreference('mocha')).toBe('dark');
    expect(readThemePreference()).toBe('dark');
    localStorage.setItem('rh-theme', 'mocha');
    expect(readThemePreference()).toBe('dark');
  });

  it.each(['light', 'dark', 'system'] as const)('preserves the saved %s preference', preference => {
    localStorage.setItem('sc-theme', preference);
    expect(readThemePreference()).toBe(preference);
  });

  it('falls back to Dark for an invalid saved preference', () => {
    localStorage.setItem('sc-theme', 'invalid');
    expect(readThemePreference()).toBe('dark');
  });

  it('resolves System from the operating-system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('applies, persists, and announces a resolved theme', () => {
    const listener = vi.fn();
    window.addEventListener(THEME_CHANGE_EVENT, listener);
    applyThemePreference('dark');
    expect(document.documentElement.dataset.theme).toBe('mocha');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem('sc-theme')).toBe('dark');
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener(THEME_CHANGE_EVENT, listener);
  });

  it.each([true, false])('starts preference-free installs in Dark before rendering (system dark=%s)', systemDark => {
    new Function('localStorage', 'matchMedia', 'document', THEME_BOOTSTRAP_SCRIPT)(
      localStorage, () => ({ matches: systemDark }), document,
    );
    expect(document.documentElement.dataset.theme).toBe('mocha');
    expect(document.documentElement.dataset.themePreference).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it.each([
    ['light', true, 'latte'], ['dark', false, 'mocha'],
    ['system', true, 'mocha'], ['system', false, 'latte'],
  ])('keeps saved %s mode before rendering (system dark=%s)', (preference, systemDark, palette) => {
    localStorage.setItem('sc-theme', preference as string);
    new Function('localStorage', 'matchMedia', 'document', THEME_BOOTSTRAP_SCRIPT)(
      localStorage, () => ({ matches: systemDark }), document,
    );
    expect(document.documentElement.dataset.theme).toBe(palette);
    expect(document.documentElement.dataset.themePreference).toBe(preference);
  });
});
