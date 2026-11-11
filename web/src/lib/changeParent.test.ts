import { afterEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { beginParentPick, cancelParentPick, chooseParent, useParentPickStore, watchParentPick } from '@/store/useParentPickStore';
import { parentChoices, parentImageForRequest, withChangedParent } from './changeParent';
import { describeHistoryChange, preserveProjectPresentation } from './historySemantics';
import type { Arrow, ScatterNode } from '@/store/types';

function fixture() {
  const p = createBlankProject('Branches', 'root');
  for (const [i, id] of ['root', 'old', 'child', 'leaf', 'new'].entries()) {
    p.nodes[id] = { id, type: id === 'root' ? 'root' : 'term-click', frozen: i % 2 === 0, position: { x: i * 200, y: i * 100 },
      groupId: 'g', currentVersionIndex: 0, versions: [{ header: id, body: id, createdAt: i, generatedBy: 'manual' }] };
  }
  const edge = (id: string, fromNodeId: string, toNodeId: string, kind: Arrow['kind'] = 'auto'): Arrow => ({ id, fromNodeId, toNodeId, kind });
  p.arrows = { ro: edge('ro', 'root', 'old'), rn: edge('rn', 'root', 'new'), cl: edge('cl', 'child', 'leaf'),
    dotted: edge('dotted', 'leaf', 'new', 'dotted'), ref: edge('ref', 'new', 'child', 'dotted'),
    oc: { ...edge('oc', 'old', 'child'), label: 'old term', sourceAnswer: { turnId: 't', versionCreatedAt: 1 }, createdAt: 42,
      sourceSelection: { sourceVersionCreatedAt: 1, createdAt: 2, text: 'old passage', parts: [] }, anchors: [{ x: 1, y: 2 }, { x: 2, y: 3 }] } };
  p.selection = ['child'];
  return p;
}
afterEach(() => { cancelParentPick(); useGraphStore.getState().setProject(null); });
describe('change parent node', () => {
  it('excludes self, descendants and current parent, but not nodes connected only by references', () => {
    const p = fixture(), old = p.arrows.oc!;
    expect([...parentChoices(p, 'child').candidates].sort()).toEqual(['new', 'root']);
    for (const target of ['old', 'child', 'leaf', 'missing'])
      expect(withChangedParent(p, 'child', target, old)).toBeNull();
    expect(withChangedParent(p, 'child', 'new', { ...old, fromNodeId: 'root' })).toBeNull();
    expect(parentChoices(p, 'root').arrow).toBeUndefined();
    delete p.nodes.new; delete p.arrows.rn;
    expect(parentChoices(p, 'old').reason).toContain('outside this branch');
    delete p.nodes.child; delete p.nodes.leaf;
    expect(parentChoices(p, 'old').reason).toContain('third node');
  });
  it('preserves branch contents, pins, groups, separate references and the original arrow identity; saves one undo step', () => {
    const p = fixture(), graph = useGraphStore.getState();
    graph.setProject(p); useGraphStore.temporal.getState().clear();
    expect(graph.changeParent(p.id, 'child', 'new', p.arrows.oc!)).toBe(true);
    const next = useGraphStore.getState().project!;
    expect(next.nodes).toBe(p.nodes);
    expect(next.arrows.oc).toEqual({ id: 'oc', kind: 'auto', fromNodeId: 'new', toNodeId: 'child', parentScope: 'node', createdAt: 42 });
    for (const id of ['ro', 'rn', 'cl', 'dotted', 'ref']) expect(next.arrows[id]).toBe(p.arrows[id]);
    expect(describeHistoryChange(p, next)).toMatchObject({ label: 'Change parent node', nodeIds: ['child'] });
    const saved = JSON.parse(JSON.stringify(next));
    saved.arrows.oc.anchors = [{ x: 200, y: 300 }, { x: 403, y: 807 }];
    expect(preserveProjectPresentation(saved, p)!.arrows.oc).toEqual(p.arrows.oc);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.arrows.oc).toEqual(p.arrows.oc);
    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project!.arrows.oc).toEqual(next.arrows.oc);
  });
  it('preview/cancellation never touch the graph; changes to the relation invalidate an open picker', () => {
    const p = fixture(); useGraphStore.getState().setProject(p); useGraphStore.temporal.getState().clear();
    const stop = watchParentPick();
    try {
      beginParentPick('child', { x: 1, y: 2 }, false);
      useParentPickStore.getState().pick!.pointer.x = 80;
      expect(chooseParent('leaf')).toBe(false);
      expect(chooseParent('child')).toBe(false);
      expect(useParentPickStore.getState().pick).toBeNull();
      expect(useGraphStore.getState().project!.arrows.oc).toBe(p.arrows.oc);
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
      beginParentPick('child', { x: 0, y: 0 }, false);
      useGraphStore.getState().changeParent(p.id, 'child', 'root', p.arrows.oc!);
      expect(useParentPickStore.getState().pick).toBeNull();
      expect(chooseParent('new')).toBe(false);
    } finally { stop(); }
  });
  it('uses the entire new image, never an archived crop; a text parent supplies no image', () => {
    const p = fixture(), image = { kind: 'image', source: 'asset', assetId: 'new-image' } as const;
    const old = { ...p.nodes.child!.versions[0]!, imageContext: { sourceMedia: { ...image, assetId: 'old-image' }, regions: [{ x: 0, y: 0, width: .5, height: .5 }] } };
    expect(parentImageForRequest(p, 'child', old)).toEqual(old.imageContext);
    const next = withChangedParent(p, 'child', 'new', p.arrows.oc!)!;
    expect(parentImageForRequest(next, 'child', old)).toBeUndefined();
    const parent: ScatterNode = next.nodes.new!;
    parent.versions = [{ ...parent.versions[0]!, contentType: 'media', media: image }];
    expect(parentImageForRequest(next, 'child', old)).toEqual({ sourceMedia: image, regions: [], sourceVersionCreatedAt: parent.versions[0]!.createdAt });
  });
});
