import { describe, expect, it, vi } from 'vitest';
import { GROUP_C, GROUP_L } from './groupColorAssign';
import { oklchToHex } from './oklch';
import {
  RESTORATION_ORBIT_PERIOD_MS,
  RESTORATION_RECOLOR_MS,
  RESTORATION_COOLING_DURATION_MS,
  RESTORATION_COOL_STAGES_PER_SEC,
  RESTORATION_ZOOM,
  createRestorationAuraController,
  generateRestorationColorPair,
  restorationOrbitPoints,
} from './restorationVisuals';
import { GOLDEN_ANGLE_DEGREES } from './projectColorAssignment';

describe('restoration visuals', () => {
  it('creates a golden-angle pair using production lightness and chroma', () => {
    const pair = generateRestorationColorPair('golden-angle', () => 0.25);
    expect(pair.hue).toBe(90);
    expect(pair.project).toBe(oklchToHex(GROUP_L, GROUP_C, 90));
    expect(pair.group).toBe(oklchToHex(GROUP_L, GROUP_C, 90 + GOLDEN_ANGLE_DEGREES));
  });

  it('retains the opposite pair for hierarchy-aware assignment', () => {
    const pair = generateRestorationColorPair('hierarchy-aware', () => 0.25);
    expect(pair.project).toBe(oklchToHex(GROUP_L, GROUP_C, 90));
    expect(pair.group).toBe(oklchToHex(GROUP_L, GROUP_C, 270));
  });

  it('uses an opposite pair for the default hierarchy-aware assignment', () => {
    const pair = generateRestorationColorPair(undefined, () => 0.25);
    expect(pair.project).toBe(oklchToHex(GROUP_L, GROUP_C, 90));
    expect(pair.group).toBe(oklchToHex(GROUP_L, GROUP_C, 270));
  });

  it('keeps the points opposite, 300px apart, and rotates clockwise', () => {
    const start = restorationOrbitPoints({ width: 1000, height: 800, elapsedMs: 0 });
    const quarter = restorationOrbitPoints({
      width: 1000,
      height: 800,
      elapsedMs: RESTORATION_ORBIT_PERIOD_MS / 4,
    });
    expect(Math.hypot(start[0].x - start[1].x, start[0].y - start[1].y)).toBeCloseTo(300);
    expect(start[0].x).toBeCloseTo(500);
    expect(start[0].y).toBeCloseTo(250);
    expect(quarter[0].x).toBeCloseTo(650);
    expect(quarter[0].y).toBeCloseTo(400);
  });

  it('changes colors on vertical half-orbit crossings', () => {
    expect(RESTORATION_RECOLOR_MS).toBe(RESTORATION_ORBIT_PERIOD_MS / 2);
    const crossing = restorationOrbitPoints({
      width: 1000,
      height: 800,
      elapsedMs: RESTORATION_RECOLOR_MS,
    });
    expect(crossing[0].x).toBeCloseTo(500);
    expect(crossing[0].y).toBeCloseTo(550);
    expect(crossing[1].x).toBeCloseTo(500);
    expect(crossing[1].y).toBeCloseTo(250);
  });

  it('holds the orbit still under reduced motion', () => {
    const a = restorationOrbitPoints({ width: 800, height: 600, elapsedMs: 0, reducedMotion: true });
    const b = restorationOrbitPoints({ width: 800, height: 600, elapsedMs: 15_000, reducedMotion: true });
    expect(b).toEqual(a);
  });

  it('builds focused point auras and ripples again when colors change', () => {
    const onDirty = vi.fn();
    const first = generateRestorationColorPair('golden-angle', () => 0);
    const second = generateRestorationColorPair('golden-angle', () => 0.5);
    const controller = createRestorationAuraController({
      colors: first,
      points: [{ x: 100, y: 200 }, { x: 500, y: 200 }],
      now: 10,
      onDirty,
    });

    expect(controller.scene.state.viewport.zoom).toBe(RESTORATION_ZOOM);
    expect(controller.scene.state.coolStagesPerSecond).toBe(RESTORATION_COOL_STAGES_PER_SEC);
    expect(8 / RESTORATION_COOL_STAGES_PER_SEC * 1_000)
      .toBe(RESTORATION_COOLING_DURATION_MS);
    expect([...controller.scene.state.auras.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ focused: true, rect: expect.objectContaining({ w: 0, h: 0 }) }),
    ]));
    expect(controller.scene.state.waves.size).toBe(2);

    controller.setColors(second, 20_000);
    expect(controller.scene.state.baselineAccents).toEqual([second.project, second.group]);
    expect([...controller.scene.state.waves.values()].every((wave) => wave.t0 === 20_000)).toBe(true);
    expect(onDirty).toHaveBeenCalledWith('palette');
    expect(onDirty).toHaveBeenCalledWith('wave');
  });
});
