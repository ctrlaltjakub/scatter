import { afterEach, describe, expect, it } from 'vitest';
import { alternateInteractiveTheme } from './interactiveTheme';
import { DEFAULT_INTERACTIVE_HOST_STATE } from './interactiveDocument';

afterEach(() => { document.head.querySelector('[data-test-palette]')?.remove(); delete document.documentElement.dataset.theme; });
describe('alternate interactive review theme', () => {
  it('reads actual app palette tokens without toggling the app or retaining a probe', () => {
    const style = document.createElement('style'); style.dataset.testPalette = '';
    style.textContent = '[data-theme="latte"]{--card-bg:#ffffff;--text:#1a1a1a;--field-bg:#f5f5f5;--overlay0:#a3a3a3}';
    document.head.appendChild(style); document.documentElement.dataset.theme = 'mocha';
    const before = document.body.childElementCount;
    const theme = alternateInteractiveTheme({ ...DEFAULT_INTERACTIVE_HOST_STATE.theme, mode: 'dark', primary: '#aabbcc', fontFamily: 'A readable font' });
    expect(theme).toMatchObject({ mode: 'light', background: '#ffffff', text: '#1a1a1a', primary: '#aabbcc', fontFamily: 'A readable font' });
    expect(theme.border).toContain('#a3a3a3');
    expect(document.documentElement.dataset.theme).toBe('mocha');
    expect(document.body.childElementCount).toBe(before);
  });
  it('has a dark fallback while keeping the project accent and typography', () => {
    const original = { ...DEFAULT_INTERACTIVE_HOST_STATE.theme, primary: '#123456' };
    const theme = alternateInteractiveTheme(original);
    expect(theme).toMatchObject({ mode: 'dark', background: '#101010', text: '#e8e8e8', primary: '#123456', fontFamily: original.fontFamily });
    expect(original.mode).toBe('light');
  });
});
