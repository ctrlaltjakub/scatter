import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

describe('empty media mode sizing', () => {
  it('reserves an identical control height in Generate and Attach modes', () => {
    expect(rule('.sc-media-image-generator')).toMatch(/height:\s*58px/);
    expect(rule('.sc-media-attach-options')).toMatch(/height:\s*58px/);
    expect(rule('.sc-media-image-prompt')).toMatch(/height:\s*58px/);
    expect(rule('.sc-media-generate')).toMatch(/width:\s*86px/);
    expect(rule('.sc-media-generate')).toMatch(/font-size:\s*12px/);
    expect(rule('.sc-media-attach-top')).toMatch(/height:\s*28px/);
    expect(rule('.sc-media-field')).toMatch(/height:\s*28px/);
    expect(rule('.sc-media-btn')).toMatch(/width:\s*72px/);
    expect(rule('.sc-media-upload')).toMatch(/min-height:\s*26px/);
  });

  it('keeps the shared theme-aware blur only in the future image area', () => {
    expect(rule('.node.image-generating')).toMatch(/background:\s*transparent/);
    expect(rule('.node.image-generating .node-body')).toMatch(/background:\s*transparent/);
    expect(rule('.node-body:has\(.sc-image-generation-skeleton\)')).toMatch(/padding:\s*0/);
    expect(rule('.sc-generation-skeleton-frame')).toMatch(/isolation:\s*isolate/);
    expect(rule('.sc-generation-skeleton-frame::before')).toMatch(/backdrop-filter:\s*blur\(5px\)/);
    expect(rule('.sc-generation-skeleton-frame::before')).toMatch(/will-change:\s*backdrop-filter/);
    expect(css).toMatch(/\.sc-generation-skeleton-frame::after\s*\{[^}]*animation:\s*sc-image-white-pulse/s);
    expect(css).toMatch(
      /@keyframes sc-image-white-pulse\s*\{[\s\S]*?0%,\s*100%\s*\{\s*opacity:\s*var\(--skeleton-pulse-high/,
    );
    expect(css).toMatch(
      /@keyframes sc-image-white-pulse\s*\{[\s\S]*?50%\s*\{\s*opacity:\s*var\(--skeleton-pulse-low/,
    );
  });

  it('uses the clickable tag resting opacity for every inert footer label', () => {
    expect(rule('.node-footer > .node-tag:not(button)')).toMatch(/opacity:\s*0\.7/);
    expect(rule('.node-tag--locked')).not.toMatch(/opacity:/);
  });

  it('gives every dark-mode footer label the same quiet resting treatment', () => {
    const tags = rule('[data-theme="mocha"] .node-footer > .node-tag:not(button)');
    expect(tags).toMatch(/background:[^;]*4%/);
    expect(tags).toMatch(/outline:\s*1px solid/);
    expect(tags).toMatch(/outline-offset:\s*-1px/);
  });

  it('keeps dark fact highlights pale without adding verdict borders', () => {
    const expectedOpacity = { supported: 16, mixed: 17, contradicted: 16 } as const;
    for (const verdict of ['supported', 'mixed', 'contradicted'] as const) {
      const darkRule = rule(`[data-theme="mocha"] .fact-check-unit.fact-${verdict}`);
      expect(darkRule).toMatch(new RegExp(`background:[^;]*${expectedOpacity[verdict]}%`));
      expect(darkRule).not.toMatch(/box-shadow|border|outline/);
    }
    const neutralRule = rule('[data-theme="mocha"] .fact-check-unit:is(.fact-unverified, .fact-failed)');
    expect(neutralRule).toMatch(/background:[^;]*13%/);
    expect(neutralRule).not.toMatch(/box-shadow|border|outline/);
  });

  it('keeps the dedicated interactive build on a readable card', () => {
    expect(rule('.node.interactive-standalone.interactive-generating')).toMatch(/background:\s*var\(--card-bg\)/);
    expect(rule('.interactive-node-body')).toMatch(/width:\s*764px/);
    expect(rule('.interactive-node-body')).toMatch(/height:\s*573px/);
    expect(rule('.sc-interactive-frame')).toMatch(/position:\s*absolute/);
    expect(rule('.interactive-build-log')).toMatch(/overflow:\s*auto/);
    expect(css).not.toContain('.sc-interactive-body-layout');
  });

  it('fits the interactive window around the program with an image-editor-style header', () => {
    expect(rule('.interactive-viewer-card')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule('.interactive-viewer-card')).toMatch(/grid-template-rows:\s*auto minmax\(0,\s*1fr\)/);
    expect(rule('.interactive-viewer-card')).toContain('var(--interactive-viewer-width, 960px) * var(--interactive-viewer-scale, 1)');
    expect(rule('.interactive-viewer-program-host')).toContain('var(--interactive-viewer-height, 720px) * var(--interactive-viewer-scale, 1)');
    expect(rule('.interactive-viewer-program-canvas')).toMatch(/width:\s*var\(--interactive-viewer-width,\s*960px\)/);
    expect(rule('.interactive-viewer-program-canvas')).toMatch(/height:\s*var\(--interactive-viewer-height,\s*720px\)/);
    expect(rule('.interactive-viewer-program-fit')).toMatch(/align-items:\s*start/);
    expect(rule('.interactive-viewer-program-fit')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(rule('.interactive-viewer-program-fit')).toMatch(/justify-items:\s*center/);
    expect(rule('.interactive-viewer-program-canvas')).toMatch(/transform-origin:\s*top center/);
    expect(rule('.interactive-viewer-toolbar')).toMatch(/align-items:\s*flex-start/);
    expect(css).toMatch(/\.structured-header-editor,\s*\.interactive-viewer-app-title\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*600;/);
    expect(css).not.toContain('.interactive-viewer-compose');
  });

  it('keeps interactive skeleton rows zoom-aware and dims only unfocused canvas programs', () => {
    const skeleton = rule('.node-overview-skeleton--interactive');
    expect(skeleton).toContain("url('../../public/node-overview-interactive.svg')");
    expect(skeleton).toMatch(/--overview-skeleton-cycle:\s*74/);
    expect(skeleton).not.toContain('--overview-skeleton-pattern-height:');
    expect(rule('.node-overview-skeleton')).toContain('calc(var(--overview-skeleton-unit) * var(--overview-skeleton-cycle))');
    const inactive = rule('.sc-interactive-frame-wrap--canvas.is-unfocused .sc-interactive-frame');
    expect(inactive).toContain('grayscale(1)');
    expect(inactive).toContain('opacity: 0.45');
    expect(rule('.node-interactive-open-btn')).not.toMatch(/width:|height:|color:|opacity:/);
  });

});
