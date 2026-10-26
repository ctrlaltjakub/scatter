/**
 * OKLCH ↔ sRGB hex conversion (Björn Ottosson's OKLab). Used to compute group
 * colours in a perceptually-uniform space (constant lightness + saturation,
 * varying hue) and bake them to hex for storage/rendering. Out-of-gamut OKLCH
 * is gamut-clamped (RGB clipped to [0,1]).
 */

export interface Oklch { l: number; c: number; h: number; }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** linear-light channel → gamma-encoded sRGB [0,1]. */
function gamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
/** gamma-encoded sRGB [0,1] → linear-light. */
function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** OKLCH (L 0-1, C, H degrees) → #rrggbb, gamut-clamped. */
export function oklchToHex(L: number, C: number, H: number): string {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const to255 = (v: number) => Math.round(clamp01(gamma(v)) * 255);
  const hex = (v: number) => to255(v).toString(16).padStart(2, '0');
  return `#${hex(rLin)}${hex(gLin)}${hex(bLin)}`;
}

/** #rgb / #rrggbb → OKLCH (h in [0,360); c≥0). Falls back to black on bad hex. */
export function hexToOklch(hex: string): Oklch {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('');
  if (h.length !== 6) return { l: 0, c: 0, h: 0 };
  const n = parseInt(h, 16);
  const r = linear(((n >> 16) & 255) / 255);
  const g = linear(((n >> 8) & 255) / 255);
  const b = linear((n & 255) / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const aa = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

  const C = Math.sqrt(aa * aa + bb * bb);
  let H = (Math.atan2(bb, aa) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
}
