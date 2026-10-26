import { readFileSync } from 'node:fs';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = parse(readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8'));

function background(selector: string) {
  let value: string | undefined;
  css.walkRules(selector, rule => {
    rule.walkDecls('background', declaration => { value = declaration.value; });
  });
  return value;
}

describe('sidebar project and group tints', () => {
  it.each([
    ['', 15], [':hover', 21], ['.active', 30], ['.active:hover', 36],
  ])('uses a stronger light-mode fill for %s', (state, opacity) => {
    expect(background(`.sidebar-row.has-accent${state}`))
      .toBe(`color-mix(in oklab, var(--row-accent) ${opacity}%, transparent)`);
  });

  it.each([
    ['', 4], [':hover', 6], ['.active', 8], ['.active:hover', 9],
  ])('preserves the existing dark-mode fill for %s', (state, opacity) => {
    expect(background(`[data-theme="mocha"] :is(.sidebar-row.has-accent, .group-popover-row.has-accent)${state}`))
      .toBe(`color-mix(in oklab, var(--row-accent) ${opacity}%, transparent)`);
  });
});
