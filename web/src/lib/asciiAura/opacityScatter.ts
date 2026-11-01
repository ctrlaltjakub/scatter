/** Stable opacity tiers for aura cells. Labels and other functional overlays
 * bypass these tiers. The middle tier always owns half the probability; the
 * full/half tiers trade probability with distance, averaging one quarter each
 * over an unclipped aura. No frame-time seed: resting cells never flicker. */
const FULL_SHARE = 0.25;
const MID_SHARE = 0.5;
const NEAR_BIAS = 0.2;
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
  const full = FULL_SHARE + NEAR_BIAS * (1 - 2 * Math.max(0, Math.min(1, areaFraction)));
  return random < full ? 1 : random < full + MID_SHARE ? 0.75 : 0.5;
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
  float full = ${FULL_SHARE} + ${NEAR_BIAS} * (1.0 - 2.0 * clamp(areaFraction, 0.0, 1.0));
  return random < full ? 1.0 : random < full + ${MID_SHARE} ? 0.75 : 0.5;
}
`;
