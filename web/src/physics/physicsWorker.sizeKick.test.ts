/**
 * R6.A4 — set-size kicks scale with the size delta.
 *
 * Load-time measurement corrections are tiny (±1-4 px: font-swap
 * re-wraps, zoom-rounding). Pre-fix, ANY height change kicked the
 * sim with a flat alpha 0.5 — visible as nodes nudging on refresh.
 * Now: alpha = min(0.5, max(0.04, maxDelta / 150)). Small
 * corrections barely tickle the sim; real streaming growth (50 px+)
 * keeps meaningful strength.
 */
import { test, expect, beforeEach } from 'vitest';
import {
  dispatchMessage,
  stopAutoTimer,
  getAlpha,
  setEmit,
} from './physicsWorker';

beforeEach(() => {
  setEmit(() => {});
  dispatchMessage({
    type: 'init',
    nodes: [{ id: 'a', x: 0, y: 0, frozen: false }],
    links: [],
  });
  stopAutoTimer();
  // Initial size assignment (wasUnset) never kicks.
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 200 });
  stopAutoTimer();
  expect(getAlpha()).toBe(0);
});

test('a tiny 2 px height correction produces only a whisper of alpha', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 202 });
  stopAutoTimer();
  expect(getAlpha()).toBeGreaterThan(0);      // it does apply
  expect(getAlpha()).toBeLessThanOrEqual(0.04 + 1e-9); // but barely
});

test('a 30 px growth kicks proportionally (0.2)', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 230 });
  stopAutoTimer();
  expect(getAlpha()).toBeCloseTo(30 / 150, 5);
});

test('large streaming growth keeps the full 0.5 kick', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 420 });
  stopAutoTimer();
  expect(getAlpha()).toBeCloseTo(0.5, 5);
});

test('width changes count too (max of the two deltas)', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624 + 75, height: 200 });
  stopAutoTimer();
  expect(getAlpha()).toBeCloseTo(0.5, 5);
});

test('identical size is a no-op (existing dedupe)', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 200 });
  stopAutoTimer();
  expect(getAlpha()).toBe(0);
});

test('wake none applies a pure shrink without waking the simulation', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 120, wake: 'none' });
  stopAutoTimer();
  expect(getAlpha()).toBe(0);
});

test('gentle wake caps large expansion below the normal strong kick', () => {
  dispatchMessage({ type: 'set-size', id: 'a', width: 624, height: 420, wake: 'gentle' });
  stopAutoTimer();
  expect(getAlpha()).toBeCloseTo(0.08, 5);
});
