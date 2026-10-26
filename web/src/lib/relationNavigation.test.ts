import { beforeEach, describe, expect, it } from 'vitest';
import { navigateExistingRelation } from './relationNavigation';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import type { Arrow, ScatterNode } from '@/store/types';

describe('navigateExistingRelation', () => {
  beforeEach(() => useGraphStore.setState({
    project: null,
    panTo: null,
    panRequestNonce: 0,
    highlight: null,
    highlightNonce: 0,
  }));

  it('pans and emits a repeatable chip-origin flash for a selected-text arrow', () => {
    const arrow = {
      id: 'a',
      kind: 'auto',
      fromNodeId: 'parent',
      toNodeId: 'child',
      sourceSelection: {
        sourceVersionCreatedAt: 1,
        createdAt: 2,
        text: 'chosen',
        parts: [],
      },
    } satisfies Arrow;

    navigateExistingRelation(arrow);
    const first = useGraphStore.getState().highlight!;
    expect(useGraphStore.getState().panTo?.id).toBe('child');
    expect(first.arrowId).toBe('a');
    expect(first.source).toBe('chip');
    expect(first.term).toBeUndefined();

    navigateExistingRelation(arrow);
    expect(useGraphStore.getState().highlight!.nonce).toBeGreaterThan(first.nonce);
  });

  it('retains a labelled chip term while using the same route', () => {
    const arrow = {
      id: 'labelled',
      kind: 'auto',
      fromNodeId: 'parent',
      toNodeId: 'child',
      label: 'ordinary chip',
    } satisfies Arrow;

    navigateExistingRelation(arrow);

    expect(useGraphStore.getState().highlight).toMatchObject({
      arrowId: 'labelled',
      term: 'ordinary chip',
      source: 'chip',
    });
  });

  it('reveals the parent bullet containing a selected-text relation', () => {
    const body = 'Opening paragraph.\n- Topic\n  - Chosen: Some selected detail here.';
    const selected = 'Some selected detail';
    const start = body.indexOf(selected);
    const parent: ScatterNode = {
      id: 'parent',
      type: 'root',
      position: { x: 0, y: 0 },
      frozen: false,
      bulletsCollapsed: true,
      versions: [{ header: 'Parent', body, createdAt: 1, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('Test', parent.id);
    useGraphStore.setState({
      project: { ...project, nodes: { parent }, rootNodeId: parent.id },
    });
    useActiveIdxStore.getState().set(parent.id, null);
    const arrow = {
      id: 'selected',
      kind: 'auto',
      fromNodeId: parent.id,
      toNodeId: 'child',
      sourceSelection: {
        sourceVersionCreatedAt: 1,
        createdAt: 2,
        text: selected,
        parts: [{
          sourceField: 'b:0:c:0:desc',
          start,
          end: start + selected.length,
          text: selected,
        }],
      },
    } satisfies Arrow;

    navigateExistingRelation(arrow);

    expect(useGraphStore.getState().project?.nodes[parent.id]?.bulletsCollapsed).toBe(false);
    expect(useActiveIdxStore.getState().byNodeId[parent.id]).toBe(0);
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'node', id: 'child' });
  });

  it('does not reveal an unrelated bullet when a later version makes the source ambiguous', () => {
    const parent: ScatterNode = {
      id: 'parent',
      type: 'root',
      position: { x: 0, y: 0 },
      frozen: false,
      bulletsCollapsed: true,
      versions: [{
        header: 'Parent',
        body: '- One\n  - A: repeated text and repeated text\n- Two\n  - B: other text',
        createdAt: 3,
        generatedBy: 'root',
      }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('Test', parent.id);
    useGraphStore.setState({
      project: { ...project, nodes: { parent }, rootNodeId: parent.id },
    });
    useActiveIdxStore.getState().set(parent.id, 1);
    const arrow = {
      id: 'stale',
      kind: 'auto',
      fromNodeId: parent.id,
      toNodeId: 'child',
      sourceSelection: {
        sourceVersionCreatedAt: 1,
        createdAt: 2,
        text: 'repeated text',
        parts: [{
          sourceField: 'b:0:c:0:desc',
          start: 0,
          end: 13,
          text: 'repeated text',
        }],
      },
    } satisfies Arrow;

    navigateExistingRelation(arrow);

    expect(useGraphStore.getState().project?.nodes[parent.id]?.bulletsCollapsed).toBe(true);
    expect(useActiveIdxStore.getState().byNodeId[parent.id]).toBe(1);
  });
});
