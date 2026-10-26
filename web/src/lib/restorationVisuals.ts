import { GROUP_C, GROUP_L } from './groupColorAssign';
import { oklchToHex } from './oklch';
import type { GroupColorAssignment } from '@/store/types';
import { GOLDEN_ANGLE_DEGREES } from './projectColorAssignment';
import { RAMP } from './asciiAura/ramp';
import {
  stableAuraGlyphSeed,
  type AuraEntry,
  type AuraScene,
  type AuraSceneState,
  type DirtyReason,
} from './asciiAura/sceneState';
import { waveStillActive } from './asciiAura/wave';

export const RESTORATION_ZOOM = 0.75;
export const RESTORATION_ORBIT_RADIUS_PX = 150;
export const RESTORATION_ORBIT_PERIOD_MS = 5_000;
export const RESTORATION_RECOLOR_MS = 2_500;
export const RESTORATION_COOLING_DURATION_MS = 2_000;
export const RESTORATION_COOL_STAGES_PER_SEC = (RAMP.length - 1)
  / (RESTORATION_COOLING_DURATION_MS / 1_000);

export interface RestorationColorPair {
  hue: number;
  project: string;
  group: string;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface RestorationOrbitInput {
  width: number;
  height: number;
  elapsedMs: number;
  reducedMotion?: boolean;
  radiusPx?: number;
  periodMs?: number;
}

export function generateRestorationColorPair(
  assignment: GroupColorAssignment = 'hierarchy-aware',
  rng: () => number = Math.random,
): RestorationColorPair {
  const hue = ((rng() % 1) + 1) % 1 * 360;
  const groupHue = hue + (
    assignment === 'golden-angle' ? GOLDEN_ANGLE_DEGREES : 180
  );
  return {
    hue,
    project: oklchToHex(GROUP_L, GROUP_C, hue),
    group: oklchToHex(GROUP_L, GROUP_C, groupHue),
  };
}

/** Two screen-space points on opposite sides of a clockwise orbit. */
export function restorationOrbitPoints({
  width,
  height,
  elapsedMs,
  reducedMotion = false,
  radiusPx = RESTORATION_ORBIT_RADIUS_PX,
  periodMs = RESTORATION_ORBIT_PERIOD_MS,
}: RestorationOrbitInput): readonly [ScreenPoint, ScreenPoint] {
  // Begin vertically, with the project-colored aura at 12 o'clock. Because
  // recoloring happens every half-period, every color ripple then lands at a
  // vertical 12/6 o'clock crossing too.
  const phase = Math.PI / 2 - (reducedMotion ? 0 : (elapsedMs / periodMs) * Math.PI * 2);
  const dx = Math.cos(phase) * radiusPx;
  // Screen Y grows downward; decreasing phase moves the top aura toward the
  // right-hand side first, producing clockwise motion.
  const dy = -Math.sin(phase) * radiusPx;
  const cx = width / 2;
  const cy = height / 2;
  return [
    { x: cx + dx, y: cy + dy },
    { x: cx - dx, y: cy - dy },
  ];
}

export interface RestorationAuraController {
  scene: AuraScene;
  setPositions(points: readonly [ScreenPoint, ScreenPoint]): void;
  setColors(colors: RestorationColorPair, now: number): void;
}

export interface RestorationAuraControllerOptions {
  colors: RestorationColorPair;
  points: readonly [ScreenPoint, ScreenPoint];
  now: number;
  onDirty: (reason: DirtyReason) => void;
}

const AURA_IDS = ['restoration-project', 'restoration-group'] as const;

function pointAura(
  id: string,
  accent: string,
  point: ScreenPoint,
  now: number,
): AuraEntry {
  return {
    id,
    rect: {
      x: point.x / RESTORATION_ZOOM,
      y: point.y / RESTORATION_ZOOM,
      w: 0,
      h: 0,
    },
    focused: true,
    accent,
    isExplain: false,
    isChat: false,
    glyphSeed: stableAuraGlyphSeed(id),
    intensity: 1,
    intensityFrom: 1,
    intensityFlipAt: now,
  };
}

/** Runtime-only scene which feeds the production WebGL aura renderer. */
export function createRestorationAuraController({
  colors,
  points,
  now,
  onDirty,
}: RestorationAuraControllerOptions): RestorationAuraController {
  const state: AuraSceneState = {
    auras: new Map([
      [AURA_IDS[0], pointAura(AURA_IDS[0], colors.project, points[0], now)],
      [AURA_IDS[1], pointAura(AURA_IDS[1], colors.group, points[1], now)],
    ]),
    waves: new Map(AURA_IDS.map((id) => [id, { kind: 'focus' as const, t0: now }])),
    focusEchoes: new Map(),
    ghosts: new Map(),
    viewport: { x: 0, y: 0, zoom: RESTORATION_ZOOM },
    baselineAccents: [colors.project, colors.group],
    anyUngrouped: false,
    paletteVersion: 1,
    coolStagesPerSecond: RESTORATION_COOL_STAGES_PER_SEC,
  };

  const scene: AuraScene = {
    state,
    subscribeStores: () => () => undefined,
    pruneExpired: (at) => {
      for (const [id, wave] of state.waves) {
        if (!waveStillActive(wave, at)) state.waves.delete(id);
      }
    },
    evalIntensities: () => false,
  };

  return {
    scene,
    setPositions(nextPoints) {
      for (let index = 0; index < AURA_IDS.length; index += 1) {
        const aura = state.auras.get(AURA_IDS[index]!);
        const point = nextPoints[index]!;
        if (!aura) continue;
        aura.rect.x = point.x / RESTORATION_ZOOM;
        aura.rect.y = point.y / RESTORATION_ZOOM;
      }
      onDirty('geometry');
    },
    setColors(nextColors, at) {
      state.auras.get(AURA_IDS[0])!.accent = nextColors.project;
      state.auras.get(AURA_IDS[1])!.accent = nextColors.group;
      state.baselineAccents = [nextColors.project, nextColors.group];
      state.paletteVersion += 1;
      for (const id of AURA_IDS) state.waves.set(id, { kind: 'focus', t0: at });
      onDirty('palette');
      onDirty('recolor');
      onDirty('wave');
    },
  };
}
