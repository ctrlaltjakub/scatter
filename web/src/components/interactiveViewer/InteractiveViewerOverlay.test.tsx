import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import type { ScatterNode } from '@/store/types';
import { activateReference } from '@/lib/referenceAction';
import InteractiveViewerOverlay from './InteractiveViewerOverlay';
import { useInteractiveRuntimeStore } from '@/store/useInteractiveRuntimeStore';

vi.mock('@/lib/referenceAction', () => ({
  activateReference: vi.fn(() => ({ kind: 'spawned', completion: Promise.resolve('child') })),
}));
vi.mock('@/lib/readingController', () => ({
  exitReading: vi.fn(),
}));
vi.mock('@/components/node/InteractiveExplanationView', () => ({
  InteractiveExplanationView: () => <div data-testid="active-program">program</div>,
}));

const node: ScatterNode = {
  id: 'n1',
  type: 'explain',
  position: { x: 0, y: 0 },
  frozen: false,
  versions: [{
    header: 'Resonance - explained',
    headerParts: { subject: 'Resonance', suffix: 'explained' },
    body: 'Explore [[natural frequency]].⟦1⟧',
    createdAt: 1,
    generatedBy: 'interactive',
    contentType: 'interactive',
    sources: [{ n: 1, url: 'https://example.com/source', domain: 'example.com' }],
    interactive: {
      html: '<!doctype html><html><body></body></html>',
      request: 'Explain resonance',
      providerId: 'p',
      model: 'm',
      viewportWidth: 960,
      viewportHeight: 720,
    },
  }],
  currentVersionIndex: 0,
};

describe('InteractiveViewerOverlay', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.mocked(activateReference).mockClear();
    useLiveViewportStore.getState().clear();
    useLiveViewportStore.getState().setZoom(0.1);
    const project = createBlankProject('Viewer', node.id);
    useGraphStore.getState().setProject({
      ...project,
      nodes: { [node.id]: node },
      selection: [node.id],
    });
    useInteractiveViewerStore.getState().openViewer(node.id, 0);
    useRewriteStore.setState({
      activeByNode: {},
      workingBody: {},
      snapshot: {},
      pendingSnapDown: {},
    });
  });

  it('shows the dedicated program in one dialog', () => {
    const { container } = render(<InteractiveViewerOverlay />);
    const dialog = screen.getByRole('dialog', { name: /interactive:/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('Resonance - explained')).toBeInTheDocument();
    expect(screen.getByTestId('active-program')).toBeInTheDocument();
    expect(container.querySelector('.interactive-viewer-toolbar'))
      .toContainElement(screen.getByRole('button', { name: /exit/i }));
  });

  it('offers explicit acceptance without a draft label and leaves the draft unchanged on exit', () => {
    const original = node.versions[0]!;
    const failed = { ...original, interactive: undefined, interactiveStandalone: true,
      interactiveBuild: { request: 'Explain resonance', state: 'failed' as const, steps: [], draftHtml: original.interactive!.html, repairPasses: 5 } };
    useGraphStore.getState().updateNode(node.id, { versions: [failed] });
    useInteractiveViewerStore.getState().openViewer(node.id, 0, failed.createdAt);
    render(<StrictMode><InteractiveViewerOverlay /></StrictMode>);
    expect(screen.queryByText('Unverified draft')).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept this version' })).toBeVisible();
    expect(screen.getByTestId('active-program')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(useInteractiveViewerStore.getState().draftCreatedAt).toBeNull();
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]).toBe(failed);
  });

  it('accepts a preview without closing the viewer, and restores the option on undo', () => {
    const original = node.versions[0]!;
    const failed = { ...original, interactive: undefined, interactiveStandalone: true,
      interactiveBuild: { request: 'Explain resonance', state: 'failed' as const, steps: [], draftHtml: original.interactive!.html, repairPasses: 5 } };
    useGraphStore.getState().updateNode(node.id, { versions: [failed] });
    useGraphStore.temporal.getState().resume(); useGraphStore.temporal.getState().clear();
    useInteractiveViewerStore.getState().openViewer(node.id, 0, failed.createdAt);
    render(<InteractiveViewerOverlay />);
    fireEvent.click(screen.getByRole('button', { name: 'Accept this version' }));
    expect(screen.queryByRole('button', { name: 'Accept this version' })).toBeNull();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(useGraphStore.getState().project!.nodes[node.id]!.versions[0]?.interactive?.html).toBe(original.interactive!.html);
    act(() => useGraphStore.temporal.getState().undo());
    expect(screen.getByRole('button', { name: 'Accept this version' })).toBeVisible();
  });

  it('shows a standalone program without the old prose column and can restart locally', () => {
    useGraphStore.getState().updateNode(node.id, { type: 'interactive', versions: [{ ...node.versions[0]!, interactiveStandalone: true }] });
    const { container } = render(<InteractiveViewerOverlay/>);
    expect(container.querySelector('.interactive-viewer-text')).toBeNull();
    expect(screen.getByTestId('active-program')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(container.querySelector('.interactive-viewer-compose')).toBeNull();
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Restart', ' Exit']);
    expect(screen.getByRole('button', { name: 'Restart' }).querySelector('svg')).toHaveClass('lucide-play');
    const before = useInteractiveRuntimeStore.getState().revisions[node.id] ?? 0;
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(useInteractiveRuntimeStore.getState().revisions[node.id]).toBe(before + 1);
  });

  it('follows a standalone program into its live modification version', () => {
    const original = { ...node.versions[0]!, interactiveStandalone: true };
    useGraphStore.getState().updateNode(node.id, { type: 'interactive', versions: [original] });
    render(<InteractiveViewerOverlay/>);
    act(()=>useGraphStore.getState().updateNode(node.id, { versions: [original, { ...original, createdAt: 2, interactive: undefined,
      interactiveBuild: { request: 'Add reset', state: 'building', steps: [{ id: 1, label: 'Editing the program', state: 'running' }] } }],
      currentVersionIndex: 1, generating: true, generatingVersionIndex: 1 }));
    expect(screen.getByRole('log')).toHaveTextContent('Editing the program');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('fits the window to both available dimensions and responds to resize', () => {
    let width = 1200;
    let height = 800;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('interactive-viewer-stage')) return { width, height } as DOMRect;
      if (this.classList.contains('interactive-viewer-toolbar')) return { width: 900, height: 40 } as DOMRect;
      return { width: 0, height: 0 } as DOMRect;
    });
    const { container } = render(<InteractiveViewerOverlay/>);
    const card = container.querySelector<HTMLElement>('.interactive-viewer-card')!;
    // JSDOM has no stylesheet: the 40px header is the only reserved space.
    expect(Number(card.style.getPropertyValue('--interactive-viewer-scale'))).toBeCloseTo(760 / 720);
    width = 500;
    height = 900;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(Number(card.style.getPropertyValue('--interactive-viewer-scale'))).toBeCloseTo(500 / 960);
    width = 1200;
    height = 400;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(Number(card.style.getPropertyValue('--interactive-viewer-scale'))).toBeCloseTo(0.5);
    measure.mockRestore();
  });

  it('exits with the button and Escape', () => {
    render(<InteractiveViewerOverlay/>);
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(useInteractiveViewerStore.getState().open).toBe(false);
    act(() => useInteractiveViewerStore.getState().openViewer(node.id, 0));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useInteractiveViewerStore.getState().open).toBe(false);
  });

});
