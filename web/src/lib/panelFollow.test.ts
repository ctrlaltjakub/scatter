import { describe, expect, test } from 'vitest';
import {
  computePanelTargetOffset,
  stepPanelMotion,
  PANEL_MOTION,
  type PanelMotionState,
} from './panelFollow';

/**
 * The side panel follows the active section's top as the user scrolls /
 * expands bullets, BUT its lower edge may never drop below the node's
 * lower border. That second rule has the highest priority — these tests
 * pin it down.
 *
 * All values are CSS pixels in the node's local (world) space:
 *   - `sectionTopWithinNode`  = activeSectionTop − nodeTop  (always ≥ 0,
 *     since every section lives inside the node body, below its top)
 *   - `nodeHeight`            = the node card's border-box height
 *   - `panelHeight`           = the panel's border-box height
 *
 * The returned offset is added to the node's top to get the panel's top.
 */
describe('computePanelTargetOffset', () => {
  test('aligns panel top with the section top when there is room below', () => {
    // section 100px down a 400px node; 200px panel → bottom at 300 ≤ 400.
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 100,
      nodeHeight: 400,
      panelHeight: 200,
    });
    expect(o).toBe(100);
  });

  test('clamps so the panel bottom never passes the node bottom (priority rule)', () => {
    // section 350px down a 400px node; a 200px panel aligned to 350 would
    // end at 550, far below the node's 400 bottom. Clamp to 200 so the
    // panel bottom sits exactly on the node bottom.
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 350,
      nodeHeight: 400,
      panelHeight: 200,
    });
    expect(o).toBe(200); // 200 + 200 === 400 === node bottom
  });

  test('lower-edge rule wins even when it forces the panel top above the node top', () => {
    // Panel taller than the node: the only way to keep the bottom on the
    // node bottom is to let the top ride above the node top (negative
    // offset). The priority rule still wins.
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 50,
      nodeHeight: 200,
      panelHeight: 260,
    });
    expect(o).toBe(-60); // -60 + 260 === 200 === node bottom
  });

  test('top-priority panels never rise above the node when both edges cannot fit', () => {
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 50,
      nodeHeight: 200,
      panelHeight: 260,
      edgePriority: 'top',
    });
    expect(o).toBe(0);
  });

  test('top-priority panels still clamp to the node bottom when both edges can fit', () => {
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 350,
      nodeHeight: 400,
      panelHeight: 200,
      edgePriority: 'top',
    });
    expect(o).toBe(200);
  });

  test('freetext / top of node → offset 0 (panel rests at node top)', () => {
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 0,
      nodeHeight: 400,
      panelHeight: 200,
    });
    expect(o).toBe(0);
  });

  test('exact fit: section top equals the max allowed offset', () => {
    const o = computePanelTargetOffset({
      sectionTopWithinNode: 200,
      nodeHeight: 400,
      panelHeight: 200,
    });
    expect(o).toBe(200);
  });
});

/**
 * stepPanelMotion advances a 1-D motion one frame toward a target with a
 * TRAPEZOIDAL velocity profile: a short acceleration ramp (limited by
 * `accel`), a slow constant-speed cruise (capped at `maxSpeed`), then a
 * short deceleration to a dead stop exactly on the target. It carries
 * velocity between frames so a target that moves mid-flight (the cascade
 * animating, or the user scrolling again) re-aims smoothly.
 */
describe('stepPanelMotion', () => {
  const P = PANEL_MOTION;

  test('accelerates from rest by exactly `accel` on the first frame', () => {
    // Far target → desired speed is capped at maxSpeed, but the velocity
    // can only ramp up by `accel` this frame: short acceleration.
    const s = stepPanelMotion({ pos: 0, vel: 0 }, 1000, P);
    expect(s.vel).toBeCloseTo(P.accel, 6);
    expect(s.pos).toBeCloseTo(P.accel, 6);
  });

  test('cruises at maxSpeed mid-flight and never exceeds it', () => {
    let st: PanelMotionState = { pos: 0, vel: 0 };
    let maxV = 0;
    for (let i = 0; i < 60; i++) {
      st = stepPanelMotion(st, 1000, P);
      maxV = Math.max(maxV, st.vel);
    }
    expect(maxV).toBeLessThanOrEqual(P.maxSpeed + 1e-9);
    // After ramping it should be at the cruise speed (still far from target).
    expect(st.vel).toBeCloseTo(P.maxSpeed, 6);
  });

  test('decelerates to a dead stop on the target without overshooting', () => {
    let st: PanelMotionState = { pos: 0, vel: 0 };
    let overshot = false;
    let settled = false;
    for (let i = 0; i < 5000; i++) {
      st = stepPanelMotion(st, 200, P);
      if (st.pos > 200 + 1e-6) overshot = true;
      if (st.pos === 200 && st.vel === 0) { settled = true; break; }
    }
    expect(overshot).toBe(false);
    expect(settled).toBe(true);
  });

  test('snaps to the target once it is both close and slow', () => {
    expect(stepPanelMotion({ pos: 199.9, vel: 0.1 }, 200, P)).toEqual({
      pos: 200,
      vel: 0,
    });
  });

  test('is symmetric for downward (negative-direction) travel', () => {
    const s = stepPanelMotion({ pos: 0, vel: 0 }, -1000, P);
    expect(s.vel).toBeCloseTo(-P.accel, 6);
    expect(s.pos).toBeCloseTo(-P.accel, 6);
  });

  test('a 200px move is a bounded, smooth glide (not instant, not glacial)', () => {
    let st: PanelMotionState = { pos: 0, vel: 0 };
    let frames = 0;
    for (let i = 0; i < 5000; i++) {
      st = stepPanelMotion(st, 200, P);
      frames++;
      if (st.pos === 200 && st.vel === 0) break;
    }
    // Envelope, not an exact spec — guards "the glide actually moves and
    // terminates in a sane time" without over-coupling to the tuning
    // constants. ~0.5s–2s at 60fps.
    expect(frames).toBeGreaterThan(25);
    expect(frames).toBeLessThan(120);
  });
});
