import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { useFullscreenSidebar } from './useFullscreenSidebar';
import { useSidebarAutoPeek } from './useSidebarAutoPeek';

let fullscreenElement: Element | null = null;

function enterFullscreen() {
  fullscreenElement = document.documentElement;
  document.dispatchEvent(new Event('fullscreenchange'));
}

function exitFullscreen() {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
}

function useHarness(initialCollapsed: boolean) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [peeking, setPeeking] = useState(false);
  const closePeek = useRef(vi.fn()).current;
  const fullscreen = useFullscreenSidebar({ collapsed, setCollapsed, closePeek });
  useSidebarAutoPeek({ collapsed, setPeeking });
  return { collapsed, setCollapsed, closePeek, fullscreen, peeking };
}

function usePeekHarness(disabled: boolean) {
  const [peeking, setPeeking] = useState(false);
  useSidebarAutoPeek({ collapsed: true, setPeeking, disabled });
  return peeking;
}

function useLockedPeekHarness(locked: boolean) {
  const [peeking, setPeeking] = useState(false);
  useSidebarAutoPeek({ collapsed: true, setPeeking, locked });
  return peeking;
}

describe('useFullscreenSidebar', () => {
  beforeEach(() => {
    fullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
  });

  it('collapses on fullscreen entry and restores an open sidebar on exit', () => {
    const { result } = renderHook(() => useHarness(false));

    act(enterFullscreen);
    expect(result.current.collapsed).toBe(true);
    expect(result.current.fullscreen).toBe(true);
    expect(result.current.closePeek).toHaveBeenCalled();

    act(exitFullscreen);
    expect(result.current.collapsed).toBe(false);
    expect(result.current.fullscreen).toBe(false);
  });

  it('restores an already-collapsed sidebar after fullscreen', () => {
    const { result } = renderHook(() => useHarness(true));

    act(enterFullscreen);
    act(() => result.current.setCollapsed(false));
    act(exitFullscreen);

    expect(result.current.collapsed).toBe(true);
  });

  it('keeps the normal left-edge hover reveal after fullscreen collapses the sidebar', () => {
    const { result } = renderHook(() => useHarness(false));

    act(enterFullscreen);
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 })));

    expect(result.current.collapsed).toBe(true);
    expect(result.current.peeking).toBe(true);
  });

  it('does not change the sidebar without a fullscreenchange event', () => {
    const { result } = renderHook(() => useHarness(false));

    expect(result.current.collapsed).toBe(false);
    expect(result.current.fullscreen).toBe(false);
    expect(result.current.closePeek).not.toHaveBeenCalled();
  });

  it('suppresses left-edge peeking while a full-window viewer forces the sidebar away', () => {
    const { result } = renderHook(() => usePeekHarness(true));
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 })));
    expect(result.current).toBe(false);
  });

  it('keeps an auto-revealed sidebar open while a transient surface owns the peek', () => {
    const { result, rerender } = renderHook(
      ({ locked }) => useLockedPeekHarness(locked),
      { initialProps: { locked: false } },
    );

    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0 })));
    expect(result.current).toBe(true);

    rerender({ locked: true });
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 })));
    expect(result.current).toBe(true);

    rerender({ locked: false });
    expect(result.current).toBe(false);
  });
});
