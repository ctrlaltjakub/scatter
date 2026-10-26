import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const globals = readFileSync(`${process.cwd()}/src/app/globals.css`, 'utf8');
const settings = readFileSync(`${process.cwd()}/src/app/settings.css`, 'utf8');

describe('provider connection highlight geometry', () => {
  it('rounds the trigger inside the card border so its highlight is not clipped', () => {
    const card = globals.match(/\.sc-provider-card\s*\{([^}]+)\}/)?.[1] ?? '';
    const trigger = settings.match(/\.settings-provider-trigger\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(card).toContain('--provider-card-radius: 10px');
    expect(card).toContain('border-radius: var(--provider-card-radius)');
    expect(trigger).toContain('border-radius: calc(var(--provider-card-radius) - 1px)');
  });

  it('keeps the expanded trigger square only where it meets the settings body', () => {
    const open = settings.match(/\.settings-provider-card\.is-open\s*>\s*\.settings-provider-trigger\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(open).toContain('border-bottom-left-radius: 0');
    expect(open).toContain('border-bottom-right-radius: 0');
    expect(open).not.toMatch(/border-top|\bborder-radius\s*:/);
  });
});
