// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadingStore } from '@/store/useReadingStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { Arrow } from '@/store/types';

const activateReference = vi.hoisted(() => vi.fn());
const navigateExistingRelation = vi.hoisted(() => vi.fn());
vi.mock('@/lib/referenceAction', () => ({ activateReference }));
vi.mock('@/lib/relationNavigation', () => ({ navigateExistingRelation }));

import { activateReadingReference } from './readingController';

describe('activateReadingReference', () => {
  beforeEach(() => {
    activateReference.mockReset();
    navigateExistingRelation.mockReset();
    useReadingStore.getState().reset();
    useGraphStore.setState({ project: null });
  });

  it('leaves Enter untouched outside a reference cluster', () => {
    useReadingStore.getState().begin('parent', 0, 0, null);
    expect(activateReadingReference(false)).toBe(false);
    expect(activateReference).not.toHaveBeenCalled();
  });

  it('reuses normal reference activation and forwards the collapse modifier', () => {
    const element = document.createElement('span');
    useReadingStore.getState().begin('parent', 0, 0, 2);
    useReadingStore.getState().setPos(0, 0, 2, {
      kind: 'term',
      parentNodeId: 'parent',
      term: 'wave equation',
      childId: null,
      element,
    });

    expect(activateReadingReference(true)).toBe(true);
    expect(activateReference).toHaveBeenCalledWith(
      'parent',
      'wave equation',
      { withModifier: true },
    );
  });

  it('reuses the selected-text relation navigation for every marked word', () => {
    const project = createBlankProject('reading selection', 'parent');
    const arrow: Arrow = {
      id: 'selection-arrow',
      kind: 'auto',
      fromNodeId: 'parent',
      toNodeId: 'child',
      sourceSelection: {
        sourceVersionCreatedAt: 1,
        createdAt: 2,
        text: 'selected passage',
        parts: [],
      },
    };
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        ...project.nodes,
        child: {
          id: 'child',
          type: 'term-click',
          position: { x: 10, y: 10 },
          frozen: false,
          versions: [{ header: 'Child', body: 'Body', createdAt: 2, generatedBy: 'term-click' }],
          currentVersionIndex: 0,
        },
      },
      arrows: { [arrow.id]: arrow },
    });
    const element = document.createElement('span');
    useReadingStore.getState().begin('parent', 0, 0, 1);
    useReadingStore.getState().setPos(0, 0, 1, {
      kind: 'selection',
      parentNodeId: 'parent',
      childId: 'child',
      arrowId: arrow.id,
      element,
    });

    expect(activateReadingReference(false)).toBe(true);
    expect(navigateExistingRelation).toHaveBeenCalledWith(arrow);
    expect(activateReference).not.toHaveBeenCalled();
  });
});
