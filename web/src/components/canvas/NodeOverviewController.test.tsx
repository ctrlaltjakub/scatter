import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import {
  applyNodeOverviewMode,
  applyNodeOverviewFontSize,
  NodeOverviewController,
  overviewFontSizeForZoom,
  overviewSkeletonMetricsForZoom,
  overviewTitleLayoutForZoom,
} from './NodeOverviewController';
import { OVERVIEW_SCREEN_FONT_PX } from '@/lib/overviewHeader';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';

function Harness({ focused = true, hostClass = 'canvas-host', nodeId }: { focused?: boolean; hostClass?: string; nodeId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} data-testid="canvas-host" className={hostClass}>
      <NodeOverviewController containerRef={containerRef} />
      <article data-node-id={nodeId} className={`node node-overview-eligible${focused ? ' selected' : ''}`}>
        <div className="node-detail-surface" data-testid="detail">Detail</div>
        <div className="node-overview-surface" data-testid="overview">
          <h3 className="node-overview-title">Overview</h3><div className="node-overview-skeleton" />
        </div>
        <button className="node-fit-btn">Fit</button>
        {focused && <div className="node-followup-bar"><input aria-label="Follow-up draft" defaultValue="Keep my draft" /></div>}
      </article>
      {focused && <aside className="side-panel">Actions</aside>}
      {focused && <aside className="citations-panel">Sources</aside>}
    </div>
  );
}

describe('NodeOverviewController', () => {
  beforeEach(() => {
    useLiveViewportStore.getState().clear();
    useGraphStore.setState({ project: null });
    useLivePositionsStore.setState({ positions: {} });
  });

  afterEach(() => {
    cleanup();
    useLiveViewportStore.getState().clear();
    useNodeTextSelectionStore.getState().clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the overview title at a constant screen-space size', () => {
    expect(overviewFontSizeForZoom(0.35) * 0.35).toBeCloseTo(OVERVIEW_SCREEN_FONT_PX);
    expect(overviewFontSizeForZoom(0.1) * 0.1).toBeCloseTo(OVERVIEW_SCREEN_FONT_PX);
  });

  it('keeps every overview header at exactly 12 screen pixels', () => {
    expect(overviewFontSizeForZoom(0.34) * 0.34).toBeCloseTo(12);
    expect(overviewFontSizeForZoom(0.1) * 0.1).toBeCloseTo(12);
  });

  it.each([0.1, 0.15, 0.25, 0.34])('keeps skeleton strokes and fit-button clearance stable at zoom %s', (zoom) => {
    const metrics = overviewSkeletonMetricsForZoom(zoom);
    expect(metrics.gap * zoom).toBeCloseTo(7);
    expect(metrics.unit * zoom).toBeCloseTo(1);
    // Restore the 6px difference between surface padding and button inset.
    expect((metrics.controlClearance + 6) * zoom).toBeCloseTo(38);
  });

  it('makes room above the fit button, using a side column only on very short cards', () => {
    expect(overviewTitleLayoutForZoom(0.1, 504)).toEqual({ lines: 1, reserve: 0 });
    expect(overviewTitleLayoutForZoom(0.25, 284)).toEqual({ lines: 2, reserve: 0 });
    expect(overviewTitleLayoutForZoom(0.1, 321)).toEqual({ lines: 2, reserve: 374 });
    expect(overviewTitleLayoutForZoom(0.1, 80)).toEqual({ lines: 1, reserve: 374 });
  });

  it('updates only the overview layout when the same-zoom card height changes', () => {
    const project = createBlankProject('resizing overview', 'n');
    const node = { id: 'n', type: 'root' as const, frozen: false, renderedHeight: 321,
      position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Title', body: 'Text', createdAt: 1, generatedBy: 'root' as const }] };
    useGraphStore.setState({ project: { ...project, nodes: { n: node } } });
    useLiveViewportStore.getState().setZoom(0.1);
    const { getByTestId } = render(<Harness nodeId="n" />);
    const host = getByTestId('canvas-host');
    const title = host.querySelector<HTMLElement>('.node-overview-title')!;
    const skeleton = host.querySelector<HTMLElement>('.node-overview-skeleton')!;
    expect(title).toHaveAttribute('data-overview-title-compact');
    expect(skeleton.style.getPropertyValue('--overview-skeleton-unit')).toBe('10px');
    useGraphStore.setState({ project: { ...project, nodes: { n: { ...node, renderedHeight: 1000 } } } });
    applyNodeOverviewFontSize(host, 0.1);
    expect(title).not.toHaveAttribute('data-overview-title-compact');
    expect(title.style.getPropertyValue('--overview-title-lines')).toBe('4');
    expect(title.style.getPropertyValue('--overview-title-reserve')).toBe('0px');
    expect(getByTestId('detail')).toHaveTextContent('Detail');
    expect(host.querySelector('.node-overview-skeleton')).toBe(skeleton);
  });

  it('counter-scales only fit controls, without invalidating the whole canvas through an inherited variable', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const { getByTestId } = render(<Harness />);
    const host = getByTestId('canvas-host');
    const button = host.querySelector<HTMLElement>('.node-fit-btn')!;
    expect(host.style.getPropertyValue('--node-overview-control-scale')).toBe('');
    expect(Number(button.style.getPropertyValue('--node-overview-control-scale')) * 0.1).toBeCloseTo(1);
    applyNodeOverviewFontSize(host, 0.25);
    expect(Number(button.style.getPropertyValue('--node-overview-control-scale')) * 0.25).toBeCloseTo(1);
    applyNodeOverviewFontSize(host, 1);
    expect(button.style.getPropertyValue('--node-overview-control-scale')).toBe('1');
  });

  it('does no overview DOM sweep during ordinary detail zoom', () => {
    const { getByTestId } = render(<Harness />);
    const host = getByTestId('canvas-host');
    const query = vi.spyOn(host, 'querySelectorAll');
    for (const zoom of [0.4, 0.7, 1, 1.5]) applyNodeOverviewFontSize(host, zoom);
    expect(query).not.toHaveBeenCalled();
  });

  it('does not force container layout on each camera frame', () => {
    const host = document.createElement('div');
    const width = vi.fn(() => 800);
    const height = vi.fn(() => 600);
    Object.defineProperties(host, { clientWidth: { get: width }, clientHeight: { get: height } });
    for (const zoom of [0.34, 0.3, 0.25, 0.1, 0.5, 1.5]) applyNodeOverviewFontSize(host, zoom);
    expect(width).toHaveBeenCalledTimes(1);
    expect(height).toHaveBeenCalledTimes(1);
  });

  it('sizes newly visible cards when the window expands without a camera change', () => {
    let resized: ResizeObserverCallback | undefined;
    let scheduled: FrameRequestCallback | undefined;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { scheduled = callback; return 1; });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    const project = createBlankProject('resized overview', 'far');
    useGraphStore.setState({ project: { ...project, nodes: { far: {
      id: 'far', type: 'root', frozen: true, position: { x: 10000, y: 0 }, renderedHeight: 300,
      currentVersionIndex: 0, versions: [{ header: 'Far', body: '', createdAt: 1, generatedBy: 'root' }],
    } } } });
    useLiveViewportStore.getState().setZoom(0.1);
    const { getByTestId } = render(<Harness nodeId="far" />);
    const host = getByTestId('canvas-host');
    const title = host.querySelector<HTMLElement>('.node-overview-title')!;
    expect(title.style.fontSize).toBe('');
    act(() => {
      resized!([{ target: host, contentRect: new DOMRect(0, 0, 1200, 600),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver);
      scheduled!(0);
    });
    expect(title.style.fontSize).toBe('120px');
  });

  it('sizes off-screen cards only when they approach the viewport, including a pan at unchanged zoom', () => {
    const project = createBlankProject('overview culling', 'near');
    const near = { id: 'near', type: 'root' as const, frozen: false, renderedHeight: 300,
      position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Near', body: 'Text', createdAt: 1, generatedBy: 'root' as const }] };
    const far = { ...near, id: 'far', position: { x: 10000, y: 0 } };
    useGraphStore.setState({ project: { ...project, nodes: { near, far } } });
    useLiveViewportStore.getState().setViewport({ x: 0, y: 0, zoom: 0.1 });
    const host = document.createElement('div');
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    host.innerHTML = ['near', 'far'].map((id) => `<article data-node-id="${id}" class="node-overview-eligible">
      <div class="node-detail-surface">Unchanged text</div><div class="node-overview-surface">
      <h3 class="node-overview-title">Title</h3><div class="node-overview-skeleton"></div></div>
      <button class="node-fit-btn">Fit</button></article>`).join('');
    const titles = host.querySelectorAll<HTMLElement>('.node-overview-title');
    const farButton = host.querySelector<HTMLElement>('[data-node-id="far"] .node-fit-btn')!;
    applyNodeOverviewFontSize(host, 0.1);
    expect(titles[0]!.style.fontSize).toBe('120px');
    expect(titles[1]!.style.fontSize).toBe('');
    useLiveViewportStore.getState().setPan(-300, 0);
    applyNodeOverviewFontSize(host, 0.1);
    expect(titles[1]!.style.fontSize).toBe('120px');
    expect(farButton.style.getPropertyValue('--node-overview-control-scale')).toBe('10');
    const writes = vi.spyOn(farButton.style, 'setProperty');
    applyNodeOverviewFontSize(host, 0.1);
    expect(writes).not.toHaveBeenCalled();
    // Even off-screen cards are reset when leaving overview.
    applyNodeOverviewFontSize(host, 0.5);
    expect(titles[0]!.style.fontSize).toBe('');
    expect(titles[1]!.style.fontSize).toBe('');
    expect(host.querySelector('.node-detail-surface')?.getAttribute('style')).toBeNull();
  });

  it('uses the strict 35% boundary and changes only the card surfaces', () => {
    const { getByTestId } = render(<Harness />);
    const card = getByTestId('canvas-host').querySelector('.node')!;
    const detail = getByTestId('detail');
    const overview = getByTestId('overview');
    expect(detail).not.toHaveAttribute('aria-hidden');
    expect(overview.style.opacity).toBe('0');

    act(() => useLiveViewportStore.getState().setZoom(0.35));
    expect(detail).not.toHaveAttribute('aria-hidden');
    expect(overview.style.opacity).toBe('0');

    act(() => useLiveViewportStore.getState().setZoom(0.34));
    expect(card).toHaveAttribute('data-node-overview-active');
    expect(detail).toHaveStyle({ opacity: '0' });
    expect(detail).toHaveAttribute('aria-hidden', 'true');
    expect(detail.style.contentVisibility).toBe('hidden');
    expect(detail.style.pointerEvents).toBe('');
    expect(overview.style.opacity).toBe('1');
    expect(overview.style.pointerEvents).toBe('auto');
    expect(overview).not.toHaveAttribute('aria-hidden');

    act(() => useLiveViewportStore.getState().setZoom(0.36));
    expect(card).not.toHaveAttribute('data-node-overview-active');
    expect(detail).toHaveStyle({ opacity: '1' });
    expect(detail).not.toHaveAttribute('aria-hidden');
    expect(overview.style.opacity).toBe('0');
    expect(overview.style.pointerEvents).toBe('none');
    expect(overview).toHaveAttribute('aria-hidden', 'true');
  });

  it('uses opposite lightweight animation phases for entering and leaving', () => {
    const { getByTestId } = render(<Harness />);
    const host = getByTestId('canvas-host');
    const overview = getByTestId('overview');

    applyNodeOverviewMode(host, true, true);
    expect(overview).toHaveClass('node-overview-surface--entering');
    expect(overview).not.toHaveClass('node-overview-surface--exiting');

    applyNodeOverviewMode(host, false, true);
    expect(overview).toHaveClass('node-overview-surface--exiting');
    expect(overview).not.toHaveClass('node-overview-surface--entering');
  });

  it('hides panels at the skeleton threshold without unmounting or losing drafts', () => {
    const { getByTestId, getByRole } = render(<Harness />);
    const host = getByTestId('canvas-host');
    const input = getByRole('textbox');
    input.focus();
    act(() => useLiveViewportStore.getState().setZoom(0.35));
    expect(host).not.toHaveAttribute('data-node-overview');
    act(() => useLiveViewportStore.getState().setZoom(0.34));
    expect(host).toHaveAttribute('data-node-overview');
    expect(input).not.toHaveFocus();
    expect(host.querySelector('.side-panel')).not.toBeNull();
    expect(host.querySelector('.citations-panel')).not.toBeNull();
    act(() => useLiveViewportStore.getState().setZoom(0.35));
    expect(host).not.toHaveAttribute('data-node-overview');
    expect(getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('Keep my draft');
  });

  it('clears selected source text when readable content disappears', () => {
    useNodeTextSelectionStore.getState().set({
      nodeId: 'n',
      versionIndex: 0,
      sourceBody: 'body',
      start: 0,
      end: 4,
      text: 'body',
    });
    render(<Harness />);
    act(() => useLiveViewportStore.getState().setZoom(0.34));
    expect(useNodeTextSelectionStore.getState().selection).toBeNull();
  });

  it('keeps the hiding marker when focus mounts new panels and rewrites host/card classes at an unchanged low zoom', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const view = render(<Harness focused={false} />);
    const host = view.getByTestId('canvas-host');
    expect(host).toHaveAttribute('data-node-overview');
    expect(host.querySelector('.side-panel')).toBeNull();
    view.rerender(<Harness focused hostClass="canvas-host ascii-label-hover" />);
    expect(host).toHaveAttribute('data-node-overview');
    expect(host.querySelector('.node')).toHaveAttribute('data-node-overview-active');
    for (const selector of ['.side-panel', '.citations-panel', '.node-followup-bar']) {
      expect(host.querySelector(selector)?.closest('[data-node-overview]')).toBe(host);
    }
  });
});
