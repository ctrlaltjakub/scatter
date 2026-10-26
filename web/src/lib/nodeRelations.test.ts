import { describe, expect, it } from 'vitest';
import type { Arrow } from '@/store/types';
import { nodeRelations, relatedSelectedNodeId } from './nodeRelations';

const arrow = (id: string, extra: Partial<Arrow> = {}): Arrow => ({
  id, kind: 'auto', fromNodeId: 'parent', toNodeId: 'child', label: 'therapy', ...extra,
});
const sourceSelection: Arrow['sourceSelection'] = {
  sourceVersionCreatedAt: 2, createdAt: 3, text: 'therapy',
  parts: [{ sourceField: 'ft', start: 0, end: 7, text: 'therapy' }],
};

describe('cached node relationship index', () => {
  it('reuses lookups across reads and changes to other parents', () => {
    const arrows = { a: arrow('a') };
    const initial = nodeRelations(arrows, 'parent');
    expect(nodeRelations(arrows, 'parent')).toBe(initial);
    const next = { ...arrows, other: arrow('other', { fromNodeId: 'other' }) };
    expect(nodeRelations(next, 'parent')).toBe(initial);
    expect(nodeRelations(arrows, 'parent')).toBe(initial); // undo snapshot
    expect(nodeRelations(next, 'parent')).toBe(initial); // redo snapshot
  });

  it('invalidates changed/deleted relations and isolates projects reusing IDs', () => {
    const original = { a: arrow('a') };
    const first = nodeRelations(original, 'parent');
    const edited = { a: arrow('a', { label: 'code', toNodeId: 'new-child' }) };
    expect(nodeRelations(edited, 'parent').childByTerm.get('code')).toBe('new-child');
    expect(nodeRelations(edited, 'parent').childByTerm.has('therapy')).toBe(false);
    expect(nodeRelations({}, 'parent').childByTerm.size).toBe(0);
    expect(nodeRelations(undefined, 'parent').childByTerm.size).toBe(0);
    expect(nodeRelations(original, 'parent')).toBe(first);
  });

  it('preserves first-arrow order for duplicate labels and child bullet reveal', () => {
    const a = arrow('a');
    const b = arrow('b', { toNodeId: 'child-2' });
    const c = arrow('c', { label: 'other-term' });
    const first = nodeRelations({ a, b, c }, 'parent');
    expect(first.childByTerm.get('therapy')).toBe('child');
    expect(first.termChildIds.has('child-2')).toBe(false);
    expect(first.firstTermByChild.get('child-2')).toBe('therapy');
    expect(first.firstTermByChild.get('child')).toBe('therapy');
    const reordered = nodeRelations({ b, a, c }, 'parent');
    expect(reordered.childByTerm.get('therapy')).toBe('child-2');
    expect(reordered.termChildIds.has('child')).toBe(true); // other-term still targets it
  });

  it('separates auto arrows from exact chat answer scopes, including non-auto links', () => {
    const first = { turnId: 'turn', versionCreatedAt: 2 };
    const second = { turnId: 'turn', versionCreatedAt: 4 };
    const arrows = {
      normal: arrow('normal'),
      old: arrow('old', { toNodeId: 'old-child', sourceAnswer: first, sourceSelection }),
      new: arrow('new', { toNodeId: 'new-child', sourceAnswer: second }),
      manual: arrow('manual', { kind: 'dotted', label: 'code', sourceAnswer: first }),
      otherTurn: arrow('otherTurn', { toNodeId: 'other-child', sourceAnswer: { turnId: 'other', versionCreatedAt: 2 } }),
    };
    expect(nodeRelations(arrows, 'parent').childByTerm.has('code')).toBe(false);
    const old = nodeRelations(arrows, 'parent', first);
    expect(old.childByTerm.get('therapy')).toBe('old-child');
    expect(old.childByTerm.get('code')).toBe('child');
    expect(old.sourceSelections.map(a => a.id)).toEqual(['old']);
    expect(nodeRelations(arrows, 'parent', second).childByTerm.get('therapy')).toBe('new-child');
    expect(nodeRelations(arrows, 'parent', { ...first })).toBe(old);
    expect(nodeRelations(arrows, 'parent', { turnId: 'missing', versionCreatedAt: 2 }).childByTerm.size).toBe(0);
  });

  it('keeps selected-passage links independent from term links and permits shared children', () => {
    const arrows = {
      term: arrow('term'),
      passage: arrow('passage', { label: undefined, sourceSelection }),
      otherParent: arrow('otherParent', { label: undefined, fromNodeId: 'other', sourceSelection }),
    };
    const own = nodeRelations(arrows, 'parent');
    expect(own.sourceSelectionById.get('passage')).toBe(arrows.passage);
    expect(own.sourceSelections).toEqual([arrows.passage]);
    expect(relatedSelectedNodeId(['child'], own.termChildIds)).toBe('child');
    expect(relatedSelectedNodeId(['child'], own.sourceSelectionChildIds)).toBe('child');
    expect(relatedSelectedNodeId(['child'], nodeRelations(arrows, 'other').sourceSelectionChildIds)).toBe('child');
    for (const selection of [undefined, [], ['unrelated'], ['child', 'unrelated']]) {
      expect(relatedSelectedNodeId(selection, own.termChildIds)).toBeNull();
    }
  });
});
