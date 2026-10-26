import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('application support widget', () => {
  it('does not load or retain the floating Tip button', () => {
    const page = readFileSync(join(here, 'page.tsx'), 'utf8');
    const css = readFileSync(join(here, 'globals.css'), 'utf8');

    expect(page).not.toContain('KoFiScript');
    expect(css).not.toContain('floatingchat-container-wrap');
    expect(existsSync(join(here, '..', 'components', 'welcome', 'KoFiScript.tsx'))).toBe(false);
  });
});
