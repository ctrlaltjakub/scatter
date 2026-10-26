import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { NodeView } from './NodeView';
import { createChatNode } from '@/lib/chat/model';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const noop = () => {};

function node(overrides: Partial<ScatterNode> = {}): ScatterNode {
  return {
    id: 'n',
    type: 'term-click',
    position: { x: 10, y: 20 },
    frozen: false,
    renderedHeight: 321,
    versions: [{
      header: 'A detailed header that can use the available overview height',
      body: 'Opening paragraph.\n\n- Topic\n  - Point: Detail',
      createdAt: 1,
      generatedBy: 'term-click',
      contentType: 'encyclopedic',
    }],
    currentVersionIndex: 0,
    ...overrides,
  };
}

function renderNode(value: ScatterNode, selected = false) {
  const project = createBlankProject('overview', value.id);
  useGraphStore.getState().setProject({
    ...project,
    rootNodeId: value.id,
    nodes: { [value.id]: value },
  });
  return render(
    <NodeView
      node={value}
      selected={selected}
      onSelect={noop}
      onReferenceClick={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
    />,
  );
}

afterEach(() => {
  cleanup();
  useGraphStore.setState({ project: null });
  useLiveViewportStore.getState().clear();
  useInteractiveViewerStore.getState().close();
});

describe('NodeView low-zoom overview', () => {
  it('uses the saved footprint immediately even when mounted after the overview controller', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const value = node({ renderedHeight: 900 });
    value.versions[0]!.bodyMaxHeight = 810;
    const { container } = renderNode(value);
    const detail = container.querySelector<HTMLElement>('.node-detail-surface')!;
    expect(detail.style.containIntrinsicSize).toBe('624px 900px');
    expect(detail.style.contentVisibility).toBe('hidden');
    expect(container.querySelector('.node')).not.toHaveAttribute('data-node-needs-measurement');
  });

  it('remeasures legacy 300px placeholders that cannot contain the saved body', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const value = node({ renderedHeight: 300 });
    value.versions[0]!.bodyMaxHeight = 810;
    const { container } = renderNode(value);
    expect(container.querySelector('.node')).toHaveAttribute('data-node-needs-measurement');
    expect(container.querySelector<HTMLElement>('.node-detail-surface')!.style.contentVisibility).toBe('visible');
  });

  it.each(['encyclopedic', 'explain'] as const)('also verifies old placeholders on collapsed %s cards', (contentType) => {
    useLiveViewportStore.getState().setZoom(0.1);
    const value = node({ renderedHeight: 300, bulletsCollapsed: true });
    value.versions[0] = { ...value.versions[0]!, contentType, freeTextHeight: 100 };
    const { container } = renderNode(value);
    expect(container.querySelector('.node')).toHaveAttribute('data-node-needs-measurement');
    expect(container.querySelector<HTMLElement>('.node-detail-surface')!.style.contentVisibility).toBe('visible');
  });
  it.each(['encyclopedic', 'explain', 'interactive'] as const)('renders an inert %s footer label', (contentType) => {
    const value = node();
    value.versions[0]!.contentType = contentType;
    const { container } = renderNode(value);
    const label = container.querySelector('.node-footer > .node-tag')!;
    expect(label.tagName).toBe('SPAN');
    expect(label).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(label);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('focuses and centers the requested node without adding an undo entry', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const { container } = renderNode(node());
    useGraphStore.temporal.getState().resume();
    useGraphStore.temporal.getState().clear();
    const button = screen.getByRole('button', { name: 'Fit node to screen' });
    expect(button.parentElement).toBe(container.querySelector('.node'));
    expect(button.closest('.node-detail-surface')).toBeNull();
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'node', id: 'n', fit: 'centered' });
    expect(useGraphStore.getState().project?.selection).toEqual(['n']);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it.each([
    ['image/png', 'image', true], ['image/gif', 'image', false], ['video/mp4', 'video', false],
  ] as const)('shows the image bottom panel only for still images (%s)', (mime, kind, visible) => {
    const media = node({ type: 'media', versions: [{ header: 'Media', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
      media: { source: 'link', kind, mime, url: 'https://example.com/file' } }] });
    const { container } = renderNode(media, true);
    expect(!!container.querySelector('.image-followup-bar')).toBe(visible);
    expect(!!container.querySelector('.image-selection-surface')).toBe(visible);
  });
  it('keeps overview and detail structurally stable without a height lock', () => {
    const { container } = renderNode(node());
    const card = container.querySelector<HTMLElement>('.node')!;
    expect(card).toHaveClass('node-overview-eligible');
    expect(card.style.height).toBe('');
    expect(card.querySelector('.node-overview-title')).not.toBeNull();
    expect(card.querySelector('.node-overview-skeleton')).not.toBeNull();
    expect(card.querySelector('.node-body')).not.toBeNull();
    expect(card.querySelector('.node-footer')).not.toBeNull();
    expect(card.querySelector('.node-corner-btn')).not.toBeNull();
  });

  it('counter-scales its initial title to at least 12 screen pixels', () => {
    useLiveViewportStore.getState().setZoom(0.1);
    const { container } = renderNode(node());
    const title = container.querySelector<HTMLElement>('.node-overview-title')!;
    const skeleton = container.querySelector<HTMLElement>('.node-overview-skeleton')!;
    expect(title.style.fontSize).toBe('120px');
    expect(skeleton.style.getPropertyValue('--overview-skeleton-gap')).toBe('70px');
    expect(skeleton.style.getPropertyValue('--overview-skeleton-unit')).toBe('10px');
    expect(skeleton.style.getPropertyValue('--overview-control-clearance')).toBe('374px');
    expect(title).toHaveAttribute('data-overview-title-compact');
    expect(title.style.getPropertyValue('--overview-title-reserve')).toBe('374px');
    expect(container.querySelector<HTMLElement>('.node-fit-btn')!.style.getPropertyValue('--node-overview-control-scale')).toBe('10');
  });

  it('gives conversations a decorative message skeleton without mounting message placeholders', () => {
    const chat = createChatNode({ id: 'n', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 500 });
    const { container } = renderNode(chat);
    const skeleton = container.querySelector('.node-overview-skeleton')!;
    expect(skeleton).toHaveClass('node-overview-skeleton--chat');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton.children).toHaveLength(0);
  });

  it('uses a distinct program skeleton for standalone interactive nodes', () => {
    const program = node({ type: 'interactive', versions: [{ header: 'Motion playground', body: '', createdAt: 1, generatedBy: 'interactive', contentType: 'interactive', interactiveStandalone: true }] });
    const { container } = renderNode(program);
    expect(container.querySelector('.node-overview-skeleton')).toHaveClass('node-overview-skeleton--interactive');
    expect(container.querySelector('.node-overview-title')).not.toHaveTextContent('explained');
    expect(container.querySelector('.interactive-node-empty')).toBeInTheDocument();
  });

  it('opens the interactive window with a maximize button sharing fit-control styling', () => {
    const program = node({ type: 'interactive', versions: [{ header: 'Motion playground', body: '', createdAt: 1, generatedBy: 'interactive', contentType: 'interactive', interactiveStandalone: true,
      interactive: { html: '<!doctype html><html><body>Program</body></html>', request: 'Motion', providerId: 'p', model: 'm' } }] });
    renderNode(program);
    const open = screen.getByRole('button', { name: 'Open interactive in a window' });
    const fit = screen.getByRole('button', { name: 'Fit node to screen' });
    expect(open).toHaveClass('node-corner-btn', 'node-interactive-open-btn');
    expect(open.querySelector('svg')).toHaveClass('lucide-maximize');
    expect(open.querySelector('svg')).toHaveAttribute('width', fit.querySelector('svg')!.getAttribute('width')!);
    fireEvent.click(open);
    expect(useInteractiveViewerStore.getState()).toMatchObject({ open: true, nodeId: program.id });
  });

  it('keeps the paragraph skeleton for a single answer extracted from a chat', () => {
    const answer = node();
    answer.versions[0] = { ...answer.versions[0]!, contentType: 'answer',
      chat: { turnId: 't1', question: 'Question', title: 'Answer', informationChunking: true, contextPath: [], state: 'complete' } };
    const { container } = renderNode(answer);
    expect(container.querySelector('.node-overview-skeleton')).not.toHaveClass('node-overview-skeleton--chat');
  });

  it('leaves attached media versions outside overview mode', () => {
    const mediaNode = node({
      type: 'media',
      versions: [{
        header: 'A diagram',
        body: '',
        createdAt: 1,
        generatedBy: 'media',
        contentType: 'media',
        media: {
          source: 'link',
          kind: 'image',
          url: 'https://example.com/image.png',
        },
      }],
    });
    const { container } = renderNode(mediaNode);
    const card = container.querySelector<HTMLElement>('.node')!;
    expect(card).not.toHaveClass('node-overview-eligible');
    expect(card.querySelector('.node-overview-title')).toBeNull();
    expect(card.querySelector('.node-body')).not.toBeNull();
  });

  it('keeps an empty media overview blank, with its title and fit button', () => {
    useLiveViewportStore.getState().setZoom(0.2);
    const emptyMedia = node({
      type: 'media',
      versions: [{
        header: 'An image idea',
        body: '',
        createdAt: 1,
        generatedBy: 'media',
        contentType: 'media',
      }],
    });
    const { container } = renderNode(emptyMedia);
    expect(container.querySelector('.node')).toHaveClass('node-overview-eligible');
    expect(container.querySelector('.node-overview-title')).not.toBeNull();
    expect(container.querySelector('.node-overview-skeleton')).toBeNull();
    expect(screen.getByRole('button', { name: 'Fit node to screen' })).toBeInTheDocument();
    expect(container.querySelector('.sc-media-attach-options')).not.toBeNull();
    expect(container.querySelector('.sc-media-image-generator')).toBeNull();
  });

  it.each(['encyclopedic', 'explain'] as const)('keeps an empty %s overview blank, with its title and fit button', (contentType) => {
    useLiveViewportStore.getState().setZoom(0.1);
    const empty = node({ versions: [{ header: 'Nothing here yet', body: '', createdAt: 1,
      generatedBy: 'manual', contentType, emptyText: true, initialTextFrame: true }] });
    const { container } = renderNode(empty);
    expect(container.querySelector('.node-overview-skeleton')).toBeNull();
    expect(container.querySelector('.node-overview-title')).toHaveAttribute('aria-label', 'Nothing here yet');
    expect(screen.getByRole('button', { name: 'Fit node to screen' })).toBeInTheDocument();
  });

  it.each(['encyclopedic', 'explain'] as const)('shows the normal %s overview skeleton once an empty node has content', (contentType) => {
    const populated = node({ versions: [{ header: 'New content', body: 'An opening paragraph.', createdAt: 1,
      generatedBy: 'manual', contentType, emptyText: true, initialTextFrame: true }] });
    const { container } = renderNode(populated);
    expect(container.querySelector('.node-overview-skeleton')).not.toBeNull();
  });

  it('keeps interactive explanations ready behind their overview title', () => {
    const interactive = node({
      type: 'explain',
      versions: [{
        header: 'Oscillation - explained',
        body: 'Oscillation repeats around an equilibrium.',
        createdAt: 1,
        generatedBy: 'interactive',
        contentType: 'interactive',
        interactive: {
          html: '<!doctype html><p>interactive</p>',
          request: 'oscillation',
          providerId: 'openrouter',
          model: 'model',
        },
      }],
    });
    const { container } = renderNode(interactive);
    expect(container.querySelector('.node')).toHaveClass('node-overview-eligible');
    expect(container.querySelector('.node-overview-title')).not.toBeNull();
    expect(container.querySelector('.node-body')).not.toBeNull();
  });

  it('keeps the selected-node follow-up panel outside the virtualized detail surface', () => {
    const { container } = renderNode(node(), true);
    const card = container.querySelector('.node')!;
    const followup = card.querySelector(':scope > .node-followup-bar');
    expect(followup).not.toBeNull();
    expect(card.querySelector('.node-detail-surface .node-followup-bar')).toBeNull();
  });

  it('lets a compact strict-source notice escape a stale tiny body height', () => {
    const limited = node({
      versions: [{
        header: 'A source-limited answer',
        body: '',
        createdAt: 1,
        generatedBy: 'term-click',
        contentType: 'encyclopedic',
        bodyMaxHeight: 32,
        sourceLimitation: {
          kind: 'not-enough-information',
          message: 'Sources only: Not enough information in active sources.',
          action: 'whole',
        },
      }],
    });
    const { container } = renderNode(limited);
    const body = container.querySelector<HTMLElement>('.node-body')!;

    expect(body.style.height).toBe('auto');
    expect(body.style.minHeight).toBe('68px');
    expect(body).toHaveTextContent('Not enough information in active sources.');
  });
});
