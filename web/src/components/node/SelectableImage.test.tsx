import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectableImage } from './SelectableImage';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useNodeMultiSelection } from '@/components/canvas/useNodeMultiSelection';
import { ArrowLayer } from '@/components/canvas/ArrowLayer';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';

let originalTheme: string | undefined;
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  const { handlers } = useNodeMultiSelection(ref);
  return <div ref={ref} {...handlers}><div className="node" data-node-id="image"
    onClick={() => useGraphStore.getState().setSelection(['image'])}>
    <SelectableImage nodeId="image" src="/fixture.png" onLoad={() => {}} onError={() => {}} />
  </div></div>;
}
beforeEach(() => {
  originalTheme = document.documentElement.dataset.theme;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  useImageEditorStore.getState().close();
  useLiveViewportStore.getState().clear();
  useLivePositionsStore.getState().clear();
  const p = createBlankProject('Selection test', 'image');
  p.nodes.image = { id: 'image', type: 'media', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0,
    versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', media: { kind: 'image', source: 'link', url: '/fixture.png' } }] };
  p.nodes.other = { ...p.nodes.image, id: 'other' };
  p.selection = [];
  useGraphStore.getState().setProject(p);
});
afterEach(() => {
  cleanup();
  useImageEditorStore.getState().close();
  useGraphStore.getState().setProject(null);
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  vi.unstubAllGlobals();
});
function mount() {
  render(<Harness />);
  const surface = screen.getByRole('group', { name: 'Image selection' });
  const image = surface.querySelector('img')!;
  Object.defineProperties(surface, { clientWidth: { value: 600 }, clientHeight: { value: 400 },
    getBoundingClientRect: { value: () => ({ left: 100, top: 100, width: 600, height: 400 }) } });
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 400 } });
  fireEvent.load(image);
  return surface;
}
function drag(surface: HTMLElement) {
  fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 160, clientY: 140 });
  fireEvent.pointerMove(surface, { pointerId: 1, clientX: 400, clientY: 300 });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: 400, clientY: 300 });
}
describe('canvas image selection eligibility', () => {
  it('requires focus before the gesture, and restores normal click and Ctrl-click node selection', () => {
    const surface = mount();
    expect(surface).not.toHaveAttribute('data-image-selection-surface');
    drag(surface);
    expect(useImageSelectionStore.getState().selection).toBeNull();
    fireEvent.click(surface);
    expect(surface).toHaveAttribute('data-image-selection-surface');
    drag(surface);
    expect(useImageSelectionStore.getState().selection?.regions).toHaveLength(1);
    fireEvent.click(surface, { ctrlKey: true }); // consumes the drag's synthetic click
    fireEvent.click(surface, { ctrlKey: true });
    expect(useGraphStore.getState().project!.selection).toEqual([]);
    act(() => useGraphStore.getState().setSelection(['other']));
    fireEvent.click(surface, { ctrlKey: true });
    expect(useGraphStore.getState().project!.selection).toEqual(['other', 'image']);
    expect(surface).not.toHaveAttribute('data-image-selection-surface');
  });
  it('blocks overview gestures and cancels an in-progress selection when focus disappears', () => {
    const surface = mount();
    act(() => useGraphStore.getState().setSelection(['image']));
    drag(surface);
    act(() => useLiveViewportStore.getState().setZoom(.3));
    expect(surface).not.toHaveAttribute('data-image-selection-surface');
    expect(useImageSelectionStore.getState().selection).toBeNull();
    drag(surface);
    expect(useImageSelectionStore.getState().selection).toBeNull();
    act(() => useLiveViewportStore.getState().setZoom(1));
    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 160, clientY: 140 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 400, clientY: 300 });
    act(() => useGraphStore.getState().setSelection([]));
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 400, clientY: 300 });
    expect(useImageSelectionStore.getState().selection).toBeNull();
    expect(surface.querySelector('.image-region-overlay')).toBeNull();
  });
  it('shows atlas ink without stealing image input and never inside the image editor', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.getState().setProject({ ...project, arrows: { atlas: {
      id: 'atlas', kind: 'auto', fromNodeId: 'image', toNodeId: 'other', sourceImage: {
        sourceMedia: project.nodes.image!.versions[0]!.media!, regions: [{ x: .1, y: .2, width: .3, height: .4 }, { x: .7, y: .2, width: .2, height: .4 }],
      },
    } } });
    const surface = mount();
    expect(surface.querySelector('[data-image-atlas]')).not.toBeNull();
    expect(surface.querySelector('.image-atlas-ink [data-image-origin]')).not.toBeNull();
    expect(surface.querySelector('.sc-arrow-hit')).toBeNull();
    act(() => useImageEditorStore.getState().openImageEditor('image'));
    expect(surface.querySelector('[data-image-atlas]')).toBeNull();
    act(() => useImageEditorStore.getState().close());
    expect(surface.querySelector('[data-image-atlas]')).not.toBeNull();
  });
  it.each(['latte', 'mocha'])('matches atlas frames and interior arrows to reference-arrow ink in %s', (theme) => {
    document.documentElement.dataset.theme = theme;
    const project = useGraphStore.getState().project!;
    useGraphStore.getState().setProject({ ...project, color: '#1b9e77', selection: ['image'], arrows: {
      atlas: { id: 'atlas', kind: 'auto', fromNodeId: 'image', toNodeId: 'other', sourceImage: {
        sourceMedia: project.nodes.image!.versions[0]!.media!, regions: [{ x: .1, y: .2, width: .3, height: .4 }, { x: .7, y: .2, width: .2, height: .4 }],
      } },
      reference: { id: 'reference', kind: 'dotted', fromNodeId: 'image', toNodeId: 'other' },
    } });
    const surface = mount();
    const main = render(<ArrowLayer project={useGraphStore.getState().project!} />);
    const frame = surface.querySelector('[data-image-atlas-frame="atlas"]')!;
    const connectors = surface.querySelector('[data-image-region-connectors="atlas"]')!;
    const overlayArrow = surface.querySelector('[data-arrow-id="atlas"]')!;
    const interior = main.container.querySelector('[data-image-arrow-interior="atlas"]')!;
    const reference = main.container.querySelector('[data-arrow-id="reference"]')!;
    const strokeAttributes = ['stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'];
    const expectSameInk = (actual: Element, expected: Element) => {
      for (const attr of strokeAttributes) expect(actual.getAttribute(attr)).toBe(expected.getAttribute(attr));
    };
    expect(frame).toBeTruthy();
    expectSameInk(frame, reference);
    expect(connectors).toBeTruthy();
    expectSameInk(connectors, reference);
    expectSameInk(overlayArrow, reference);
    expectSameInk(interior, reference);
    expect(frame).toHaveAttribute('stroke-width', '3');
    expect(frame).toHaveAttribute('stroke-opacity', theme === 'mocha' ? '1' : '0.9');
    expect(frame).toHaveAttribute('stroke-dasharray', '4 12');
    expect(frame).toHaveAttribute('pointer-events', 'none');

    const projectStroke = frame.getAttribute('stroke');
    act(() => useGraphStore.setState((s) => ({ project: { ...s.project!,
      groups: { group: { id: 'group', name: 'Image group', color: '#e7298a', gravitate: true } },
      nodes: { ...s.project!.nodes, image: { ...s.project!.nodes.image!, groupId: 'group' } },
    } })));
    expect(frame.getAttribute('stroke')).not.toBe(projectStroke);
    expectSameInk(frame, reference);
    expectSameInk(overlayArrow, reference);
    expectSameInk(interior, reference);

    act(() => useGraphStore.setState({ highlight: {
      parentNodeId: 'image', childNodeId: 'other', arrowId: 'atlas', nonce: 1, source: 'chip',
    } }));
    expectSameInk(frame, overlayArrow);
    expectSameInk(frame, interior);
    expect(frame).toHaveAttribute('stroke-width', '3.9');
    expect(frame).toHaveAttribute('stroke', 'rgb(var(--ctp-text))');
    expect(frame).toHaveClass('sc-arrow-shaft-pulse');

    const path = frame.getAttribute('d');
    act(() => useLivePositionsStore.getState().setPosition('image', 150, 250));
    expect(frame).toHaveAttribute('transform', 'translate(150 250)');
    expect(frame.getAttribute('d')).toBe(path);
    expect(surface.querySelector('.image-atlas-ink')).toHaveAttribute('viewBox', '250 350 600 400');
    act(() => useGraphStore.setState({ highlight: null }));
    expectSameInk(frame, reference);
    expectSameInk(overlayArrow, reference);
    expectSameInk(interior, reference);
    expect(frame).not.toHaveClass('sc-arrow-shaft-pulse');
  });
});
