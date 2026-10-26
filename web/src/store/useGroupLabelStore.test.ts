import { beforeEach, describe, expect, it } from 'vitest';
import { statusGlyphIndex } from '@/lib/asciiAura/statusText';
import { useGroupLabelStore, type DesiredGroupLabel } from './useGroupLabelStore';

const desired = (text = 'GROUP'): DesiredGroupLabel => ({
  text,
  groupId: 'g',
  target: { kind: 'group', groupId: 'g' },
  colorSourceNodeId: 'n',
  rect: { x: 10, y: 20, w: 50, h: 10 },
  cells: [{ col: 1, row: 2, glyphIndex: statusGlyphIndex('G')!, worldX: 15, worldY: 25 }],
});

beforeEach(() => useGroupLabelStore.setState({ entries: {} }));

describe('useGroupLabelStore', () => {
  it('starts a new label and preserves its animation while reflowing', () => {
    const store = useGroupLabelStore.getState();
    store.reconcile(new Map([['g:n', desired()]]), 100);
    const first = useGroupLabelStore.getState().entries['g:n']!;
    expect(first.startedAt).toBe(100);

    useGroupLabelStore.getState().reconcile(new Map([['g:n', {
      ...desired(),
      rect: { x: 30, y: 20, w: 50, h: 10 },
    }]]), 200);
    const moved = useGroupLabelStore.getState().entries['g:n']!;
    expect(moved.startedAt).toBe(100);
    expect(moved.rect.x).toBe(30);
  });

  it('deletes missing labels and restarts if they return', () => {
    useGroupLabelStore.getState().reconcile(new Map([['g:n', desired()]]), 100);
    useGroupLabelStore.getState().reconcile(new Map(), 200);
    expect(useGroupLabelStore.getState().entries['g:n']!.clearedAt).toBe(200);

    useGroupLabelStore.getState().reconcile(new Map([['g:n', desired()]]), 250);
    expect(useGroupLabelStore.getState().entries['g:n']!.startedAt).toBe(250);
    expect(useGroupLabelStore.getState().entries['g:n']!.clearedAt).toBeNull();
  });

  it('keeps old split/merge identities deleting while starting the replacements', () => {
    useGroupLabelStore.getState().reconcile(new Map([['g:a|b', desired()]]), 100);
    useGroupLabelStore.getState().reconcile(new Map([
      ['g:a', desired()],
      ['g:b', desired()],
    ]), 200);
    const entries = useGroupLabelStore.getState().entries;
    expect(entries['g:a|b']!.clearedAt).toBe(200);
    expect(entries['g:a']!.startedAt).toBe(200);
    expect(entries['g:b']!.startedAt).toBe(200);
  });
});
