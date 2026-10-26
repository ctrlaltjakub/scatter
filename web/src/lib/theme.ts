export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';
export const THEME_STORAGE_KEY = 'sc-theme';
export const LEGACY_THEME_STORAGE_KEY = 'rh-theme';
export const THEME_CHANGE_EVENT = 'scatter:themechange';

export interface ThemeChangeDetail {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

export function normalizeThemePreference(value: string | null | undefined): ThemePreference | null {
  if (value === 'light' || value === 'latte') return 'light';
  if (value === 'dark' || value === 'mocha') return 'dark';
  if (value === 'system') return 'system';
  return null;
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches,
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFERENCE;
  return normalizeThemePreference(
    window.localStorage.getItem(THEME_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY),
  ) ?? DEFAULT_THEME_PREFERENCE;
}

export function applyThemePreference(
  preference: ThemePreference,
  options: { persist?: boolean; systemDark?: boolean } = {},
): ThemeChangeDetail {
  const resolved = resolveTheme(preference, options.systemDark);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.themePreference = preference;
    root.dataset.theme = resolved === 'dark' ? 'mocha' : 'latte';
    root.style.colorScheme = resolved;
  }
  if (typeof window !== 'undefined') {
    if (options.persist !== false) {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
      window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    }
    window.dispatchEvent(new CustomEvent<ThemeChangeDetail>(THEME_CHANGE_EVENT, {
      detail: { preference, resolved },
    }));
  }
  return { preference, resolved };
}

/** Applies saved preferences before the first paint; new installs start in Dark. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var k='sc-theme',l='rh-theme',v=localStorage.getItem(k)||localStorage.getItem(l);if(v==='latte')v='light';if(v==='mocha')v='dark';if(v!=='light'&&v!=='dark'&&v!=='system')v='${DEFAULT_THEME_PREFERENCE}';if(localStorage.getItem(l)&&!localStorage.getItem(k)){localStorage.setItem(k,v);localStorage.removeItem(l)}var d=v==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):v;var e=document.documentElement;e.dataset.themePreference=v;e.dataset.theme=d==='dark'?'mocha':'latte';e.style.colorScheme=d}catch(_){}})();`;
