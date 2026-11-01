/** Percentage of the existing field opacity, not an absolute opacity. */
export const DEFAULT_ASCII_OPACITY = 100;
export const MAX_ASCII_OPACITY = 200;

export function normalizeAsciiOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_ASCII_OPACITY, Math.max(0, Math.round(value)))
    : DEFAULT_ASCII_OPACITY;
}
