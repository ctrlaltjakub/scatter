import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef, Profiler } from 'react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { NodeScrollbar } from './NodeScrollbar';

const resizeObservers: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn> }[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function frame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => callback(performance.now()));
  });
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe = vi.fn();
    constructor(callback: ResizeObserverCallback) { resizeObservers.push({ callback, observe: this.observe }); }
    disconnect() {}
  };
});

beforeEach(() => {
  cleanup();
  frames.clear();
  resizeObservers.length = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
});

describe('NodeScrollbar live zoom normalization', () => {
  it('uses live smooth-zoom rather than the persisted viewport snapshot', () => {
    const project = createBlankProject('scrollbar-zoom', 'n0');
    useGraphStore.getState().setProject({ ...project, viewport: { x: 0, y: 0, zoom: 2 } });
    useLiveViewportStore.getState().setViewport({ x: 0, y: 0, zoom: 0.5 });

    const body = document.createElement('div');
    const anchor = document.createElement('div');
    anchor.dataset.scAnchor = 'ft';
    body.appendChild(anchor);
    body.getBoundingClientRect = () => ({ top: 100, left: 0, right: 200, bottom: 300, width: 200, height: 200, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
    anchor.getBoundingClientRect = () => ({ top: 150, left: 0, right: 200, bottom: 200, width: 200, height: 50, x: 0, y: 150, toJSON: () => ({}) } as DOMRect);
    const bodyRef = createRef<HTMLDivElement>();
    (bodyRef as { current: HTMLDivElement | null }).current = body;

    const { container } = render(
      <NodeScrollbar activeStop={0} onChangeStop={() => {}} bodyRef={bodyRef} anchorSelectors={['[data-sc-anchor="ft"]']} />,
    );
    const bar = container.querySelector<HTMLElement>('.node-scrollbar-bar')!;
    expect(bar.style.top).toBe('96px');
    expect(bar.style.height).toBe('100px');
  });

  it('keeps measured local ranges across zoom, while pointer input uses the latest scale', () => {
    cleanup();
    useLiveViewportStore.getState().setZoom(1);
    const body = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.id = 'first'; second.id = 'second'; body.append(first, second);
    const rect = (top: number, height: number) => ({ top, height, left: 0, right: 100, bottom: top + height,
      width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect);
    body.getBoundingClientRect = vi.fn(() => rect(100, 200));
    first.getBoundingClientRect = vi.fn(() => rect(100, 100));
    second.getBoundingClientRect = vi.fn(() => rect(200, 100));
    const bodyRef = { current: body };
    const onChangeStop = vi.fn();
    const renders = vi.fn();
    const { container } = render(<Profiler id="scrollbar" onRender={renders}>
      <NodeScrollbar activeStop={0} onChangeStop={onChangeStop} bodyRef={bodyRef} anchorSelectors={['#first', '#second']} />
    </Profiler>);
    renders.mockClear();
    vi.mocked(first.getBoundingClientRect).mockClear();
    vi.mocked(second.getBoundingClientRect).mockClear();
    act(() => {
      for (const zoom of [0.9, 0.7, 0.3, 0.5]) useLiveViewportStore.getState().setZoom(zoom);
    });
    expect(renders).not.toHaveBeenCalled();
    expect(first.getBoundingClientRect).not.toHaveBeenCalled();
    expect(second.getBoundingClientRect).not.toHaveBeenCalled();
    // 75 screen pixels at 50% zoom is 150 local pixels: the second section.
    fireEvent.pointerDown(container.querySelector('.node-scrollbar')!, { clientY: 175, pointerId: 1 });
    expect(onChangeStop).toHaveBeenLastCalledWith(1);
    cleanup();
  });

  it('retains the current target until the expanded section has been measured', () => {
    useLiveViewportStore.getState().setZoom(1);
    const body = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.id = 'first'; second.id = 'second'; body.append(first, second);
    const rect = (top: number, height: number) => ({ top, height } as DOMRect);
    body.getBoundingClientRect = () => rect(100, 400);
    first.getBoundingClientRect = () => rect(104, 60);
    second.getBoundingClientRect = () => rect(240, 24);
    const props = { bodyRef: { current: body }, anchorSelectors: ['#first', '#second'], onChangeStop: vi.fn() };
    const { container, rerender } = render(<NodeScrollbar {...props} activeStop={0} />);
    const bar = container.querySelector<HTMLElement>('.node-scrollbar-bar')!;

    rerender(<NodeScrollbar {...props} activeStop={1} />);
    // The sibling cascade has not committed its final size yet. Never send
    // the old 24px collapsed range to the CSS transition.
    expect(bar.style.top).toBe('0px');
    expect(bar.style.height).toBe('60px');
    second.getBoundingClientRect = () => rect(200, 160);
    frame();
    expect(bar.style.top).toBe('96px');
    expect(bar.style.height).toBe('160px');
    const observer = resizeObservers.at(-1)!;
    expect(observer.observe).toHaveBeenCalledWith(first);
    expect(observer.observe).toHaveBeenCalledWith(second);
    // Also track a later anchor resize when the body's own height is fixed.
    second.getBoundingClientRect = () => rect(200, 180);
    act(() => observer.callback([], {} as ResizeObserver));
    expect(bar.style.height).toBe('180px');
  });

  it('holds the original entry geometry while focus and expansion settle', () => {
    useLiveViewportStore.getState().setZoom(1);
    const body = document.createElement('div');
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.id = 'first'; second.id = 'second'; body.append(first, second);
    const rect = (top: number, height: number) => ({ top, height } as DOMRect);
    body.getBoundingClientRect = () => rect(100, 400);
    first.getBoundingClientRect = () => rect(104, 60);
    second.getBoundingClientRect = () => rect(240, 24);
    const { container } = render(<NodeScrollbar activeStop={1} initialStop={0} bodyRef={{ current: body }}
      anchorSelectors={['#first', '#second']} onChangeStop={vi.fn()} />);
    const bar = container.querySelector<HTMLElement>('.node-scrollbar-bar')!;
    first.getBoundingClientRect = () => rect(104, 24);
    second.getBoundingClientRect = () => rect(140, 160);
    frame();
    expect(bar.style.top).toBe('0px');
    expect(bar.style.height).toBe('60px');
    frame();
    frame();
    expect(bar.style.top).toBe('36px');
    expect(bar.style.height).toBe('160px');
  });
});
