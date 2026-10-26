import { describe, expect, test } from 'vitest';
import { splitOutBullet } from './generate';

/**
 * Unit tests for splitOutBullet — the body surgery behind "Pop selected".
 * It must remove the WHOLE level-1 bullet (title line + its children),
 * unlike locateSection which excludes the title line for a bullet.
 */
const BODY = [
  'An opening paragraph about the topic.',
  '',
  '- **First** chapter',
  '  - alpha: the first child',
  '  - beta: the second child',
  '- **Second** chapter',
  '  - gamma: another child',
  '- **Third** chapter',
  '  - delta: last child',
].join('\n');

describe('splitOutBullet', () => {
  test('removes the whole middle bullet (title + children) from the parent', () => {
    const r = splitOutBullet(BODY, 1);
    expect(r).not.toBeNull();
    expect(r!.titleLine).toBe('- **Second** chapter');
    expect(r!.childLines).toEqual(['  - gamma: another child']);
    // Parent keeps first + third, not second.
    expect(r!.newParentBody).toContain('- **First** chapter');
    expect(r!.newParentBody).toContain('- **Third** chapter');
    expect(r!.newParentBody).not.toContain('Second');
    expect(r!.newParentBody).not.toContain('gamma');
    // Opening paragraph preserved.
    expect(r!.newParentBody).toContain('An opening paragraph');
  });

  test('removes the first bullet and its children', () => {
    const r = splitOutBullet(BODY, 0);
    expect(r!.titleLine).toBe('- **First** chapter');
    expect(r!.childLines).toEqual(['  - alpha: the first child', '  - beta: the second child']);
    expect(r!.newParentBody).not.toContain('First');
    expect(r!.newParentBody).not.toContain('alpha');
    expect(r!.newParentBody).toContain('- **Second** chapter');
  });

  test('removes the last bullet through end-of-body', () => {
    const r = splitOutBullet(BODY, 2);
    expect(r!.titleLine).toBe('- **Third** chapter');
    expect(r!.childLines).toEqual(['  - delta: last child']);
    expect(r!.newParentBody).not.toContain('Third');
    expect(r!.newParentBody).not.toContain('delta');
    expect(r!.newParentBody).toContain('- **Second** chapter');
  });

  test('returns null for an out-of-range index', () => {
    expect(splitOutBullet(BODY, 9)).toBeNull();
  });
});
