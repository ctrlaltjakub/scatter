import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
const nodeView = readFileSync(`${process.cwd()}/src/components/canvas/NodeView.tsx`, 'utf8');
const controller = readFileSync(
  `${process.cwd()}/src/components/canvas/NodeOverviewController.tsx`,
  'utf8',
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

describe('low-zoom overview performance contract', () => {
  it('keeps fit buttons clickable above overview paint and only counter-scales skeleton cards', () => {
    expect(rule('.node-fit-btn')).toMatch(/z-index:\s*7/);
    expect(rule('.node-fit-btn')).toMatch(/transform-origin:\s*bottom right/);
    expect(rule('.node[data-node-overview-active] > .node-fit-btn')).toMatch(/scale\(var\(--node-overview-control-scale/);
    const media = rule('[data-node-overview] .node:not(.node-overview-eligible) > .node-fit-btn');
    expect(media).toMatch(/visibility:\s*hidden/);
    expect(media).toMatch(/pointer-events:\s*none/);
  });

  it('keeps a readable near-threshold fallback after the ordinary title rule', () => {
    const titleRule = rule('.node-overview-surface .node-overview-title');
    expect(titleRule).toMatch(/font-size:\s*34px/);
    expect(titleRule).toMatch(/line-height:\s*1\.2/);
  });

  it('isolates skeleton layout and keeps zoom-varying variables off the canvas root', () => {
    const surface = rule('.node-overview-surface');
    expect(surface).toMatch(/contain:\s*strict/);
    expect(surface).toMatch(/content-visibility:\s*auto/);
    expect(controller).not.toContain("container.style.setProperty('--node-overview-control-scale'");
  });

  it('uses direct inline opacity handoff without selector invalidation or clip animations', () => {
    expect(controller).toContain("detail.style.opacity = overview ? '0' : '1'");
    expect(controller).toContain("title.style.opacity = overview ? '1' : '0'");
    expect(css).not.toContain('.canvas-host.node-overview-mode');
    expect(css).not.toContain('node-detail-surface--overview-hidden');
    expect(css).not.toContain('node-overview-surface--visible');
    expect(css).not.toContain('@keyframes sc-node-detail-delete');
    expect(css).not.toContain('@keyframes sc-node-overview-write');
    expect(rule('.node-detail-surface')).not.toMatch(/transition:/);
    expect(rule('.node-overview-surface')).not.toMatch(/transition:/);
  });

  it('does not mount or unmount node subtrees at the zoom threshold', () => {
    expect(nodeView).not.toContain('useNodeOverviewStore');
    expect(nodeView).not.toContain('renderDetail');
    expect(nodeView).not.toContain('renderOverview');
    expect(controller).not.toContain('setTimeout');
    expect(controller).toContain('requestAnimationFrame');
    expect(controller).toContain('applyNodeOverviewMode(container, overview, animate)');
    // The threshold marker is allowed for floating panels only. Node text
    // still uses the direct opacity/content-visibility handoff above.
    expect(controller).toContain("container.toggleAttribute('data-node-overview', overview)");
    const panels = rule('[data-node-overview] :is(.node-side-panel-stack, .side-panel, .citations-panel, .node-followup-bar, .node-type-menu)');
    expect(panels).toMatch(/visibility:\s*hidden/);
    expect(panels).toMatch(/pointer-events:\s*none/);
    expect(panels).not.toMatch(/display:/);
  });
});
