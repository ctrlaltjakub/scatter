import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

describe('image editor panel layout', () => {
  it('uses the card and actual bottom bar as the side panel height boundary', () => {
    expect(rule('.image-editor-stage .text-editor-group')).toMatch(/position:\s*relative/);
    expect(rule('.image-editor-stage .text-editor-panel')).toMatch(/position:\s*absolute/);
    expect(rule('.image-editor-stage .text-editor-panel')).toMatch(/max-height:\s*100%/);
    expect(rule('.image-editor-cardwrap > .image-followup-bar')).toMatch(/position:\s*relative/);
    expect(rule('.image-editor-cardwrap > .image-followup-bar')).toMatch(/top:\s*auto/);
    expect(rule('.image-editor-card')).toMatch(/min-height:\s*120px/);
  });

  it('keeps overflow within the controls, with image navigation outside the scroll area', () => {
    expect(rule('.image-editor-stage .text-editor-panel')).toMatch(/overflow:\s*hidden/);
    expect(rule('.ie-panel-main')).toMatch(/overflow-y:\s*auto/);
    expect(rule('.ie-panel-main')).toMatch(/min-height:\s*0/);
    expect(rule('.ie-navigation')).toMatch(/flex-shrink:\s*0/);
    expect(rule('.image-editor-cardwrap')).toMatch(/max-height:\s*calc\(100dvh - 48px\)/);
  });

  it('keeps point text unboxed and gives paragraph text wrapping and an outline', () => {
    expect(rule('.ie-text-input')).toMatch(/border:\s*0/);
    expect(rule('.ie-text-input')).toMatch(/white-space:\s*pre\s*;/);
    expect(rule('.ie-text-input.is-boxed')).toMatch(/outline:\s*1px dashed/);
    expect(rule('.ie-text-input.is-boxed')).toMatch(/white-space:\s*pre-wrap/);
  });
});
