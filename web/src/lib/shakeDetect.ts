/**
 * Shake gesture detector — used to "shake a pinned node loose".
 *
 * Pure + framework-free so it's unit-testable without the canvas. Feed it the
 * raw pointer position each move (`push(x, y, t)` in screen pixels + a
 * millisecond timestamp); it returns `true` once the pointer has reversed
 * direction enough times in quick succession to count as a deliberate shake.
 *
 * A "reversal" is counted only after a leg of at least `minLegPx` travelled in
 * one direction, so slow drags and tiny jitter never trip it. Reversals older
 * than `windowMs` expire, so a leisurely back-and-forth doesn't accumulate.
 * Both axes are tracked, so a horizontal, vertical, or diagonal wiggle works.
 * Once tripped it stays tripped until `reset()` (called at the start of each
 * fresh drag).
 */

export interface ShakeDetector {
  /** Feed one pointer sample. Returns whether a shake has been detected. */
  push(x: number, y: number, t: number): boolean;
  /** Clear all state for a new gesture. */
  reset(): void;
}

export interface ShakeOptions {
  /** Minimum travel (px) of a leg before a direction change counts. */
  minLegPx?: number;
  /** Reversals within the window needed to trip. */
  minReversals?: number;
  /** Rolling time window (ms) reversals are counted within. */
  windowMs?: number;
}

interface Axis {
  last: number;   // previous sample on this axis (NaN before the first)
  dir: number;    // current leg direction: -1, 0, +1
  leg: number;    // distance travelled in the current direction
}

function makeAxis(): Axis {
  return { last: NaN, dir: 0, leg: 0 };
}

export function createShakeDetector(opts: ShakeOptions = {}): ShakeDetector {
  const minLegPx = opts.minLegPx ?? 12;
  const minReversals = opts.minReversals ?? 3;
  const windowMs = opts.windowMs ?? 700;

  let reversals: number[] = [];   // timestamps of recent direction changes
  let tripped = false;
  const ax = makeAxis();
  const ay = makeAxis();

  /** Update one axis with a new value, recording a reversal timestamp when the
   *  direction flips after a long-enough leg. */
  function feedAxis(axis: Axis, v: number, t: number): void {
    if (Number.isNaN(axis.last)) { axis.last = v; return; }
    const d = v - axis.last;
    axis.last = v;
    const s = Math.sign(d);
    if (s === 0) return;
    if (axis.dir === 0) {
      axis.dir = s;
      axis.leg = Math.abs(d);
    } else if (s === axis.dir) {
      axis.leg += Math.abs(d);
    } else {
      if (axis.leg >= minLegPx) reversals.push(t);
      axis.dir = s;
      axis.leg = Math.abs(d);
    }
  }

  return {
    push(x, y, t) {
      feedAxis(ax, x, t);
      feedAxis(ay, y, t);
      const cutoff = t - windowMs;
      reversals = reversals.filter((rt) => rt >= cutoff);
      if (reversals.length >= minReversals) tripped = true;
      return tripped;
    },
    reset() {
      reversals = [];
      tripped = false;
      ax.last = NaN; ax.dir = 0; ax.leg = 0;
      ay.last = NaN; ay.dir = 0; ay.leg = 0;
    },
  };
}
