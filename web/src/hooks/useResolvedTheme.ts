'use client';

import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME_PREFERENCE, resolveTheme, THEME_CHANGE_EVENT, type ResolvedTheme } from '@/lib/theme';

function currentTheme(): ResolvedTheme {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'mocha'
    ? 'dark'
    : 'light';
}

function subscribe(update: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, update);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, update);
}

const serverTheme = (): ResolvedTheme => resolveTheme(DEFAULT_THEME_PREFERENCE, false);

export function useResolvedTheme(): ResolvedTheme {
  // Match the server's initial markup during hydration, then read the palette
  // already applied by the pre-paint theme script. Client-only mounts read it
  // immediately, and the shared event keeps every control synchronized.
  return useSyncExternalStore(subscribe, currentTheme, serverTheme);
}
