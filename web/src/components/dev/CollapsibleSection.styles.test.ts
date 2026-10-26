import { readFileSync } from 'node:fs';
import { parse } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = parse(readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8'));

describe('disclosure header feedback', () => {
  it('excludes disclosure headers from the shared dark-mode hover and pressed outlines', () => {
    const rules: string[] = [];
    css.walkRules(rule => {
      if (rule.selector.includes('[data-theme="mocha"] button:not(:disabled):not(.ref-chip)')
        && (rule.selector.endsWith(':is(:hover, :focus-visible)') || rule.selector.endsWith(':active'))) {
        rules.push(rule.selector);
      }
    });
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule).toContain(':not(.settings-collapsible-trigger)');
  });

  it('keeps a dedicated keyboard focus outline', () => {
    let outline: string | undefined;
    css.walkRules('.settings-collapsible-trigger:focus-visible', rule => {
      rule.walkDecls('outline', declaration => { outline = declaration.value; });
    });
    expect(outline).toBe('2px solid var(--overlay1)');
  });

  it('suppresses a retained keyboard ring when the pointer returns to the heading', () => {
    let outline: string | undefined;
    css.walkRules('.settings-collapsible .settings-collapsible-trigger:is(:hover, :active)', rule => {
      rule.walkDecls('outline', declaration => { outline = declaration.value; });
    });
    expect(outline).toBe('none');
  });
});
