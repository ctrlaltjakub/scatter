import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(`${process.cwd()}/src/app/page.tsx`, 'utf8');

describe('keyboard camera movement', () => {
  it('increases the previous 3px step by 50% and keeps diagonal speed normalized', () => {
    expect(page).toMatch(/const PAN_STEP = 4\.5;/);
    expect(page).toContain('dx *= Math.SQRT1_2; dy *= Math.SQRT1_2;');
    expect(page).toContain('lv.setPan(lv.x + dx * PAN_STEP, lv.y + dy * PAN_STEP)');
  });
});
