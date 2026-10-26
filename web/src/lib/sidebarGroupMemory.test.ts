import { beforeEach, describe, expect, test } from 'vitest';
import {
  LAST_GROUPS_STORAGE_KEY,
  readLastGroupMemory,
  writeLastGroupMemory,
} from './sidebarGroupMemory';

describe('sidebar last-group memory', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips a group id separately for every project', () => {
    writeLastGroupMemory({ p1: 'g1', p2: 'g8' });

    expect(readLastGroupMemory()).toEqual({ p1: 'g1', p2: 'g8' });
    expect(localStorage.getItem(LAST_GROUPS_STORAGE_KEY)).toContain('"p2":"g8"');
  });

  test('ignores malformed or non-string saved entries', () => {
    localStorage.setItem(LAST_GROUPS_STORAGE_KEY, '{"p1":"g1","bad":42}');
    expect(readLastGroupMemory()).toEqual({ p1: 'g1' });

    localStorage.setItem(LAST_GROUPS_STORAGE_KEY, 'not json');
    expect(readLastGroupMemory()).toEqual({});
  });
});
