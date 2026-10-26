import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');

function source(relativePath: string): string {
  return readFileSync(join(here, relativePath), 'utf8');
}

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1]!;
}

describe('application typography contract', () => {
  it('keeps small Atkinson CSS roles at 12px', () => {
    for (const selector of [
      '.welcome-section-label',
      '.search-results-caption',
      '.gc-section-label',
      '.gc-hex',
      '.gc-add-btn',
      '.node-type-menu-chip',
      '.shortcut-notice',
      '.sc-modelpicker-group-head',
      '.sc-media-heavy',
      '.ie-slider-head',
      '.ie-slider-num',
      '.ie-slider-suffix',
      '.ie-dd-item-sub',
    ]) {
      expect(ruleBody(selector), selector).toMatch(/font-size:\s*12px\s*;/);
    }
  });

  it('raises inline 11px Atkinson roles while retaining 11px monospace diagnostics', () => {
    for (const relativePath of [
      'dev/PromptsEditor.tsx',
      'dev/BulletSizingSliders.tsx',
      'dev/CopyButton.tsx',
      'welcome/WelcomeScreenA.tsx',
    ]) {
      expect(source(relativePath), relativePath).not.toMatch(/fontSize:\s*11(?![\d.])/);
    }

    const pixelRuler = source('dev/PixelRuler.tsx');
    expect(pixelRuler.match(/fontSize:\s*11,/g)).toHaveLength(2);
    expect(pixelRuler.match(/fontFamily:\s*'ui-monospace, "SF Mono", monospace'/g)).toHaveLength(2);
  });
});
