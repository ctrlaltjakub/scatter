import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(`${process.cwd()}/src/app/settings.css`, 'utf8');

describe('model assignment highlight geometry', () => {
  it('matches the first row highlight to the outer frame’s inner top corners', () => {
    const frame = styles.match(/\.settings-model-roles\s*\{([^}]+)\}/)?.[1] ?? '';
    const first = styles.match(/\.settings-model-role:first-child\s*>\s*\.settings-role-trigger\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(frame).toContain('border-radius: var(--r-lg)');
    expect(first).toContain('border-top-left-radius: calc(var(--r-lg) - 1px)');
    expect(first).toContain('border-top-right-radius: calc(var(--r-lg) - 1px)');
    expect(first).not.toMatch(/border-bottom/);
  });

  it('rounds the last row’s bottom only when its settings are collapsed', () => {
    const last = styles.match(/\.settings-model-role:last-child:not\(\.is-open\)\s*>\s*\.settings-role-trigger\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(last).toContain('border-bottom-left-radius: calc(var(--r-lg) - 1px)');
    expect(last).toContain('border-bottom-right-radius: calc(var(--r-lg) - 1px)');
    expect(last).not.toMatch(/border-top/);
  });

  it('keeps internal row edges square', () => {
    const trigger = styles.match(/\.settings-role-trigger\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(trigger).toContain('border-radius: 0');
  });
});
