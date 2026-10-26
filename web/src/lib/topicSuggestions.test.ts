import { describe, expect, test } from 'vitest';
import { TOPIC_SUGGESTIONS, shuffle, intoRows } from './topicSuggestions';

describe('shuffle', () => {
  test('returns a permutation (same multiset of items)', () => {
    const out = shuffle(TOPIC_SUGGESTIONS);
    expect(out).toHaveLength(TOPIC_SUGGESTIONS.length);
    expect([...out].sort()).toEqual([...TOPIC_SUGGESTIONS].sort());
  });

  test('does not mutate the input', () => {
    const copy = [...TOPIC_SUGGESTIONS];
    shuffle(TOPIC_SUGGESTIONS);
    expect(TOPIC_SUGGESTIONS).toEqual(copy);
  });
});

describe('TOPIC_SUGGESTIONS integrity', () => {
  test('no case-insensitive duplicates and a healthy pool size', () => {
    const lower = TOPIC_SUGGESTIONS.map((t) => t.trim().toLowerCase());
    expect(new Set(lower).size).toBe(TOPIC_SUGGESTIONS.length);
    expect(TOPIC_SUGGESTIONS.length).toBeGreaterThan(300);
    expect(TOPIC_SUGGESTIONS.every((t) => t.trim().length > 0)).toBe(true);
  });
});

describe('intoRows', () => {
  test('round-robins into n rows that together cover every item', () => {
    const rows = intoRows([1, 2, 3, 4, 5, 6, 7], 3);
    expect(rows).toHaveLength(3);
    expect(rows.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // round-robin → row lengths differ by at most 1
    const lens = rows.map((r) => r.length);
    expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(1);
  });
});
