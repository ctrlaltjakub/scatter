/**
 * R5 follow-up — refresh-drift guard.
 *
 * Every page load pushes the (hydrated) physics config to the worker.
 * Pre-fix, 'set-physics-config' unconditionally rebuilt the forces
 * and kicked alpha to 0.3 — even when the pushed config was IDENTICAL
 * to what the worker already runs. On a freshly loaded project (init
 * forces alpha to 0 precisely so saved positions don't drift) that
 * kick re-energized the simulation and every unfrozen node crept a
 * few px toward force equilibrium — and the next autosave persisted
 * the drift, so it compounded on every refresh.
 *
 * Contract under test: an identical config push is a no-op; a real
 * config change still wakes the simulation (settings-slider UX).
 */
import { test, expect, beforeEach } from 'vitest';
import {
  dispatchMessage,
  stopAutoTimer,
  getAlpha,
  setEmit,
} from './physicsWorker';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';

beforeEach(() => {
  setEmit(() => {});
});

test('re-pushing an identical physics config does not wake a sleeping simulation', () => {
  dispatchMessage({
    type: 'init',
    nodes: [
      { id: 'a', x: 0, y: 0, frozen: false },
      { id: 'b', x: 700, y: 0, frozen: false },
    ],
    links: [],
  });
  stopAutoTimer();
  expect(getAlpha()).toBe(0); // init parks the sim at alpha 0

  // The startup config sync (Canvas pushes the hydrated settings).
  dispatchMessage({
    type: 'set-physics-config',
    config: { ...DEFAULT_PHYSICS_CONFIG },
  });
  stopAutoTimer();
  expect(getAlpha()).toBe(0); // identical → stay asleep
});

test('a genuinely changed physics config wakes the simulation', () => {
  dispatchMessage({
    type: 'init',
    nodes: [{ id: 'a', x: 0, y: 0, frozen: false }],
    links: [],
  });
  stopAutoTimer();

  dispatchMessage({
    type: 'set-physics-config',
    config: { ...DEFAULT_PHYSICS_CONFIG, repelRange: DEFAULT_PHYSICS_CONFIG.repelRange + 50 },
  });
  stopAutoTimer();
  // R6.5: the wake is intentional; the post-load friction ramp (not an
  // alpha block) is what keeps the woken nodes from visibly drifting.
  expect(getAlpha()).toBeCloseTo(0.3, 5);
});
