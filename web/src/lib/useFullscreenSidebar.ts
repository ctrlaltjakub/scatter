'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

interface FullscreenSidebarOptions {
  collapsed: boolean;
  setCollapsed: Dispatch<SetStateAction<boolean>>;
  closePeek?: () => void;
}

/**
 * Temporarily collapses the app sidebar while the document is fullscreen,
 * restoring the exact pre-fullscreen state after the browser exits.
 *
 * The browser event is the source of truth: a rejected requestFullscreen()
 * call never emits it, so it cannot accidentally change the sidebar.
 */
export function useFullscreenSidebar({
  collapsed,
  setCollapsed,
  closePeek,
}: FullscreenSidebarOptions): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  const collapsedRef = useRef(collapsed);
  const closePeekRef = useRef(closePeek);
  const wasFullscreenRef = useRef(false);
  const collapsedBeforeFullscreenRef = useRef(collapsed);

  collapsedRef.current = collapsed;
  closePeekRef.current = closePeek;

  useEffect(() => {
    const onChange = () => {
      const next = !!document.fullscreenElement;
      const wasFullscreen = wasFullscreenRef.current;

      if (next && !wasFullscreen) {
        collapsedBeforeFullscreenRef.current = collapsedRef.current;
        setCollapsed(true);
        closePeekRef.current?.();
      } else if (!next && wasFullscreen) {
        setCollapsed(collapsedBeforeFullscreenRef.current);
        closePeekRef.current?.();
      }

      wasFullscreenRef.current = next;
      setFullscreen(next);
    };

    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [setCollapsed]);

  return fullscreen;
}
