import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({
  selectors: match[1]!.trim().split(',').map(selector => selector.trim()),
  declarations: match[2]!,
}));
const interactive = '.node.interactive-standalone .node-header .chat-inline-title';

describe('interactive node header typography', () => {
  it('shares the standard node title typography rather than duplicating its values', () => {
    const titleRule = rules.find(rule => rule.selectors.includes('.node-title'))!;
    expect(titleRule.selectors).toContain(interactive);
    expect(titleRule.declarations).toMatch(/font-size:\s*18px/);
    expect(titleRule.declarations).toMatch(/font-weight:\s*600/);
    expect(titleRule.declarations).toMatch(/line-height:\s*1\.35/);
  });

  it('uses the chosen node font and its size compensation', () => {
    const fontRule = rules.find(rule => rule.selectors.includes('.node .node-title'))!;
    expect(fontRule.selectors).toContain(interactive);
    expect(fontRule.declarations).toContain('font-family: var(--sc-node-font-family)');
    expect(fontRule.declarations).toContain('font-size-adjust: var(--sc-node-font-size-adjust)');
  });

  it('prevents the generating label from changing the title font, color, or spacing', () => {
    const childRule = rules.find(rule => rule.selectors.includes(`${interactive} > span`))!;
    expect(childRule.declarations).toContain('font: inherit');
    expect(childRule.declarations).toContain('color: inherit');
    expect(childRule.declarations).toContain('margin: 0');
  });

  it('limits resting titles to three lines without clipping an active title edit', () => {
    const clampRule = rules.find(rule => rule.selectors.includes(`${interactive}:not(.is-editing) > span`))!;
    expect(clampRule.declarations).toContain('-webkit-line-clamp: 3');
    const editRule = rules.find(rule => rule.selectors.includes(`${interactive}.is-editing`))!;
    expect(editRule.declarations).toContain('max-height: none');
    expect(editRule.declarations).toContain('overflow: visible');
  });
});
