import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { readInteractiveTheme } from '@/lib/interactiveTheme';

const read = (name: string) => readFileSync(`${process.cwd()}/src/app/${name}.css`, 'utf8');
const globalCss = read('globals');

describe('shared UI border contrast', () => {
  it('defines one theme-aware neutral outline for the whole app', () => {
    expect(globalCss).toContain('--ui-line: color-mix(in oklab, var(--overlay0) 60%, transparent)');
    expect(read('settings')).toContain('--settings-line: var(--ui-line)');
    expect(read('onboarding')).toContain('--settings-line: var(--ui-line)');
  });
  it('keeps neutral outlines in shared controls, dialogs, and viewers on the common token', () => {
    const stale: string[] = [];
    postcss.parse(globalCss).walkDecls(/^border/, declaration => {
      if (/var\(--overlay0\) (?:[12]?\d|[3-5]\d)%/.test(declaration.value)) stale.push(declaration.toString());
    });
    expect(stale).toEqual([]);
  });
  it('passes the shared outline into generated interactive content', () => {
    document.documentElement.style.setProperty('--ui-line', 'rgba(85,85,85,0.6)');
    try { expect(readInteractiveTheme().border).toBe('rgba(85,85,85,0.6)'); }
    finally { document.documentElement.style.removeProperty('--ui-line'); }
  });
});
