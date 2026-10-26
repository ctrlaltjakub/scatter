import { oklchToHex, hexToOklch } from './oklch';

/** Automatic palettes vary hue only. The RGB conversion clips colors outside
 * sRGB, so these are the requested OKLCH values, not round-trip guarantees. */
export const GROUP_L = 0.7462;
export const GROUP_C = 0.22;

// 22 (not 22.5) lets sixteen integer-degree hues fit around the wheel.
export const HUE_MARGIN = 22;

// Descendants stay near their parent, with a gentle push away from siblings.
const W_REL = 1;
const W_SIB = 0.3;

export interface AssignInput {
  firstGenHues?: readonly number[];
  /** Hues of existing groups. Lightness/chroma never affect assignment. */
  used?: readonly number[];
  /** Reserved project hues; excluded even when used group hues are recycled. */
  blocked?: readonly number[];
  relative?: number | null;
  siblings?: readonly number[];
  familyAnchor?: number | null;
  otherAnchors?: readonly number[];
  rng?: () => number;
}

const circHueDiff = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
};
const isFree = (hue: number, used: readonly number[]) =>
  used.every((other) => circHueDiff(hue, other) >= HUE_MARGIN);
const pickRandom = (hues: readonly number[], rng: () => number): number =>
  hues[Math.floor(rng() * hues.length)]!;
const HUES = Array.from({ length: 360 }, (_, hue) => hue);

/** Choose a hue, preserving the hierarchy/spread rules without a chroma axis. */
export function assignGroupHue(input: AssignInput): number {
  const used = input.used ?? [];
  const blocked = input.blocked ?? [];
  const rng = input.rng ?? Math.random;
  const relative = input.relative ?? null;
  const avoid = [...used, ...blocked];
  const free = HUES.filter((hue) => isFree(hue, avoid));

  if (relative === null) {
    // Spread first-generation groups through the largest remaining hue gaps.
    let pool = free;
    if (pool.length === 0) pool = HUES.filter((hue) => isFree(hue, blocked));
    if (pool.length === 0) pool = HUES;
    const firstGenHues = input.firstGenHues ?? [];
    if (firstGenHues.length === 0) return pickRandom(pool, rng);
    const scored = pool.map((hue) => ({
      hue, score: Math.min(...firstGenHues.map((other) => circHueDiff(hue, other))),
    }));
    const best = Math.max(...scored.map(({ score }) => score));
    return pickRandom(scored.filter(({ score }) => score >= best - 0.5).map(({ hue }) => hue), rng);
  }

  const familyAnchor = input.familyAnchor ?? null;
  const otherAnchors = input.otherAnchors ?? [];
  const siblings = input.siblings ?? [];
  const inFamily = (hue: number) => familyAnchor === null
    || otherAnchors.every((other) =>
      circHueDiff(hue, familyAnchor) <= circHueDiff(hue, other) + 1e-9);

  // Keep existing relaxation order: family → free space → recycled group
  // hues outside the project's reserved range → whole wheel as last resort.
  let pool = free.filter(inFamily);
  if (pool.length === 0) pool = free;
  if (pool.length === 0) pool = HUES.filter((hue) => isFree(hue, blocked));
  if (pool.length === 0) pool = HUES;
  const scored = pool.map((hue) => ({
    hue,
    score: (W_SIB * (siblings.length ? Math.min(...siblings.map((other) => circHueDiff(hue, other))) : 0)
      - W_REL * circHueDiff(hue, relative)) / HUE_MARGIN,
  }));
  const best = Math.max(...scored.map(({ score }) => score));
  return pickRandom(scored.filter(({ score }) => score >= best - 0.25).map(({ hue }) => hue), rng);
}

/** Read only hue from saved colors, including older and manually chosen ones. */
export function hexToHue(hex: string): number {
  return hexToOklch(hex).h;
}

export function assignGroupColorHex(input: AssignInput): string {
  return oklchToHex(GROUP_L, GROUP_C, assignGroupHue(input));
}
