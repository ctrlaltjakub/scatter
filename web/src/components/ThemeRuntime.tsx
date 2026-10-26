'use client';

import { useEffect } from 'react';
import { applyThemePreference, readThemePreference } from '@/lib/theme';

/** Keeps System mode synchronized after the pre-paint bootstrap has run. */
export function ThemeRuntime() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const synchronize = () => {
      applyThemePreference(readThemePreference(), { persist: false, systemDark: media.matches });
    };
    synchronize();
    media.addEventListener('change', synchronize);
    window.addEventListener('storage', synchronize);
    return () => {
      media.removeEventListener('change', synchronize);
      window.removeEventListener('storage', synchronize);
    };
  }, []);
  return null;
}
