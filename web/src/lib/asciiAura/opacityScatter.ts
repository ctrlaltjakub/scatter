/** Stable opacity tiers for aura cells. Labels and other functional overlays
 * bypass these tiers. Normalized exponential curves keep the overall shares
 * at 5% full / 10% three-quarter / 85% half opacity over an unclipped aura,
 * with brighter cells concentrated near its origin. No frame-time seed. */
const FULL_SHARE = 0.05;
const MID_SHARE = 0.1;
const FULL_FALLOFF = 12;
const BRIGHT_FALLOFF = 6;
// Integral of exp(-k * area) over [0, 1] is (1 - exp(-k)) / k.
// Normalize the cumulative thresholds, not individual tiers: full opacity
// falls off sharply, while the >=75% threshold has a gentler exponential tail.
// Both remain monotonic, never cross, and stay below 1 without clipping.
// About 95% of full-opacity and 78% of all brighter cells occupy the inner
// quarter of the aura area. The outer quarter is >99% half-opacity cells.
const FULL_WEIGHT = FULL_SHARE * FULL_FALLOFF / (1 - Math.exp(-FULL_FALLOFF));
const BRIGHT_WEIGHT = (FULL_SHARE + MID_SHARE) * BRIGHT_FALLOFF / (1 - Math.exp(-BRIGHT_FALLOFF));
const HASH_SALT = 0x9e3779b9;
const HASH_MIX = 0x85ebca6b;

/** Area percentile outside a rectangle, including its rounded corners.
 * Using distance alone would overweight the larger outer rings. Zero-size
 * rectangles are the restoration orbs, where this reduces to (d / r)^2. */
export function auraAreaFraction(distance: number, width: number, height: number, radius: number): number {
  if (radius <= 0) return 1;
  const d = Math.max(0, Math.min(radius, distance));
  const perimeter = 2 * (width + height);
  return (perimeter * d + Math.PI * d * d) / (perimeter * radius + Math.PI * radius * radius);
}

/** Independent of the existing glyph/color lottery despite sharing its input. */
export function auraOpacityTier(cellHash: number, areaFraction: number): number {
  let h = (cellHash ^ HASH_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), HASH_MIX) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  const random = h / 4294967296;
  const area = Math.max(0, Math.min(1, areaFraction));
  const full = FULL_WEIGHT * Math.exp(-FULL_FALLOFF * area);
  const bright = BRIGHT_WEIGHT * Math.exp(-BRIGHT_FALLOFF * area);
  return random < full ? 1 : random < bright ? 0.75 : 0.5;
}

// Keep the GPU implementation tied to the statistical reference above.
export const OPACITY_SCATTER_GLSL = `
float auraAreaFraction(float distance, vec2 size, float radius) {
  if (radius <= 0.0) return 1.0;
  float d = clamp(distance, 0.0, radius);
  float perimeter = 2.0 * (size.x + size.y);
  return (perimeter * d + ${Math.PI} * d * d)
    / (perimeter * radius + ${Math.PI} * radius * radius);
}

float auraOpacityTier(uint cellSeed, float areaFraction) {
  uint h = cellSeed ^ ${HASH_SALT}u;
  h = (h ^ (h >> 16u)) * ${HASH_MIX}u;
  h = h ^ (h >> 13u);
  float random = float(h) * (1.0 / 4294967296.0);
  float area = clamp(areaFraction, 0.0, 1.0);
  float full = ${FULL_WEIGHT} * exp(-${FULL_FALLOFF.toFixed(1)} * area);
  float bright = ${BRIGHT_WEIGHT} * exp(-${BRIGHT_FALLOFF.toFixed(1)} * area);
  return random < full ? 1.0 : random < bright ? 0.75 : 0.5;
}
`;
