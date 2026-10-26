import { describe, it, expect } from 'vitest';
import { newId } from './ids';

describe('newId', () => {
  it('returns a non-empty string', () => {
    expect(newId()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('returns unique values across many calls', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) ids.add(newId());
    expect(ids.size).toBe(1000);
  });
});
