'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

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

  useLayoutEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPresent(open);
      setExpanded(open);
      setAnimating(false);
      return;
    }
    let firstFrame = 0;
    let secondFrame = 0;
    let finish: ReturnType<typeof setTimeout>;
    setAnimating(true);
    const settle = () => {
      setAnimating(false);
      if (!open) setPresent(false);
    };
    if (open) {
      setPresent(true);
      // Paint the new content at zero height before moving to its natural size.
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          setExpanded(true);
          finish = setTimeout(settle, 180);
        });
      });
    } else {
      setExpanded(false);
      finish = setTimeout(settle, 180);
    }
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      clearTimeout(finish);
    };
  }, [open]);

  if (!present) return null;
  return <div id={id} className="sc-animated-collapse" data-expanded={expanded} data-animating={animating}
    aria-hidden={!open || undefined} ref={(element) => { if (element) element.inert = !open; }}>
    <div className="sc-animated-collapse-clip"><div className="sc-animated-collapse-content">{children}</div></div>
  </div>;
}
