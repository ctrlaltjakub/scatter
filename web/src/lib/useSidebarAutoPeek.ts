'use client';

import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

interface SidebarAutoPeekOptions {
  collapsed: boolean;
  setPeeking: Dispatch<SetStateAction<boolean>>;
  disabled?: boolean;
  /** Keep an already revealed sidebar open while a transient surface (for
   * example, the project-delete confirmation) extends beyond its edge. */
  locked?: boolean;
}

/** Normal Ctrl/⌘+B collapsed-sidebar behavior: reveal at the left edge. */
export function useSidebarAutoPeek({
  collapsed,
  setPeeking,
  disabled = false,
  locked = false,
}: SidebarAutoPeekOptions): void {
  const lockedRef = useRef(locked);
  const openRef = useRef(false);
  const lastPointerXRef = useRef(0);
  lockedRef.current = locked;

  // If the pointer is already outside when the transient surface closes,
  // retract immediately instead of waiting for another mouse movement.
  useEffect(() => {
    if (locked || !openRef.current || lastPointerXRef.current <= 240) return;
    openRef.current = false;
    setPeeking(false);
  }, [locked, setPeeking]);

  useEffect(() => {
    if (!collapsed || disabled) {
      openRef.current = false;
      setPeeking(false);
      return;
    }

    const REVEAL_X = 24;
    const RETRACT_X = 240;
    const onMove = (e: MouseEvent) => {
      if (e.buttons !== 0) return;
      lastPointerXRef.current = e.clientX;
      if (!openRef.current && e.clientX <= REVEAL_X) {
        openRef.current = true;
        setPeeking(true);
      } else if (openRef.current && e.clientX > RETRACT_X && !lockedRef.current) {
        openRef.current = false;
        setPeeking(false);
      }
    };

    window.addEventListener('mousemove', onMove);
    return () => {
      window.removeEventListener('mousemove', onMove);
      openRef.current = false;
      setPeeking(false);
    };
  }, [collapsed, disabled, setPeeking]);
}
