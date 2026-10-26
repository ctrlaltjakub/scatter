import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NodeView } from './NodeView';
import type { MediaRef, ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

const noop = () => {};
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  useLivePositionsStore.setState({ positions: {} });
  useLiveViewportStore.getState().clear();
});
afterEach(() => {
  cleanup();
  useGraphStore.temporal.getState().resume();
  useGraphStore.getState().setProject(null);
  vi.unstubAllGlobals();
});

describe('media corner resizing', () => {
  const cases: Array<[string, MediaRef, number]> = [
    ['image', { kind: 'image', source: 'link', mime: 'image/png', naturalWidth: 800, naturalHeight: 600 }, .75],
    ['GIF', { kind: 'image', source: 'link', mime: 'image/gif', naturalWidth: 600, naturalHeight: 800 }, 4 / 3],
    ['video', { kind: 'video', source: 'link', naturalWidth: 1920, naturalHeight: 1080 }, 9 / 16],
    ['embedded video', { kind: 'embed', source: 'embed', provider: 'youtube', embedId: 'fixture' }, 9 / 16],
    ['GIF without dimensions', { kind: 'image', source: 'link', mime: 'image/gif' }, 9 / 16],
    ['video without dimensions', { kind: 'video', source: 'link' }, 9 / 16],
  ];
  it.each(cases)('locks %s proportions instead of stretching the body', (_name, media, ratio) => {
    const node: ScatterNode = { id: 'media-resize', type: 'media', frozen: true,
      position: { x: 0, y: 0 }, currentVersionIndex: 0, renderedHeight: 400 * ratio + 80,
      versions: [{ header: 'Media', body: '', createdAt: 1, generatedBy: 'manual', contentType: 'media',
        width: 400, bodyMaxHeight: 400 * ratio, media }] };
    useGraphStore.getState().setProject({ ...createBlankProject('Media', node.id), nodes: { [node.id]: node } });
    const { container } = render(<NodeView node={node} selected={false} onSelect={noop}
      onReferenceClick={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} />);
    const handle = container.querySelector('.node-resize.br')!;
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 480, clientY: 500 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 480, clientY: 500 });
    const version = useGraphStore.getState().project!.nodes[node.id]!.versions[0]!;
    expect(version.width).toBe(480);
    expect(version.bodyMaxHeight).toBe(Math.round(480 * ratio));
  });
});
