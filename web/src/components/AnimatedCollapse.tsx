'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const DURATION_MS = 180;

/** Lazy-mount disclosure contents; retain them only for the closing animation.
 * Closed sections are immediately inert, and do not keep fetching/rendering. */
export function AnimatedCollapse({ open, id, children }: {
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const [present, setPresent] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const [animating, setAnimating] = useState(false);
  const previousOpen = useRef(open);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPresent(open);
      setExpanded(open);
      setAnimating(false);
      return;
    }
    setAnimating(true);
    if (open) setPresent(true);
    else setExpanded(false);
    const finish = setTimeout(() => {
      setAnimating(false);
      if (!open) setPresent(false);
    }, DURATION_MS);
    return () => clearTimeout(finish);
  }, [open]);

  // Opening: the content has just been committed at zero height. Flush that
  // style, then expand before the frame is painted, so the transition starts
  // with the click. Waiting for animation frames instead delayed the start by
  // two frames; when frames are slow, that showed as lag followed by a jump.
  useLayoutEffect(() => {
    if (!open || !present || expanded) return;
    rootRef.current?.getBoundingClientRect();
    setExpanded(true);
  }, [open, present, expanded]);

  if (!present) return null;
  return <div id={id} className="sc-animated-collapse" data-expanded={expanded} data-animating={animating}
    aria-hidden={!open || undefined} ref={(element) => {
      rootRef.current = element;
      if (element) element.inert = !open;
    }}>
    <div className="sc-animated-collapse-clip"><div className="sc-animated-collapse-content">{children}</div></div>
  </div>;
}
