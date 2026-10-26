export interface ScrollbarRange { top: number; height: number }

// Keep the existing 280ms CSS "ease" motion at normal frame rates. A slow
// focus/cascade frame must not consume most of the animation off screen.
export const SCROLLBAR_MOTION_MS = 280;
const MAX_FRAME_ADVANCE_MS = 1000 / 60;

export function advanceScrollbarClock(elapsed: number, delta: number): number {
  return Math.min(SCROLLBAR_MOTION_MS, elapsed + Math.max(0, Math.min(delta, MAX_FRAME_ADVANCE_MS)));
}

/** Like the side panel, advance on rendered frames rather than jumping ahead
 * after a blocked frame. Browser keyframes retain the original CSS easing;
 * the clock is owned here, not by React renders or a wall-clock transition. */
export function animateScrollbarRange(bar: HTMLElement, target: ScrollbarRange): () => void {
  const from = { top: bar.style.top, height: bar.style.height };
  const to = { top: `${target.top}px`, height: `${target.height}px` };
  bar.style.top = to.top;
  bar.style.height = to.height;
  // First paint has no prior visible position. The fallback also supports
  // non-visual test environments without the Web Animations API.
  if (!from.top || !from.height || !bar.animate || (from.top === to.top && from.height === to.height)) return () => {};

  const animation = bar.animate([from, to], { duration: SCROLLBAR_MOTION_MS, easing: 'ease', fill: 'both' });
  animation.pause();
  animation.currentTime = 0;
  let elapsed = 0;
  let previousTime: number | null = null;
  let frame = 0;
  const tick = (time: number) => {
    elapsed = advanceScrollbarClock(elapsed, previousTime === null ? MAX_FRAME_ADVANCE_MS : time - previousTime);
    previousTime = time;
    animation.currentTime = elapsed;
    if (elapsed < SCROLLBAR_MOTION_MS) frame = requestAnimationFrame(tick);
    else animation.cancel(); // The final inline style now supplies the same geometry.
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    // A new section may be chosen mid-flight. Continue from what was actually
    // visible, never from the old destination or an invisible queued position.
    const visible = getComputedStyle(bar);
    const top = visible.top;
    const height = visible.height;
    animation.cancel();
    bar.style.top = top;
    bar.style.height = height;
  };
}
