import { hexToRgb, resolveColorHex } from './groupColor';
import { DEFAULT_INTERACTIVE_HOST_STATE, type InteractiveHostTheme } from './interactiveDocument';
import { interactiveAccentColors } from './interactiveColors';

/** Read the other real app palette without changing the user's theme or
 * flashing the canvas. Accent, typography and geometry stay unchanged. */
export function alternateInteractiveTheme(theme: InteractiveHostTheme): InteractiveHostTheme {
  const mode = theme.mode === 'light' ? 'dark' : 'light';
  const fallback = mode === 'light' ? DEFAULT_INTERACTIVE_HOST_STATE.theme : {
    background: '#101010', surface: '#292929', surfaceRaised: '#101010', text: '#e8e8e8', muted: '#b8b8b8',
    border: 'rgba(85,85,85,0.6)', success: '#a6e3a1', warning: '#f9e2af', danger: '#f38ba8', shadow: '0 4px 16px rgba(0,0,0,0.25)',
  };
  const probe = typeof document === 'undefined' ? undefined : document.createElement('div');
  if (probe) { probe.hidden = true; probe.dataset.theme = mode === 'light' ? 'latte' : 'mocha'; document.body.appendChild(probe); }
  try {
    const style = probe ? getComputedStyle(probe) : undefined;
    const token = (name: string, value: string) => style?.getPropertyValue(name).trim() || value;
    const overlay = style?.getPropertyValue('--overlay0').trim();
    const palette: InteractiveHostTheme = { ...theme, mode,
      background: token('--card-bg', fallback.background), surface: token('--field-bg', fallback.surface),
      surfaceRaised: token('--panel-bg', fallback.surfaceRaised), text: token('--text', fallback.text), muted: token('--subtext0', fallback.muted),
      border: overlay ? `color-mix(in oklab, ${overlay} 60%, transparent)` : fallback.border,
      success: token('--green', fallback.success), warning: token('--yellow', fallback.warning), danger: token('--red', fallback.danger),
      shadow: token('--shadow', fallback.shadow),
    };
    return { ...palette, ...interactiveAccentColors(palette) };
  } finally { probe?.remove(); }
}

/** The sandbox receives presentation tokens only, never settings or credentials. */
export function readInteractiveTheme(accent?: string | null): InteractiveHostTheme {
  if (typeof document === 'undefined') return DEFAULT_INTERACTIVE_HOST_STATE.theme;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const primary = accent ? resolveColorHex(accent) : token('--subtext0', '#6e6e6e');
  const rgb = hexToRgb(primary);
  const palette: InteractiveHostTheme = {
    ...DEFAULT_INTERACTIVE_HOST_STATE.theme,
    mode: document.documentElement.dataset.theme === 'mocha' ? 'dark' : 'light',
    background: token('--card-bg', '#fff'), surface: token('--field-bg', '#f5f5f5'),
    surfaceRaised: token('--panel-bg', '#fff'), text: token('--text', '#1a1a1a'),
    muted: token('--subtext0', '#5c5c5c'), border: token('--ui-line', 'rgba(163,163,163,0.6)'),
    primary, primarySoft: rgb ? `rgba(${rgb.join(',')},0.18)` : primary,
    success: token('--green', '#40a02b'), warning: token('--yellow', '#df8e1d'), danger: token('--red', '#d20f39'),
    // Next's private font-face names do not exist inside an opaque sandbox.
    fontFamily: `${getComputedStyle(document.body).fontFamily || 'Arial'}, Arial, sans-serif`,
    shadow: token('--shadow', 'none'),
    radiusSm: token('--r-sm', '4px'), radiusMd: token('--r-md', '6px'), radiusLg: token('--r-lg', '8px'),
    cursors: Object.fromEntries(['pointer', 'click', 'press', 'text', 'move', 'grab', 'hand', 'ban'].map(name =>
      [name, token(`--cur-${name}`, name === 'click' ? 'pointer' : name === 'ban' ? 'not-allowed' : 'default')])),
  };
  return { ...palette, ...interactiveAccentColors(palette) };
}
