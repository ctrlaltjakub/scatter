/**
 * Coalesce a rapid stream of values into at most ONE write per displayed
 * frame, always carrying the LATEST value.
 *
 * Why: generation streams deliver 20–60 store writes/sec (one per SSE delta),
 * but the screen paints at most once per frame — every write above frame rate
 * re-runs the whole parse → render → measure pipeline for a paint that never
 * happens. Pushing through this coalescer keeps the visible streaming
 * behavior byte-identical (the browser could never have shown the skipped
 * intermediate states) while cutting main-thread work to once per frame.
 *
 * Scheduling: requestAnimationFrame for frame alignment, plus a setTimeout
 * fallback because browsers PAUSE rAF entirely in hidden/occluded tabs — a
 * stream running in a background tab must still land its writes. Whichever
 * fires first delivers and clears the other.
 */

/** Hidden-tab fallback interval (ms). Long enough to stay cheap in the
 *  background, short enough that a re-focused tab is near-current. */
const FALLBACK_MS = 100;

export interface FrameCoalescer<T> {
  /** Record the latest value and ensure a delivery is scheduled. */
  push(v: T): void;
  /** Deliver a pending value synchronously (no-op when nothing is pending).
   *  Call before any code that must observe the final pushed value. */
  flush(): void;
  /** Drop any pending value and unschedule. Call on abort so a frame queued
   *  just before the abort can't write after it. */
  cancel(): void;
}

export function makeFrameCoalescer<T>(write: (v: T) => void): FrameCoalescer<T> {
  let pending = false;
  let latest: T;
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const unschedule = () => {
    if (rafId !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const deliver = () => {
    unschedule();
    if (!pending) return;
    pending = false;
    write(latest);
  };

  return {
    push(v: T) {
      latest = v;
      if (pending) return; // a delivery is already scheduled — just updated the value
      pending = true;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(deliver);
      }
      timerId = setTimeout(deliver, FALLBACK_MS);
    },
    flush: deliver,
    cancel() {
      unschedule();
      pending = false;
    },
  };
}
