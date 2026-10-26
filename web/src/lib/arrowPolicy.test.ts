import { describe, expect, it } from 'vitest';
import { isArrowVisible, planNodeDeletion } from './arrowPolicy';
import { createChatNode } from './chat/model';
import type { Arrow, Project } from '@/store/types';

const arrow = (id: string, from: string, to: string, kind: Arrow['kind'] = 'auto', createdAt = 1): Arrow =>
  ({ id, fromNodeId: from, toNodeId: to, kind, createdAt, gravitates: kind === 'dotted' });
function project(arrows: Arrow[]): Project {
  const ids = new Set(arrows.flatMap((a) => [a.fromNodeId, a.toNodeId]));
  return { id: 'p', name: 'P', createdAt: 1, updatedAt: 1, rootNodeId: 'root', groups: {}, selection: [],
    viewport: { x: 0, y: 0, zoom: 1 }, arrows: Object.fromEntries(arrows.map((a) => [a.id, a])),
    nodes: Object.fromEntries([...ids].map((id) => [id, createChatNode({ id, createdAt: 1, position: { x: 20, y: 30 }, bodyHeight: 600 })])) };
}
describe('shared branch references', () => {
  it('shows all parts of a dotted connection only for either focused endpoint', () => {
    const a = arrow('ref', 'a', 'b', 'dotted');
    expect(isArrowVisible(a, [])).toBe(false);
    expect(isArrowVisible(a, ['c'])).toBe(false);
    expect(isArrowVisible(a, ['a'])).toBe(true);
    expect(isArrowVisible(a, ['b'])).toBe(true);
    expect(isArrowVisible({ ...a, kind: 'auto' }, [])).toBe(true);
  });
  it('preserves a referenced child and its descendants and promotes the earliest surviving reference', () => {
    const p = project([arrow('root-a', 'root', 'a'), arrow('a-b', 'a', 'b'), arrow('b-c', 'b', 'c'),
      arrow('new', 'other', 'b', 'dotted', 3), arrow('old', 'old-chat', 'b', 'dotted', 2)]);
    const before = structuredClone(p);
    const result = planNodeDeletion(p, 'a');
    expect([...result.deletedIds]).toEqual(['a']);
    expect([...result.promotedArrowIds]).toEqual(['old']);
    expect(p).toEqual(before);
  });
  it('does not preserve an explicitly deleted node or create ancestry cycles', () => {
    const p = project([arrow('a-b', 'a', 'b'), arrow('b-c', 'b', 'c'), arrow('c-b', 'c', 'b', 'dotted'),
      arrow('other-a', 'other', 'a', 'dotted')]);
    expect([...planNodeDeletion(p, 'a').deletedIds].sort()).toEqual(['a', 'b', 'c']);
  });
  it('does not create two parents when an outer branch is subsequently preserved', () => {
    const p = project([arrow('root-a', 'root', 'a'), arrow('a-b', 'a', 'b'), arrow('b-c', 'b', 'c'),
      arrow('ref-c', 'other', 'c', 'dotted', 1), arrow('ref-b', 'other', 'b', 'dotted', 2)]);
    const result = planNodeDeletion(p, 'a');
    expect([...result.deletedIds]).toEqual(['a']);
    expect([...result.promotedArrowIds]).toEqual(['ref-b']);
  });
});
