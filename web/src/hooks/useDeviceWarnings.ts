'use client';
import { useCallback, useEffect, useState } from 'react';
import { detectTouchTablet } from '@/lib/deviceDetect';

/** Per-browser flag: the user dismissed the "built for desktop" tablet notice. */
const DISMISS_KEY = 'sc-dismiss-mobile-warning';

export interface DeviceWarnings {
  /** Heuristic: running on a touch tablet / phone. */
  isTouchTablet: boolean;
  /** Live: the window is portrait/square (width ≤ height) — not landscape. */
  isNarrow: boolean;
  /** The user dismissed the tablet notice on this browser. */
  tabletDismissed: boolean;
  /** Persist the dismissal (only meaningful for the tablet-only notice). */
  dismissTablet: () => void;
}

/**
 * Detects whether to show a device/viewport gate. Touch-tablet detection runs
 * once on mount (it can't change without a reload); the portrait check is live
 * via matchMedia so rotating / resizing updates it immediately. SSR-safe: both
 * flags start false so nothing flashes before mount.
 */
export function useDeviceWarnings(): DeviceWarnings {
  const [isTouchTablet, setIsTouchTablet] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [tabletDismissed, setTabletDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    setIsTouchTablet(detectTouchTablet({
      userAgent: navigator.userAgent || '',
      platform: navigator.platform || '',
      maxTouchPoints: navigator.maxTouchPoints || 0,
      pointerCoarse: coarse,
    }));

    try { setTabletDismissed(localStorage.getItem(DISMISS_KEY) === '1'); } catch { /* ignore */ }

    const mq = window.matchMedia('(max-aspect-ratio: 1/1)');
    const update = () => setIsNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const dismissTablet = useCallback(() => {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setTabletDismissed(true);
  }, []);

  return { isTouchTablet, isNarrow, tabletDismissed, dismissTablet };
}
