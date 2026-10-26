'use client';

import { useSyncExternalStore } from 'react';

const CONNECTIVITY_CHECK_URL = 'https://connectivitycheck.gstatic.com/generate_204';
const ONLINE_CHECK_INTERVAL_MS = 15_000;
const OFFLINE_CHECK_INTERVAL_MS = 3_000;
const CHECK_TIMEOUT_MS = 3_500;

const subscribers = new Set<() => void>();
let online = true;
let monitorCleanup: (() => void) | null = null;
let probeInFlight: Promise<boolean> | null = null;

function publish(nextOnline: boolean): void {
  if (online === nextOnline) return;
  online = nextOnline;
  for (const subscriber of subscribers) subscriber();
}

/** Confirm actual internet reachability. This is intentionally a zero-content
 * request: localhost and virtual adapters can keep `navigator.onLine` true
 * even when the laptop has no route to the internet. */
export function probeInternetConnectivity(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(true);
  if (navigator.onLine === false) {
    publish(false);
    return Promise.resolve(false);
  }
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    try {
      await fetch(CONNECTIVITY_CHECK_URL, {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      publish(true);
      return true;
    } catch {
      publish(false);
      return false;
    } finally {
      window.clearTimeout(timeout);
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

function startMonitor(): () => void {
  let stopped = false;
  let timer: number | null = null;

  const scheduleProbe = () => {
    if (stopped || document.hidden) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      timer = null;
      await probeInternetConnectivity();
      scheduleProbe();
    }, online ? ONLINE_CHECK_INTERVAL_MS : OFFLINE_CHECK_INTERVAL_MS);
  };
  const checkNow = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (navigator.onLine === false) publish(false);
    else void probeInternetConnectivity().finally(scheduleProbe);
  };
  const onOffline = () => {
    publish(false);
    scheduleProbe();
  };
  const onVisibility = () => {
    if (document.hidden) {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    } else {
      checkNow();
    }
  };

  window.addEventListener('online', checkNow);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisibility);
  checkNow();

  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
    window.removeEventListener('online', checkNow);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

export function subscribeNetworkStatus(onChange: () => void): () => void {
  subscribers.add(onChange);
  if (!monitorCleanup && typeof window !== 'undefined') monitorCleanup = startMonitor();
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0) {
      monitorCleanup?.();
      monitorCleanup = null;
    }
  };
}

export function isBrowserOnline(): boolean {
  return typeof navigator === 'undefined' ? true : online && navigator.onLine !== false;
}

export function useIsBrowserOnline(): boolean {
  return useSyncExternalStore(subscribeNetworkStatus, isBrowserOnline, () => true);
}
