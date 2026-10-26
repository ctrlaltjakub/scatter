/**
 * Clickable navigation arrows.
 *
 * Each arrow renders a transparent hit-path (`.sc-arrow-hit`). Clicking it
 * navigates to the end whose name the ASCII label would show: normally the
 * child, or the parent when the child is fully visible and the parent is
 * completely off-screen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { ArrowLayer } from './ArrowLayer';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';

function makeNode(id: string, x: number, y: number): ScatterNode {
  return {
    id,
    type: id === 'parent' ? 'root' : 'term-click',
    position: { x, y },
    frozen: false,
    versions: [{ header: id, body: 'Body.', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function seed(selection: string[], parentX = 0) {
  // Child at (300,300): with the default 1024×768 jsdom window and a 624×120
  // node, this sits fully inside the margined viewport → "fully visible".
  const parent = makeNode('parent', parentX, 0);
  const child = makeNode('child', 300, 300);
  const base = createBlankProject('t', 'parent');
  useGraphStore.getState().setProject({
    ...base,
    nodes: { parent, child },
    arrows: { a1: { id: 'a1', kind: 'auto', fromNodeId: 'parent', toNodeId: 'child', label: 'child' } },
    selection,
  });
  useGraphStore.temporal.getState().pause();
  useGraphStore.getState().requestPanTo(null);
}

describe('ArrowLayer — clickable navigation arrows', () => {
  beforeEach(() => {
    seed([]);
    useLiveViewportStore.getState().clear();
    useImageGeometryStore.setState({ byNode: {} });
    useLivePositionsStore.getState().clear();
  });

  function clickArrow() {
    const { container } = render(<ArrowLayer project={useGraphStore.getState().project!} />);
    const hit = container.querySelector('.sc-arrow-hit')!;
    expect(hit).toBeTruthy();
    fireEvent.click(hit);
  }

  it('spaces reference dots farther apart and removes every arrow hit target when hidden', () => {
    const project = useGraphStore.getState().project!;
    project.arrows.a1 = { ...project.arrows.a1!, kind: 'dotted' };
    const view = render(<ArrowLayer project={{ ...project, selection: ['parent'] }} />);
    expect(view.container.querySelector('path[marker-end]')).toHaveAttribute('stroke-dasharray', '4 12');
    expect(view.container.querySelector('.sc-arrow-hit')).not.toBeNull();
    view.rerender(<ArrowLayer project={{ ...project, selection: [] }} />);
    expect(view.container.querySelector('path[marker-end], .sc-arrow-hit')).toBeNull();
    view.rerender(<ArrowLayer project={{ ...project, selection: ['child'] }} />);
    expect(view.container.querySelector('.sc-arrow-hit')).not.toBeNull();
  });

  it('focuses the child when the child is not selected', () => {
    seed([]);
    clickArrow();
    expect(useGraphStore.getState().project!.selection).toEqual(['child']);
    expect(useGraphStore.getState().panTo?.id).toBe('child');
  });
  it('routes from the region edge and dots only the interior, keeping ordinary paths and hit targets unchanged', () => {
    const project = useGraphStore.getState().project!;
    const parent = project.nodes.parent!;
    parent.versions[0]!.media = { source: 'asset', kind: 'image', assetId: 'photo' };
    parent.versions[0]!.contentType = 'media';
    project.arrows.atlas = { ...project.arrows.a1!, id: 'atlas', label: undefined, sourceImage: {
      sourceMedia: parent.versions[0]!.media, regions: [{ x: .1, y: .2, width: .4, height: .2 }],
    } };
    const view = render(<ArrowLayer project={project} />);
    const ordinary = view.container.querySelector('[data-arrow-id="a1"]')!;
    const originalPath = ordinary.getAttribute('d');
    act(() => useImageGeometryStore.getState().set('parent', { projectId: project.id, mediaKey: 'asset:photo', owner: Symbol(),
      rect: { x: 40, y: 80, width: 600, height: 300 } }));
    const atlas = view.container.querySelector('[data-arrow-id="atlas"]')!;
    expect(atlas).toHaveAttribute('data-image-origin');
    expect(Number(atlas.getAttribute('d')!.split(' ')[2])).toBeCloseTo(200);
    expect(atlas).toHaveAttribute('clip-path');
    const interior = view.container.querySelector('[data-image-arrow-interior="atlas"]')!;
    expect(interior.getAttribute('d')).toBe(atlas.getAttribute('d'));
    expect(interior).toHaveAttribute('stroke-dasharray', '4 12');
    expect(atlas).not.toHaveAttribute('stroke-dasharray');
    expect(ordinary.getAttribute('d')).toBe(originalPath);
    expect(ordinary).not.toHaveAttribute('data-image-origin');
    expect(view.container.querySelectorAll('.sc-arrow-hit')).toHaveLength(2);
    act(() => useLivePositionsStore.getState().setPosition('parent', 100, 200));
    expect(Number(atlas.getAttribute('d')!.split(' ')[1])).toBeCloseTo(440);
    expect(interior.getAttribute('d')).toBe(atlas.getAttribute('d'));
    expect(ordinary.getAttribute('d')).toBe(originalPath);
  });

  it('keeps navigating to the child when its label would still name the child', () => {
    seed(['child']);
    clickArrow();
    expect(useGraphStore.getState().project!.selection).toEqual(['child']);
    expect(useGraphStore.getState().panTo?.id).toBe('child');
  });

  it('focuses the parent when the child is fully visible and the parent is off-screen', () => {
    seed(['child'], -1000);
    clickArrow();
    expect(useGraphStore.getState().project!.selection).toEqual(['parent']);
    expect(useGraphStore.getState().panTo?.id).toBe('parent');
  });

  it.each([0.5, 1, 2])('lets shafts, arrowheads, and the hit target scale with %sx zoom', (zoom) => {
    act(() => { useLiveViewportStore.getState().setZoom(zoom); });
    const { container } = render(<ArrowLayer project={useGraphStore.getState().project!} />);
    const visible = container.querySelector('path[marker-end]')!;
    const hit = container.querySelector('.sc-arrow-hit')!;
    const marker = container.querySelector('#sc-arrowhead-auto')!;
    const highlightedMarker = container.querySelector('#sc-arrowhead-highlight')!;

    expect(visible).not.toHaveAttribute('vector-effect');
    expect(hit).not.toHaveAttribute('vector-effect');
    expect(hit).toHaveAttribute('stroke-width', '32');
    expect(marker).toHaveAttribute('markerWidth', '6');
    expect(marker).toHaveAttribute('markerHeight', '6');
    expect(highlightedMarker).toHaveAttribute('markerWidth', '7.8');
    expect(highlightedMarker).toHaveAttribute('markerHeight', '7.8');
  });
});
