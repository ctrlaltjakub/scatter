'use client';

import { Moon, Sun } from 'lucide-react';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { applyThemePreference } from '@/lib/theme';

/** Compact app-wide theme toggle used by both navigation-control layouts. */
export function ThemeToggleButton() {
  const theme = useResolvedTheme();
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      type="button"
      className="icon-btn"
      data-tip={label}
      aria-label={label}
      data-testid="theme-toggle"
      onClick={() => applyThemePreference(dark ? 'light' : 'dark')}
    >
      {dark ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
    </button>
  );
}
