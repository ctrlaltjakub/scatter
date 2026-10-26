import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', '..', 'app', 'globals.css'), 'utf8');

describe('canvas overflow contract', () => {
  it('clips without creating a hidden scroll container', () => {
    const rule = css.match(/\.canvas-host\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/overflow:\s*clip\s*;/);
  });
});
