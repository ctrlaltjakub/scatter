/**
 * Group-color aura tint resolver (B.8, extended in E.10).
 *
 * Reads the `--ctp-${accent}` RGB-tuple CSS variable (e.g. "136 57
 * 239") off the document root and produces either a finished rgba()
 * fillStyle (via `resolveAuraTint`) or the split RGB-string + alpha
 * pair (via `resolveAuraTintParts`) the paint loop needs to lerp.
 *
 * Two alpha tiers:
 *   - unfocused cell  → UNFOCUSED_ALPHA
 *   - focused cell    → FOCUSED_ALPHA
 *
 * Results are cached by accent. Call `clearAuraTintCache()` when the
 * theme switches so the next read picks up the new --ctp-* tuples.
 *
 * Falls back to the supplied baseline/aura colors when:
 *   - accent is null (the node has no group), or
 *   - the CSS var is missing (jsdom test environments without
 *     globals.css loaded), or
 *   - we're in an SSR context where `document` doesn't exist.
 */
import { isHexColor, hexToRgb } from '@/lib/groupColor';

// Aura opacity tiers — raised high so group colours read vividly and stay
// distinguishable (faint auras were washing hues together). Tunable single
// source for both the GL and 2D renderers.
const UNFOCUSED_ALPHA = 0.6;
const FOCUSED_ALPHA = 1.0;

function readAlphaTiers(style?: CSSStyleDeclaration): {
  alphaBase: number;
  alphaFocus: number;
} {
  if (typeof document === 'undefined') {
    return { alphaBase: UNFOCUSED_ALPHA, alphaFocus: FOCUSED_ALPHA };
  }
  const computed = style ?? getComputedStyle(document.documentElement);
  const parseTier = (name: string, fallback: number) => {
    const raw = computed.getPropertyValue(name).trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
  };
  return {
    alphaBase: parseTier('--ascii-alpha-unfocused', UNFOCUSED_ALPHA),
    alphaFocus: parseTier('--ascii-alpha-focused', FOCUSED_ALPHA),
  };
}

/** Cache of (accent → parts). Sized by accent count (≤ 14). */
const partsCache = new Map<string, ResolvedAuraTintParts>();

export function clearAuraTintCache(): void {
  partsCache.clear();
}

export interface AuraTintFallback {
  /** Color used for un-focused aura cells of an UNGROUPED node, and
   *  also the color used when an accent lookup fails. */
  baseline: string;
  /** Color used for focused aura cells of an UNGROUPED node. */
  aura: string;
}

export interface ResolvedAuraTintParts {
  /** Comma-separated `R, G, B` string ready for template interpolation
   *  into `rgba(${rgb}, ${alpha})`. */
  rgb: string;
  alphaBase: number;
  alphaFocus: number;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const parseAlpha = (raw: string | undefined): number =>
  raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);

/**
 * Parse a CSS colour into rgb components + alpha. Handles rgb()/rgba(),
 * hsl()/hsla() (comma OR space syntax) and #hex (3/4/6/8). This breadth is
 * REQUIRED: the production CSS minifier re-serialises an authored rgba() as
 * hsla() or hex, so reading a custom property back can yield any of these — and
 * a parser that only knew rgba() fell through to black (the "very dark glyphs
 * online" bug). Returns null when nothing matches.
 */
function parseRgba(s: string): { r: number; g: number; b: number; a: number } | null {
  const str = s.trim();

  const rgb = str.match(/rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)/i);
  if (rgb) return { r: +rgb[1]!, g: +rgb[2]!, b: +rgb[3]!, a: parseAlpha(rgb[4]) };

  const hsl = str.match(/hsla?\(\s*([0-9.]+)\s*[,\s]\s*([0-9.]+)%\s*[,\s]\s*([0-9.]+)%\s*(?:[,/]\s*([0-9.]+%?)\s*)?\)/i);
  if (hsl) {
    const [r, g, b] = hslToRgb(+hsl[1]!, +hsl[2]!, +hsl[3]!);
    return { r, g, b, a: parseAlpha(hsl[4]) };
  }

  if (str[0] === '#') {
    const h = str.slice(1);
    const exp = h.length === 3 || h.length === 4 ? h.split('').map((c) => c + c).join('') : h;
    if (exp.length !== 6 && exp.length !== 8) return null;
    const r = parseInt(exp.slice(0, 2), 16);
    const g = parseInt(exp.slice(2, 4), 16);
    const b = parseInt(exp.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return { r, g, b, a: exp.length === 8 ? parseInt(exp.slice(6, 8), 16) / 255 : 1 };
  }

  return null;
}

/**
 * Return the RGB tuple + base/focus alphas for an aura. Production
 * paint loop uses this to write one fillStyle per aura per paint by
 * lerping alpha against the per-aura intensity value.
 */
export function resolveAuraTintParts(
  accent: string | null,
  fallback: AuraTintFallback,
): ResolvedAuraTintParts {
  // Custom hex group colors resolve directly (no --ctp-* var exists for them).
  if (accent && isHexColor(accent)) {
    const tiers = readAlphaTiers();
    const hit = partsCache.get(accent);
    // Restoration colors are runtime hex values. Validate their cached alpha
    // against the active theme so a startup/theme-change timing race cannot
    // retain the light opacity tiers on the dark loading scene.
    if (
      hit
      && hit.alphaBase === tiers.alphaBase
      && hit.alphaFocus === tiers.alphaFocus
    ) return hit;
    const rgb = hexToRgb(accent)!;
    const parts: ResolvedAuraTintParts = {
      rgb: `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`,
      ...tiers,
    };
    partsCache.set(accent, parts);
    return parts;
  }
  if (!accent) {
    // Ungrouped — derive RGB and both alphas from the fallback rgba
    // strings (typically `--scatter-base` + `--aura-color`).
    const base = parseRgba(fallback.baseline);
    const focus = parseRgba(fallback.aura);
    return {
      rgb: base ? `${base.r}, ${base.g}, ${base.b}` : '0, 0, 0',
      alphaBase: base?.a ?? UNFOCUSED_ALPHA,
      alphaFocus: focus?.a ?? FOCUSED_ALPHA,
    };
  }
  // Helper: build a parts object from the (already parsed) fallback
  // rgba strings. Used as the fallback whenever the accent path fails.
  const fallbackParts = (): ResolvedAuraTintParts => {
    const base = parseRgba(fallback.baseline);
    const focus = parseRgba(fallback.aura);
    return {
      rgb: base ? `${base.r}, ${base.g}, ${base.b}` : '0, 0, 0',
      alphaBase: base?.a ?? UNFOCUSED_ALPHA,
      alphaFocus: focus?.a ?? FOCUSED_ALPHA,
    };
  };
  if (typeof document === 'undefined') return fallbackParts();

  const hit = partsCache.get(accent);
  if (hit) return hit;

  const cs = getComputedStyle(document.documentElement);
  const raw = cs.getPropertyValue(`--ctp-${accent}`).trim();
  if (!raw) return fallbackParts();  // DO NOT cache fallback path — var may appear later
  const nums = raw.split(/\s+/).map((t) => Number(t));
  if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return fallbackParts();
  const [r, g, b] = nums;
  const tiers = readAlphaTiers(cs);
  const parts: ResolvedAuraTintParts = {
    rgb: `${r}, ${g}, ${b}`,
    ...tiers,
  };
  partsCache.set(accent, parts);
  return parts;
}

/** R5 — numeric tint for the GL renderer: rgb scaled to [0, 1]
 *  floats (shader-ready), same alpha tiers as the parts variant. */
export interface ResolvedAuraTintNumeric {
  r: number;
  g: number;
  b: number;
  alphaBase: number;
  alphaFocus: number;
}

/** Identity-keyed derivation cache: parts objects for real accents
 *  are cached per accent (partsCache), so keying on the parts object
 *  gives the numeric variant the same cache lifetime for free.
 *  Fallback parts are fresh objects each call → re-derived (cheap;
 *  only ungrouped/fallback tints hit that path). */
const numericCache = new WeakMap<ResolvedAuraTintParts, ResolvedAuraTintNumeric>();

export function resolveAuraTintNumeric(
  accent: string | null,
  fallback: AuraTintFallback,
): ResolvedAuraTintNumeric {
  const parts = resolveAuraTintParts(accent, fallback);
  const hit = numericCache.get(parts);
  if (hit) return hit;
  const [r, g, b] = parts.rgb.split(',').map((t) => Number(t.trim()));
  const numeric: ResolvedAuraTintNumeric = {
    r: (r ?? 0) / 255,
    g: (g ?? 0) / 255,
    b: (b ?? 0) / 255,
    alphaBase: parts.alphaBase,
    alphaFocus: parts.alphaFocus,
  };
  numericCache.set(parts, numeric);
  return numeric;
}

/**
 * Legacy single-shot resolver — composes RGB + chosen alpha into a
 * finished rgba() string. Kept for any caller that wants a static
 * fillStyle without participating in the E.10 intensity tween. Falls
 * back to the supplied fallback string verbatim when the accent
 * lookup fails (preserving the B.8 semantics — tests rely on this).
 */
export function resolveAuraTint(
  accent: string | null,
  focused: boolean,
  fallback: AuraTintFallback,
): string {
  if (!accent) return focused ? fallback.aura : fallback.baseline;
  if (isHexColor(accent)) {
    const tiers = readAlphaTiers();
    const cachedHex = partsCache.get(accent);
    if (
      cachedHex
      && cachedHex.alphaBase === tiers.alphaBase
      && cachedHex.alphaFocus === tiers.alphaFocus
    ) {
      return `rgba(${cachedHex.rgb}, ${focused ? cachedHex.alphaFocus : cachedHex.alphaBase})`;
    }
    const rgb = hexToRgb(accent)!;
    partsCache.set(accent, {
      rgb: `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`,
      ...tiers,
    });
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${focused ? tiers.alphaFocus : tiers.alphaBase})`;
  }
  // Shared cache with resolveAuraTintParts — once an accent has been
  // successfully parsed by either function, subsequent calls (from
  // either) skip getComputedStyle.
  const cached = partsCache.get(accent);
  if (cached) {
    const alpha = focused ? cached.alphaFocus : cached.alphaBase;
    return `rgba(${cached.rgb}, ${alpha})`;
  }
  if (typeof document === 'undefined') {
    return focused ? fallback.aura : fallback.baseline;
  }
  const cs = getComputedStyle(document.documentElement);
  const raw = cs.getPropertyValue(`--ctp-${accent}`).trim();
  if (!raw) return focused ? fallback.aura : fallback.baseline;
  const nums = raw.split(/\s+/).map((t) => Number(t));
  if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) {
    return focused ? fallback.aura : fallback.baseline;
  }
  const [r, g, b] = nums;
  const tiers = readAlphaTiers(cs);
  partsCache.set(accent, {
    rgb: `${r}, ${g}, ${b}`,
    ...tiers,
  });
  const alpha = focused ? tiers.alphaFocus : tiers.alphaBase;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
