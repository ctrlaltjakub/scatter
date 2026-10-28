import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDecorativeMotionPreference, useDecorativeMotion } from './useDecorativeMotion';

let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  localStorage.removeItem('scatter-decorative-motion');
  media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media));
});
afterEach(() => { localStorage.removeItem('scatter-decorative-motion'); vi.unstubAllGlobals(); });

it('respects system reduced motion by default and changes live when the OS setting changes', () => {
  const { result, unmount } = renderHook(useDecorativeMotion);
  expect(result.current).toEqual({ preference: 'system', reduced: true });
  const onChange = media.addEventListener.mock.calls[0]![1];
  act(() => { media.matches = false; onChange(); });
  expect(result.current.reduced).toBe(false);
  unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', onChange);
});

it('explicitly restores motion despite a remote desktop system signal and persists across mounts', () => {
  const first = renderHook(useDecorativeMotion);
  act(() => setDecorativeMotionPreference('animate'));
  expect(first.result.current).toEqual({ preference: 'animate', reduced: false });
  first.unmount();
  const next = renderHook(useDecorativeMotion);
  expect(next.result.current).toEqual({ preference: 'animate', reduced: false });
  act(() => setDecorativeMotionPreference('pause'));
  expect(next.result.current.reduced).toBe(true);
  act(() => setDecorativeMotionPreference('system'));
  expect(next.result.current.reduced).toBe(true);
});

it('updates other open tabs and falls back to System after clearing local data', () => {
  const { result } = renderHook(useDecorativeMotion);
  act(() => {
    localStorage.setItem('scatter-decorative-motion', 'animate');
    window.dispatchEvent(new StorageEvent('storage', { key: 'scatter-decorative-motion' }));
  });
  expect(result.current.reduced).toBe(false);
  act(() => {
    localStorage.removeItem('scatter-decorative-motion');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
  });
  expect(result.current).toEqual({ preference: 'system', reduced: true });
});
