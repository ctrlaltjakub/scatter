/**
 * R6.5 — post-load friction ramp (the reload "nudge" damper).
 *
 * On reload the user's saved physics config hydrates from disk and is
 * pushed to the worker, which wakes the sim. Rather than block that
 * wake, we briefly double the friction (velocityDecay) so the woken
 * nodes barely move, then ease it back:
 *   first 0.5 s → doubled (clamped < 1); next 0.5 s → eased to base;
 *   after 1.0 s → base.
 */
import { test, expect, beforeEach } from 'vitest';
import {
  loadFrictionDecay,
  dispatchMessage,
  stopAutoTimer,
  tickOnce,
  getVelocityDecay,
  endLoadFrictionForTest,
  setEmit,
} from './physicsWorker';

const BASE = 0.6; // DEFAULT_PHYSICS_CONFIG.velocityDecay
const DOUBLED = Math.min(0.97, BASE * 2); // 0.97 (2× exceeds the <1 cap)

beforeEach(() => { setEmit(() => {}); });

test('doubled (clamped) friction for the first 0.5 s', () => {
  expect(loadFrictionDecay(0, BASE)).toBe(DOUBLED);
  expect(loadFrictionDecay(250, BASE)).toBe(DOUBLED);
  expect(loadFrictionDecay(499, BASE)).toBe(DOUBLED);
});

test('eases linearly from doubled back to base over the next 0.5 s', () => {
  expect(loadFrictionDecay(500, BASE)).toBeCloseTo(DOUBLED, 5);          // start of ease
  expect(loadFrictionDecay(750, BASE)).toBeCloseTo((DOUBLED + BASE) / 2, 5); // midpoint
  expect(loadFrictionDecay(999, BASE)).toBeCloseTo(BASE, 2);             // ~end of ease
});

test('base friction after 1.0 s (and for negative/out-of-range elapsed)', () => {
  expect(loadFrictionDecay(1000, BASE)).toBe(BASE);
  expect(loadFrictionDecay(5000, BASE)).toBe(BASE);
  expect(loadFrictionDecay(-10, BASE)).toBe(BASE);
});

test('monotonically non-increasing across the ramp (no jumps)', () => {
  let prev = Infinity;
  for (let t = 0; t <= 1100; t += 25) {
    const v = loadFrictionDecay(t, BASE);
    expect(v).toBeLessThanOrEqual(prev + 1e-9);
    prev = v;
  }
});

test('respects the < 1 cap for any base', () => {
  // A base whose double would exceed 1 must clamp.
  expect(loadFrictionDecay(0, 0.9)).toBeLessThan(1);
  expect(loadFrictionDecay(0, 0.9)).toBe(0.97);
});

// ── Wake-anchored behaviour on the live sim ──────────────────────────
// The ramp is wake-source-agnostic (it triggers on the first tick with
// alpha above the wake threshold after a load). We wake via 'resume'
// (alpha 0.1) to avoid coupling to module-level config state.

function load() {
  dispatchMessage({ type: 'init', nodes: [{ id: 'a', x: 0, y: 0, frozen: false }], links: [] });
  stopAutoTimer();
}

test('the first wake after load runs under boosted friction', () => {
  load();
  expect(getVelocityDecay()).toBeCloseTo(BASE, 2); // asleep, base
  dispatchMessage({ type: 'resume' });              // wakes the sim
  stopAutoTimer();
  tickOnce(); // first post-wake tick anchors the ramp + boosts friction
  expect(getVelocityDecay()).toBeCloseTo(DOUBLED, 2);
});

test('after the ramp ends, a later (user) wake runs at normal friction', () => {
  load();
  dispatchMessage({ type: 'resume' });
  stopAutoTimer();
  tickOnce();
  expect(getVelocityDecay()).toBeCloseTo(DOUBLED, 2); // boosted during the load wake
  endLoadFrictionForTest(); // simulate the ramp finishing + disarming
  // A genuine wake much later must feel responsive (no boost).
  dispatchMessage({ type: 'resume' });
  stopAutoTimer();
  tickOnce();
  expect(getVelocityDecay()).toBeCloseTo(BASE, 2);
});
