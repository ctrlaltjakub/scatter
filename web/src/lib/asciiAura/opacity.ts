/** Percentage of the existing field opacity, not an absolute opacity. */
export const DEFAULT_ASCII_OPACITY = 100;
export const MAX_ASCII_OPACITY = 200;

export function normalizeAsciiOpacity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_ASCII_OPACITY, Math.max(0, Math.round(value)))
    : DEFAULT_ASCII_OPACITY;
}

/** The optional label setting replaces, rather than multiplies, the global
 * control so labels can stay visible even with the background at zero. */
export function asciiOpacityMultipliers(settings: {
  asciiOpacity: number;
  asciiLabelOpacityEnabled: boolean;
  asciiLabelOpacity: number;
}): { aura: number; label: number } {
  const aura = normalizeAsciiOpacity(settings.asciiOpacity) / 100;
  return { aura, label: settings.asciiLabelOpacityEnabled
    ? normalizeAsciiOpacity(settings.asciiLabelOpacity) / 100 : aura };
}
