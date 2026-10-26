import { hexToRgb } from './groupColor';

function luminance(rgb: number[]): number {
  const linear = rgb.map(value => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
export function interactiveContrast(a: string, b: string): number {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 0;
  const l = luminance(x), r = luminance(y);
  return (Math.max(l, r) + 0.05) / (Math.min(l, r) + 0.05);
}

/** Keep the chosen fill untouched; derive ink separately for each palette. */
export function interactiveAccentColors(theme: { primary: string; text: string; background: string; surface: string; surfaceRaised: string }) {
  const onPrimary = interactiveContrast('#000000', theme.primary) >= interactiveContrast('#ffffff', theme.primary) ? '#000000' : '#ffffff';
  const rgb = hexToRgb(theme.primary), target = hexToRgb(theme.text);
  const surfaces = [theme.background, theme.surface, theme.surfaceRaised];
  let primaryText = theme.text;
  if (rgb && target) for (let step = 0; step <= 100; step++) {
    const candidate = '#' + rgb.map((c, i) => Math.round(c + (target[i]! - c) * step / 100).toString(16).padStart(2, '0')).join('');
    if (surfaces.every(surface => interactiveContrast(candidate, surface) >= 4.5)) { primaryText = candidate; break; }
  }
  return { primaryText, onPrimary };
}
