import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const css = postcss.parse(readFileSync(join(app, 'text-links.css'), 'utf8'));
const globalCss = postcss.parse(readFileSync(join(app, 'globals.css'), 'utf8'));
const textLink = 'a[href]:not(:where(.btn, .icon-btn, .sc-sel-btn, [data-link-control]))';

function declarations(root: postcss.Root, selector: string) {
  const values: Record<string, string> = {};
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(decl => { values[decl.prop] = decl.value; });
  });
  return values;
}

describe('shared text-link presentation', () => {
  it('styles native text anchors without taking over buttons, icons, or linked-card layouts', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a href="https://example.org">Text</a><a href="/">Internal</a><a>Placeholder</a>'
      + '<a href="/" class="btn">Button</a><a href="/" class="icon-btn">Icon</a>'
      + '<a href="/" class="sc-sel-btn">Search selection</a><a href="/" data-link-control><strong class="app-link-label">Card</strong></a>';
    expect([...host.querySelectorAll(textLink)].map(link => link.textContent)).toEqual(['Text', 'Internal']);
    expect(host.querySelector('a[href][data-link-control] .app-link-label')?.textContent).toBe('Card');
  });

  it('matches term underlines and hover feedback, with pressed and keyboard states', () => {
    const resting = declarations(css, textLink);
    const term = declarations(globalCss, '.ref-chip.unexplored');
    for (const property of ['text-decoration', 'text-underline-offset', 'text-decoration-color']) {
      expect(resting[property], property).toBe(term[property]);
    }
    expect(resting.cursor).toBe('var(--cur-term)');
    expect(declarations(css, `${textLink}:is(:hover, :focus-visible)`)['text-decoration-color'])
      .toBe(declarations(globalCss, '.ref-chip.unexplored:hover')['text-decoration-color']);
    expect(declarations(css, `${textLink}:active`)['background-color']).toBe('var(--tint-4)');
    expect(declarations(css, `${textLink}:focus-visible`).outline).toBeTruthy();
    expect(resting['box-decoration-break']).toBe('clone');
    // Interaction feedback must not make adjacent text shift or wrap again.
    expect(readFileSync(join(app, 'text-links.css'), 'utf8')).not.toMatch(/(?:font-size|font-weight|padding|margin)\s*:/);
  });
});
