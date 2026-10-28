'use client';

import { useSyncExternalStore } from 'react';

export type DecorativeMotionPreference = 'system' | 'animate' | 'pause';
const KEY = 'scatter-decorative-motion';
const EVENT = 'scatter-decorative-motion-change';
const QUERY = '(prefers-reduced-motion: reduce)';
let memoryPreference: DecorativeMotionPreference | undefined;

function readPreference(): DecorativeMotionPreference {
  if (memoryPreference !== undefined) return memoryPreference;
  try {
    const value = localStorage.getItem(KEY);
    return value === 'system' || value === 'pause' ? value : 'animate';
  } catch { return memoryPreference ?? 'animate'; }
}

/** Device-local accessibility/display preference, excluded from project undo and sync. */
export function setDecorativeMotionPreference(preference: DecorativeMotionPreference) {
  try { localStorage.setItem(KEY, preference); memoryPreference = undefined; }
  catch { memoryPreference = preference; }
  window.dispatchEvent(new Event(EVENT));
}

function snapshot(): string {
  const preference = readPreference();
  const reduced = preference === 'pause' || (preference === 'system' && window.matchMedia?.(QUERY).matches);
  return `${preference}:${reduced ? 'reduce' : 'animate'}`;
}
const serverSnapshot = () => 'animate:animate';

function subscribe(update: () => void) {
  const media = window.matchMedia?.(QUERY);
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) update(); };
  window.addEventListener(EVENT, update);
  window.addEventListener('storage', storage);
  media?.addEventListener?.('change', update);
  return () => {
    window.removeEventListener(EVENT, update);
    window.removeEventListener('storage', storage);
    media?.removeEventListener?.('change', update);
  };
}

/** Animate by default even when remote desktops report reduced motion. Users
 * can explicitly follow their system preference or pause these two animations. */
export function useDecorativeMotion() {
  const value = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return { preference: value.split(':')[0] as DecorativeMotionPreference, reduced: value.endsWith(':reduce') };
}
