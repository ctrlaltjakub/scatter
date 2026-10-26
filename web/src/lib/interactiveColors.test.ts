import { describe, expect, it } from 'vitest';
import { interactiveAccentColors, interactiveContrast } from './interactiveColors';
import { alternateInteractiveTheme } from './interactiveTheme';
import { DEFAULT_INTERACTIVE_HOST_STATE } from './interactiveDocument';

describe('interactive accent ink', () => {
  it.each(['#00bcff', '#ffffff', '#000000', '#fffa00', '#9537cf', '#377eb8'])('keeps %s fills but makes ink readable in either palette', primary => {
    for (const mode of ['light', 'dark'] as const) {
      const theme = { ...DEFAULT_INTERACTIVE_HOST_STATE.theme, primary, ...(mode === 'dark'
        ? { background: '#101010', surface: '#292929', surfaceRaised: '#101010', text: '#e8e8e8' } : {}) };
      const ink = interactiveAccentColors(theme);
      expect(interactiveContrast(primary, ink.onPrimary)).toBeGreaterThanOrEqual(4.5);
      for (const surface of [theme.background, theme.surface, theme.surfaceRaised]) expect(interactiveContrast(ink.primaryText, surface)).toBeGreaterThanOrEqual(4.5);
      expect(theme.primary).toBe(primary);
    }
  });
  it('recomputes ink when capturing the alternate theme without changing the accent', () => {
    const light = { ...DEFAULT_INTERACTIVE_HOST_STATE.theme, primary: '#00bcff' };
    const dark = alternateInteractiveTheme(light);
    expect(dark.primary).toBe(light.primary);
    expect(dark.primaryText).toBe('#00bcff');
    expect(dark.onPrimary).toBe('#000000');
  });
});
