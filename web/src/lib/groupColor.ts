import type { CatppuccinAccent } from '@/store/types';

/**
 * Group color helpers. A group's color is either a named Catppuccin accent
 * (resolves to a `--{name}` CSS variable) OR a user-defined `#rrggbb` hex.
 * `colorToCss` is the single place that bridges the two for the DOM, and
 * `hexToRgb` does the same for the canvas aura (see asciiAura/auraTint.ts).
 */

/** The 14 built-in accents — the default, non-deletable group palette. */
export const DEFAULT_ACCENTS: readonly CatppuccinAccent[] = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon',
  'peach', 'yellow', 'green', 'teal', 'sky', 'sapphire',
  'blue', 'lavender',
];

const DEFAULT_ACCENT_SET = new Set<string>(DEFAULT_ACCENTS);

export function isHexColor(c: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c);
}

/** True for the built-in accents (which the user cannot delete). */
export function isDefaultAccent(c: string): boolean {
  return DEFAULT_ACCENT_SET.has(c);
}

/** Stored group color → a CSS color value: a hex passes through unchanged; a
 *  named accent becomes its CSS variable. Use everywhere a group color is
 *  rendered (backgrounds, `color-mix` tints, the `--row-accent` var). */
export function colorToCss(c: string): string {
  return isHexColor(c) ? c : `var(--${c})`;
}

/** Resolve a stored group color to a concrete hex — used to seed the color
 *  wheel at the group's current color. A hex passes through; a named accent is
 *  read from its `--{name}` CSS variable. Falls back to mauve when the var is
 *  unavailable (SSR / tests). */
export function resolveColorHex(c: string): string {
  if (isHexColor(c)) return c;
  if (typeof document !== 'undefined') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(`--${c}`).trim();
    if (isHexColor(v)) return v;
  }
  return '#8839ef';
}

/** Parse #rgb / #rrggbb → [r, g, b] (0–255); null if not a valid hex. */
export function hexToRgb(c: string): [number, number, number] | null {
  if (!isHexColor(c)) return null;
  let h = c.slice(1);
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Pick a random default accent for a new group, preferring one not already in
 *  use; once all 14 are taken, any random accent. (Legacy — superseded by
 *  assignGroupColor for new groups, kept for back-compat.) */
export function randomGroupColor(existing: readonly string[]): CatppuccinAccent {
  const inUse = new Set(existing);
  const free = DEFAULT_ACCENTS.filter((a) => !inUse.has(a));
  const pool = free.length > 0 ? free : DEFAULT_ACCENTS;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

// ── ColorBrewer-based group palette + hierarchy-aware assignment ────────────
// Group colors are stored as raw hex (theme-agnostic). The palette is curated
// from ColorBrewer (mostly Dark2 + 2 Set1 hues): every entry sits in a mid
// lightness band so it stays readable on BOTH the light and dark canvas. Order
// here is the AUTO-assignment order (calm teal first); the picker shows them
// sorted by hue (see GROUP_PALETTE_BY_HUE).

export const GROUP_PALETTE: readonly string[] = [
  '#1b9e77', // teal     (Dark2)
  '#377eb8', // blue     (Set1)
  '#d95f02', // orange   (Dark2)
  '#7570b3', // purple   (Dark2)
  '#66a61e', // green    (Dark2)
  '#e7298a', // magenta  (Dark2)
  '#e6ab02', // gold     (Dark2)
  '#e41a1c', // red      (Set1)
  '#a6761d', // brown    (Dark2)
  '#666666', // slate    (neutral; picker-only, excluded from auto-assignment)
];

export interface HSL { h: number; s: number; l: number; }

/** #rgb / #rrggbb → HSL (h in [0,360), s & l in [0,1]); null if not a hex. */
export function hexToHsl(hex: string): HSL | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = (((g - b) / d) % 6 + 6) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

/** HSL → #rrggbb. Hue is normalized; s & l are clamped to [0,1]. */
export function hslToHex({ h, s, l }: HSL): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** A version of a group color for fine UI accents (arrow lines, resize handles),
 *  driven by the theme settings — all three are amounts subtracted/rotated, in
 *  absolute % points, so the effect is uniform across hues:
 *   - `hueShift`      degrees rotated round the wheel (signed; analogous tint).
 *   - `desaturatePct` saturation to remove (0 = unchanged).
 *   - `darkenPct`     lightness to remove (0 = unchanged).
 *  `null`/undefined (no group) → a neutral mid-grey default (a grey has no hue,
 *  so the knobs are no-ops there). Returns a concrete hex (theme-agnostic, like
 *  the stored group colors). */
export function mutedAccentHex(
  color: string | null | undefined,
  hueShift = 33,
  desaturatePct = 0,
  darkenPct = 20,
  theme: 'light' | 'dark' = 'light',
  darkLightnessFloor = 0.46,
): string {
  const DEFAULT = theme === 'dark' ? '#a8a8a8' : '#6e6e6e';
  if (!color) return DEFAULT;
  const hsl = hexToHsl(resolveColorHex(color));
  if (!hsl) return DEFAULT;
  // hslToHex normalizes the hue (so a shift past 0/360 wraps) and clamps s & l.
  return hslToHex({
    h: hsl.h + hueShift,
    s: hsl.s - desaturatePct / 100,
    // Preserve the user's darkening control, but keep fine accents above a
    // caller-selectable contrast floor on the charcoal canvas. Most accents
    // retain the restrained default; arrows ask for a brighter floor.
    l: theme === 'dark'
      ? Math.max(darkLightnessFloor, hsl.l - darkenPct / 100)
      : hsl.l - darkenPct / 100,
  });
}

/** GROUP_PALETTE ordered for the picker: chromatic colors by ascending hue,
 *  neutrals (grey) last — a "neat" rainbow. */
export const GROUP_PALETTE_BY_HUE: readonly string[] = [...GROUP_PALETTE].sort((a, b) => {
  const A = hexToHsl(a)!, B = hexToHsl(b)!;
  const an = A.s < 0.15, bn = B.s < 0.15;       // push neutrals to the end
  if (an !== bn) return an ? 1 : -1;
  return A.h - B.h;
});

// NOTE: hierarchy-aware auto-assignment now lives in groupColorAssign.ts (OKLCH,
// constant lightness + saturation, hue-based kinship). GROUP_PALETTE / _BY_HUE
// above remain the curated ColorBrewer swatches for the manual picker.
