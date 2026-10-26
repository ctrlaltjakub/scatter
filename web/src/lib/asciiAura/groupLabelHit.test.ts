import { describe, expect, it } from 'vitest';
import { STATUS_DELETE_MS_PER_CHAR } from './statusText';
import { hitTestGroupLabels } from './groupLabelHit';

function entry(over: Record<string, unknown> = {}) {
  return {
    groupId: 'group-a',
    target: { kind: 'group' as const, groupId: 'group-a' },
    rect: { x: 10, y: 20, w: 60, h: 36 },
    startedAt: 1000,
    clearedAt: null,
    cells: [{}, {}],
    ...over,
  };
}

describe('hitTestGroupLabels', () => {
  it('hits the full wrapped rectangle, including spaces and line gaps', () => {
    const entries = { a: entry() };
    expect(hitTestGroupLabels(entries, 45, 38, 1100)).toEqual({ kind: 'group', groupId: 'group-a' });
    expect(hitTestGroupLabels(entries, 9.99, 38, 1100)).toBeNull();
    expect(hitTestGroupLabels(entries, 70, 38, 1100)).toBeNull();
  });

  it('only hits while at least one animated glyph is visible', () => {
    expect(hitTestGroupLabels({ a: entry() }, 45, 38, 999)).toBeNull();
    expect(hitTestGroupLabels({ a: entry() }, 45, 38, 1000)).toEqual({ kind: 'group', groupId: 'group-a' });

    const deleting = { a: entry({ clearedAt: 2000 }) };
    expect(hitTestGroupLabels(deleting, 45, 38, 2000)).toEqual({ kind: 'group', groupId: 'group-a' });
    expect(hitTestGroupLabels(deleting, 45, 38, 2000 + STATUS_DELETE_MS_PER_CHAR)).toBeNull();
  });

  it('prefers a live label over a disappearing overlap', () => {
    const entries = {
      old: entry({ groupId: 'old', target: { kind: 'group', groupId: 'old' }, clearedAt: 2000 }),
      live: entry({ groupId: 'live', target: { kind: 'group', groupId: 'live' }, startedAt: 1500 }),
    };
    expect(hitTestGroupLabels(entries, 45, 38, 2000)).toEqual({ kind: 'group', groupId: 'live' });
  });
});
