'use client';

import { useEffect, useRef } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { resolveColorHex } from '@/lib/groupColor';
import { projectFaviconUrl } from '@/lib/favicon';

/** Tab identity follows project/theme changes, never node/camera updates. */
export function ProjectFavicon() {
  const color = useGraphStore((state) => state.project?.color ?? null);
  const theme = useResolvedTheme();
  const iconRef = useRef<HTMLLinkElement | null>(null);

  useEffect(() => {
    // Keep Next's static metadata untouched: its head reconciliation can
    // restore that link's original href. Browsers prefer the last icon link.
    const icon = document.createElement('link');
    icon.id = 'project-favicon';
    icon.rel = 'icon';
    icon.type = 'image/svg+xml';
    icon.setAttribute('sizes', 'any');
    iconRef.current = icon;
    document.head.append(icon);
    // App Router can insert its fallback metadata after client effects on
    // initial hydration. Preserve ordering without observing or redrawing the
    // canvas, and avoid an observer loop by moving only when necessary.
    const keepProjectIconLast = () => {
      const icons = document.head.querySelectorAll('link[rel="icon"]');
      if (icons[icons.length - 1] !== icon) document.head.append(icon);
    };
    const observer = new MutationObserver(keepProjectIconLast);
    observer.observe(document.head, { childList: true });
    return () => { observer.disconnect(); icon.remove(); iconRef.current = null; };
  }, []);

  useEffect(() => {
    const icon = iconRef.current;
    if (!icon) return;
    // Named project accents can change with the theme, even without a backdrop.
    icon.href = projectFaviconUrl(color ? resolveColorHex(color) : null);
    document.head.append(icon);
  }, [color, theme]);

  return null;
}
