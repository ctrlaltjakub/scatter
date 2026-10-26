import { describe, it, expect, beforeEach } from 'vitest';
import { useArrowLabelStore, type DesiredLabel } from './useArrowLabelStore';
import { STATUS_DELETE_MS_PER_CHAR } from '@/lib/asciiAura/statusText';

const desired = (m: Record<string, string>): Map<string, DesiredLabel> =>
  new Map(Object.entries(m).map(([id, text]) => [id, {
    text,
    targetNodeId: 'child',
    hitRect: { x: 0, y: 0, w: 10, h: 10 },
    cells: [],
    accents: [],
  }]));

beforeEach(() => useArrowLabelStore.setState({ entries: {} }));

describe('useArrowLabelStore.reconcile', () => {
  it('types in a new label (startedAt = now, clearedAt null)', () => {
    useArrowLabelStore.getState().reconcile(desired({ a: 'CHILD' }), 1000);
    const e = useArrowLabelStore.getState().entries['a']!;
    expect(e.startedAt).toBe(1000);
    expect(e.clearedAt).toBeNull();
    expect(e.text).toBe('CHILD');
  });

  it('reflows in place WITHOUT retyping when the text changes', () => {
    const s = useArrowLabelStore.getState();
    s.reconcile(desired({ a: 'CHILD' }), 1000);
    s.reconcile(desired({ a: 'PARENT' }), 2000);
    const e = useArrowLabelStore.getState().entries['a']!;
    expect(e.startedAt).toBe(1000); // animation NOT restarted
    expect(e.text).toBe('PARENT');
  });

  it('begins the delete animation when a label drops out of the desired set', () => {
    const s = useArrowLabelStore.getState();
    s.reconcile(desired({ a: 'AB' }), 1000);
    s.reconcile(desired({}), 2000);
    const e = useArrowLabelStore.getState().entries['a']!;
    expect(e.clearedAt).toBe(2000);
    expect(e.text).toBe('AB'); // keeps the last text/cells so the wipe can play
  });

  it('prunes an entry once its delete animation finishes', () => {
    const s = useArrowLabelStore.getState();
    s.reconcile(desired({ a: 'AB' }), 1000);
    s.reconcile(desired({}), 2000);
    const after = 2000 + 2 * STATUS_DELETE_MS_PER_CHAR + 100;
    s.reconcile(desired({}), after);
    expect(useArrowLabelStore.getState().entries['a']).toBeUndefined();
  });

  it('restarts type-on if a label reappears after it began deleting', () => {
    const s = useArrowLabelStore.getState();
    s.reconcile(desired({ a: 'AB' }), 1000);
    s.reconcile(desired({}), 2000); // clearing
    s.reconcile(desired({ a: 'AB' }), 2010); // wanted again before fully gone
    const e = useArrowLabelStore.getState().entries['a']!;
    expect(e.clearedAt).toBeNull();
    expect(e.startedAt).toBe(2010);
  });
});
