import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');

describe('connected topic picker tab geometry', () => {
  it('stacks inactive tabs from Topic to Chat to Image, with the selected tab above them', () => {
    for (const [child, layer] of [[1, 3], [2, 2], [3, 1]]) {
      const rule = css.match(new RegExp(`\\.welcome-start-tab:nth-child\\(${child}\\)\\s*\\{([^}]+)\\}`))?.[1] ?? '';
      expect(rule).toMatch(new RegExp(`z-index:\\s*${layer};`));
    }
    const active = css.match(/\.welcome-start-tab\.is-active\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(active).toMatch(/z-index:\s*5;/);
  });

  it('places the window border in front of inactive tabs but behind the active tab', () => {
    const frame = css.match(/\.welcome-picker-frame\s*\{([^}]+)\}/)?.[1] ?? '';
    const tabs = css.match(/\.welcome-start-tabs\s*\{([^}]+)\}/)?.[1] ?? '';
    const panel = css.match(/\.welcome-picker-shell\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(frame).toContain('isolation: isolate');
    expect(tabs).not.toMatch(/z-index\s*:/);
    expect(panel).toMatch(/z-index:\s*4;/);
  });

  it('puts Chat in front of Topic when Image is selected', () => {
    const reverse = css.match(/\.welcome-start-tabs:has\(\.welcome-start-tab:nth-child\(3\)\.is-active\)\s*>\s*\.welcome-start-tab:nth-child\(1\)\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(reverse).toMatch(/z-index:\s*1;/);
  });

  it('uses one outline instead of overlapping CSS borders and gradient curves', () => {
    const shape = css.match(/\.welcome-start-tab-shape\s*\{([^}]+)\}/)?.[1] ?? '';
    const tab = css.match(/\.welcome-start-tab\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(shape).toContain('top: -1px');
    expect(shape).toContain('height: calc(100% + 2px)');
    expect(shape).toContain('pointer-events: none');
    expect(tab).toContain('border: 1px solid transparent');
    expect(tab).toContain('background: none');
    expect(css).not.toMatch(/\.welcome-start-tab::(?:before|after)/);
  });
});
