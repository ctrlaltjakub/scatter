import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { RelationHoverPreview } from './RelationHoverPreview';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useReadingStore } from '@/store/useReadingStore';
import type { Arrow, ScatterNode } from '@/store/types';
import { termPreviewFingerprint } from '@/lib/termPreviewCore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { termPreviewProcess } from '@/lib/termPreviews';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';
import type { NodeVersion } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { AdaptiveBullets } from '@/components/node/AdaptiveBullets';

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: {
      configurable: true,
      get() { return this.classList.contains('relation-hover-preview-copy') ? 382 : 400; },
    },
    offsetWidth: {
      configurable: true,
      get() { return this.classList.contains('relation-hover-preview') ? 400 : 100; },
    },
    offsetHeight: {
      configurable: true,
      get() { return this.classList.contains('relation-hover-preview') ? 71 : 20; },
    },
    scrollHeight: {
      configurable: true,
      get() {
        if (!this.classList.contains('relation-hover-preview-measure')) return 20;
        const length = this.textContent?.length ?? 0;
        if (length > 112) return 78;
        if (length > 72) return 59;
        if (length > 38) return 40;
        return 21;
      },
    },
    scrollWidth: {
      configurable: true,
      get() { return 382; },
    },
  });
  Element.prototype.getClientRects = function () {
    const encoded = (this as HTMLElement).dataset?.testRect;
    const values = encoded?.split(',').map(Number);
    const left = values?.[0] ?? 300;
    const top = values?.[1] ?? 200;
    const right = values?.[2] ?? 380;
    const bottom = values?.[3] ?? 220;
    return [{
      x: left,
      y: top,
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    }] as unknown as DOMRectList;
  };
});

function child(): ScatterNode {
  return {
    id: 'child',
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [
      {
        header: 'Older',
        body: 'Older opening paragraph.',
        createdAt: 1,
        generatedBy: 'term-click',
      },
      {
        header: 'Current',
        body: '**Current opening** paragraph with [[useful context]].⟦1⟧',
        createdAt: 2,
        generatedBy: 'term-click',
      },
    ],
    currentVersionIndex: 1,
  };
}

function seed() {
  const project = createBlankProject('preview', 'parent');
  const parent: ScatterNode = { id: 'parent', type: 'root', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'Parent', body: '', createdAt: 1, generatedBy: 'root' }], currentVersionIndex: 0 };
  const arrow: Arrow = {
    id: 'selection-arrow',
    fromNodeId: 'parent',
    toNodeId: 'child',
    kind: 'auto',
    sourceSelection: {
      sourceVersionCreatedAt: 1,
      createdAt: 2,
      text: 'selected text',
      parts: [],
    },
  };
  useGraphStore.getState().setProject({
    ...project,
    nodes: { parent, child: child() },
    arrows: { [arrow.id]: arrow },
  });
}

function Harness({
  selectedText = false,
  splitSelection = false,
  viewer = false,
  unexplored = false,
  versionCreatedAt,
  expanded,
  collapsible = false,
  screenSized = false,
  citation = false,
}: {
  selectedText?: boolean;
  splitSelection?: boolean;
  viewer?: boolean;
  unexplored?: boolean;
  versionCreatedAt?: number;
  expanded?: boolean;
  collapsible?: boolean;
  screenSized?: boolean;
  citation?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <div data-preview-version={versionCreatedAt}
        className={collapsible ? `sc-collapsible-li${expanded ? ' is-pinned' : ''}` : expanded !== undefined ? 'sc-ab-item' : undefined}
        aria-expanded={expanded}
        {...(viewer ? { 'data-sc-reading-node-id': 'parent' } : {})}>
        <span
          data-testid="relation"
          {...(unexplored ? { 'data-reference-parent-id': 'parent', 'data-reference-term': 'cache' } : selectedText
            ? {
                'data-reading-relation-kind': 'selection',
                'data-reading-relation-parent-id': 'parent',
                'data-reading-relation-child-id': 'child',
                'data-relation-arrow-id': 'selection-arrow',
                ...(splitSelection ? { 'data-test-rect': '300,200,340,220' } : {}),
              }
            : { 'data-relation-child-id': 'child' })}
        >
          relation
          {citation && <span className="cite-marker" data-testid="citation">[1]</span>}
        </span>
        {splitSelection && (
          <span
            data-testid="relation-end"
            data-reading-relation-kind="selection"
            data-reading-relation-parent-id="parent"
            data-reading-relation-child-id="child"
            data-relation-arrow-id="selection-arrow"
            data-test-rect="420,240,500,260"
          >
            ending
          </span>
        )}
      </div>
      <RelationHoverPreview containerRef={containerRef} screenSized={screenSized} />
    </div>
  );
}

function ChatHarness({ versions }: { versions: NodeVersion[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return <div ref={containerRef}>
    {versions.map(version => <ChatMarkdown key={version.createdAt} nodeId="parent" version={version} />)}
    <RelationHoverPreview containerRef={containerRef} />
  </div>;
}

it('dismisses visible and pending mouse previews immediately when their content scrolls', () => {
  vi.useFakeTimers();
  useLiveViewportStore.getState().setZoom(1);
  seed();
  render(<Harness />);
  const term = screen.getByTestId('relation');
  fireEvent.pointerOver(term, { clientX: 320, clientY: 210 });
  act(() => vi.advanceTimersByTime(150));
  expect(document.getElementById('scatter-relation-hover-preview')).not.toBeNull();
  fireEvent.scroll(term.parentElement!);
  expect(document.getElementById('scatter-relation-hover-preview')).toBeNull();
  fireEvent.pointerOver(term, { clientX: 320, clientY: 210 });
  fireEvent.scroll(term.parentElement!);
  act(() => vi.advanceTimersByTime(150));
  expect(document.getElementById('scatter-relation-hover-preview')).toBeNull();
  cleanup();
  vi.useRealTimers();
});

function ExplainHarness({ body }: { body: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return <div ref={containerRef}>
    <AdaptiveBullets body={body} parentNodeId="parent" onReferenceClick={() => {}} />
    <RelationHoverPreview containerRef={containerRef} />
  </div>;
}

function chatVersions(body: string) {
  let node = createChatNode({ id: 'parent', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 400 });
  for (const createdAt of [4, 5]) {
    node = appendChatAnswer(node, { turnId: `turn-${createdAt}`, createdAt, question: 'Memory?', metadata: { informationChunking: false } });
    node = updateChatAnswer(node, { turnId: `turn-${createdAt}`, versionCreatedAt: createdAt }, { body }, { state: 'complete' });
  }
  node = { ...node, generating: false, versions: node.versions.map(version => ({ ...version,
    termPreviews: { fingerprint: termPreviewFingerprint(version), entries: {
      cache: `The **version ${version.createdAt}** explanation includes **its own context**.`,
    } },
  })) };
  useGraphStore.getState().updateNode('parent', node);
  useGraphStore.getState().setSelection(['child']);
  return node.versions.filter(version => version.chat);
}

describe('RelationHoverPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLiveViewportStore.getState().clear();
    useReadingStore.getState().reset();
    useSettingsStore.setState({ autoTermPreviews: true });
    useNodeStatusStore.setState({ statuses: {}, processes: {} });
    seed();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useGraphStore.setState({ project: null });
    useLiveViewportStore.getState().clear();
    useRewriteStore.getState().clearBurst('child');
    useReadingStore.getState().reset();
  });

  it('shows the current visible child version after the hover delay', () => {
    render(<Harness />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(
      /Current opening paragraph with useful context/,
    );
  });

  it('shows a complete bold explanation with no fade for an unexplored term', () => {
    const v = { header: 'Memory', body: 'A [[cache]] helps.', createdAt: 4, generatedBy: 'root' as const };
    useGraphStore.getState().updateNode('parent', { id: 'parent', versions: [{ ...v,
      termPreviews: { fingerprint: termPreviewFingerprint(v), entries: {
        cache: 'A cache is a **temporary store** that enables **faster access** to previously retrieved data, reducing repeated work across programs and services while keeping the original source available.',
      } } }], currentVersionIndex: 0 });
    render(<Harness unexplored />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('is-explanation');
    expect(tooltip).toHaveTextContent('keeping the original source available.');
    expect(tooltip.querySelectorAll('strong')).toHaveLength(2);
    expect(tooltip.querySelector('.relation-hover-preview-fade')).toBeNull();
  });

  it.each([
    'A [[cache]] helps.',
    'A **[[cache]]** helps.',
    'A [[**cache**]] helps.',
    'A *[[cache]]* helps.',
  ])('shows previews on real explain-node terms while focused and unfocused: %s', async (body) => {
    const version: NodeVersion = { header: 'Memory explained', body, createdAt: 4,
      headerParts: { subject: 'Memory', suffix: 'explained' }, generatedBy: 'explain', contentType: 'explain' };
    useGraphStore.getState().updateNode('parent', { type: 'explain', versions: [{ ...version,
      termPreviews: { fingerprint: termPreviewFingerprint(version), entries: {
        cache: 'A cache is a **temporary store** that enables **faster access**.',
      } } }], currentVersionIndex: 0 });
    useGraphStore.getState().setSelection(['parent']);
    const { container } = render(<ExplainHarness body={body} />);
    const term = container.querySelector<HTMLElement>('.sc-ab-freetext [data-reference-term="cache"]')!;
    expect(term).toHaveAttribute('data-reference-parent-id', 'parent');
    fireEvent.pointerOver(term);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveClass('is-explanation');
    expect(screen.getByRole('tooltip')).toHaveTextContent('A cache is a temporary store that enables faster access.');
    expect([...screen.getByRole('tooltip').querySelectorAll('strong')].map(part => part.textContent).join(''))
      .toBe('temporary storefaster access');
    expect(screen.getByRole('tooltip').querySelector('.relation-hover-preview-fade')).toBeNull();

    await act(async () => useGraphStore.getState().setSelection(['child']));
    fireEvent.focusIn(term);
    expect(screen.getByRole('tooltip')).toHaveClass('is-explanation');
    await act(async () => useGraphStore.getState().addArrow({ id: 'explain-term', kind: 'auto',
      fromNodeId: 'parent', toNodeId: 'child', label: 'cache' }));
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-explanation');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    expect(screen.getByRole('tooltip').querySelector('.relation-hover-preview-fade')).not.toBeNull();
  });

  it('reuses the generating preview while explanations are pending', () => {
    useGraphStore.getState().updateNode('parent', { id: 'parent', versions: [{
      header: 'Memory', body: 'A [[cache]] helps.', createdAt: 4, generatedBy: 'root',
    }], currentVersionIndex: 0 });
    useNodeStatusStore.getState().setProcessStatus('parent', termPreviewProcess(4), 'GENERATING TERM PREVIEWS');
    render(<Harness unexplored />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Generating');
  });

  it('updates a hovered explain term as its background preview finishes without moving the pointer', async () => {
    const version: NodeVersion = { header: 'Memory explained', body: 'A **[[cache]]** helps.', createdAt: 4,
      generatedBy: 'explain', contentType: 'explain' };
    useGraphStore.getState().updateNode('parent', { type: 'explain', versions: [version], currentVersionIndex: 0 });
    useNodeStatusStore.getState().setProcessStatus('parent', termPreviewProcess(4), 'GENERATING TERM PREVIEWS');
    const { container } = render(<ExplainHarness body={version.body} />);
    fireEvent.pointerOver(container.querySelector('.sc-ab-freetext [data-reference-term="cache"]')!);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Generating');
    await act(async () => {
      useGraphStore.getState().updateNode('parent', { versions: [{ ...version, termPreviews: {
        fingerprint: termPreviewFingerprint(version), entries: { cache: 'A **temporary store** enables **faster access**.' },
      } }] });
      useNodeStatusStore.getState().clearProcessStatus('parent', termPreviewProcess(4));
    });
    expect(screen.getByRole('tooltip')).toHaveClass('is-explanation');
    expect(screen.getByRole('tooltip')).toHaveTextContent('A temporary store enables faster access.');
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-compact');
  });

  it('hides cached explanations when disabled but keeps connected-node openings', () => {
    const versions = chatVersions('A [[cache]] helps.');
    render(<ChatHarness versions={versions} />);
    const term = screen.getAllByRole('button', { name: 'cache' })[0]!;
    fireEvent.focusIn(term);
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 4');
    act(() => useSettingsStore.setState({ autoTermPreviews: false }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => useGraphStore.getState().addArrow({ id: 'linked-term', kind: 'auto', fromNodeId: 'parent',
      toNodeId: 'child', label: 'cache', sourceAnswer: { turnId: 'turn-4', versionCreatedAt: 4 } }));
    fireEvent.focusIn(term);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-explanation');
  });

  it('does not show a generating tooltip when automatic previews are disabled', () => {
    useSettingsStore.setState({ autoTermPreviews: false });
    useGraphStore.getState().updateNode('parent', { versions: [{ header: 'Memory', body: 'A [[cache]] helps.',
      createdAt: 4, generatedBy: 'root' }], currentVersionIndex: 0 });
    useNodeStatusStore.getState().setProcessStatus('parent', termPreviewProcess(4), 'GENERATING TERM PREVIEWS');
    render(<Harness unexplored />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('renders bold in the shortened child opening', () => {
    render(<Harness />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip').querySelector('strong')).toHaveTextContent('Current opening');
    expect(screen.getByRole('tooltip').querySelector('.relation-hover-preview-fade')).not.toBeNull();
  });

  it('uses the hovered historical answer rather than the active chat version', () => {
    const versions = [4, 5].map(createdAt => {
      const v = { header: 'Memory', body: `Version ${createdAt} [[cache]].`, createdAt, generatedBy: 'chat' as const, contentType: 'answer' as const };
      return { ...v, termPreviews: { fingerprint: termPreviewFingerprint(v), entries: {
        cache: `The **version ${createdAt}** explanation includes **its own context**.`,
      } } };
    });
    useGraphStore.getState().updateNode('parent', { versions, currentVersionIndex: 1 });
    render(<Harness unexplored versionCreatedAt={4} />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 4');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('version 5');
  });

  it.each([
    'A [[cache]] helps.',
    'A **[[cache]]** helps.',
    '| Term | Use |\n| --- | --- |\n| [[cache]] | Faster access |',
  ])('uses shared previews for real chat terms, including bold and table cells: %s', async (body) => {
    render(<ChatHarness versions={chatVersions(body)} />);
    const terms = screen.getAllByRole('button', { name: 'cache' });
    fireEvent.pointerOver(terms[0]!);
    act(() => vi.advanceTimersByTime(120));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveClass('is-explanation');
    expect(tooltip).toHaveTextContent('version 4');
    expect(tooltip).not.toHaveTextContent('version 5');
    expect([...tooltip.querySelectorAll('strong')].map(part => part.textContent).join('')).toBe('version 4its own context');
    expect(tooltip.querySelector('.relation-hover-preview-fade')).toBeNull();
    expect(useGraphStore.getState().project!.selection).toEqual(['child']);

    await act(async () => { useGraphStore.getState().addArrow({ id: 'chat-term', kind: 'auto', fromNodeId: 'parent',
      toNodeId: 'child', label: 'cache', sourceAnswer: { turnId: 'turn-4', versionCreatedAt: 4 } }); });
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-explanation');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    expect(screen.getByRole('tooltip').querySelector('.relation-hover-preview-fade')).not.toBeNull();
    fireEvent.focusIn(terms[1]!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 5');
    expect(screen.getByRole('tooltip')).toHaveClass('is-explanation');
  });

  it('allows mouse previews during ruler use but not in zoomed-out overview', () => {
    render(<ChatHarness versions={chatVersions('A [[cache]] helps.')} />);
    const term = screen.getAllByRole('button', { name: 'cache' })[0]!;
    fireEvent.focusIn(term);
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 4');
    act(() => useReadingStore.getState().begin('parent', 0, 0, null));
    fireEvent.pointerOver(term);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 4');
    act(() => { useReadingStore.getState().reset(); useLiveViewportStore.getState().setZoom(0.34); });
    fireEvent.focusIn(term);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => useLiveViewportStore.getState().setZoom(1));
    fireEvent.focusIn(term);
    expect(screen.getByRole('tooltip')).toHaveTextContent('version 4');
  });

  it('switches an already-open term tooltip to the real child as soon as it exists', () => {
    const v = { header: 'Memory', body: 'A [[cache]].', createdAt: 4, generatedBy: 'root' as const };
    useGraphStore.getState().updateNode('parent', { versions: [{ ...v, termPreviews: {
      fingerprint: termPreviewFingerprint(v), entries: { cache: 'A **temporary store** enables **faster access**.' },
    } }], currentVersionIndex: 0 });
    render(<Harness unexplored />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toHaveClass('is-explanation');
    act(() => { const project = useGraphStore.getState().project!;
      useGraphStore.setState({ project: { ...project, arrows: { ...project.arrows,
        explored: { id: 'explored', kind: 'auto', fromNodeId: 'parent', toNodeId: 'child', label: 'cache' },
      } } });
    });
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-explanation');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
  });

  it('does not restart the hover delay for movement inside one relation', () => {
    render(<Harness />);
    const relation = screen.getByTestId('relation');
    fireEvent.pointerOver(relation, { clientX: 310, clientY: 210 });
    act(() => vi.advanceTimersByTime(80));
    fireEvent.pointerOver(relation, { clientX: 350, clientY: 210 });
    act(() => vi.advanceTimersByTime(40));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Current opening/);
  });

  it('resolves selected-text marks through their persisted arrow', () => {
    render(<Harness selectedText />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Current opening/);
  });

  it('follows the child version the user is currently viewing', () => {
    render(<Harness />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Current opening/);

    act(() => {
      useGraphStore.getState().updateNode('child', { currentVersionIndex: 0 });
    });
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Older opening paragraph/);
  });

  it('reads live streamed prose for the displayed generating version', () => {
    useRewriteStore.getState().setSnapshot('child', {
      preBurstBody: 'Current opening paragraph.',
      preBurstVersionIndex: 1,
      draftVersionIndex: 1,
      generationSessionId: 1,
      preBurstBodyMaxHeight: null,
      preBurstMinBodyHeight: null,
      preBurstBodyHeightFloor: null,
      preBurstFreeTextHeight: null,
      preBurstHadBullets: false,
      preBurstWasAtMin: false,
    });
    useRewriteStore.getState().setWorkingBody(
      'child',
      'Live streamed opening has already arrived.',
    );
    render(<Harness />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Live streamed opening/);
  });

  it('uses generation and header fallbacks when the child has no opening prose', () => {
    const project = useGraphStore.getState().project!;
    const current = project.nodes.child!;
    act(() => {
      useGraphStore.getState().updateNode('child', {
        generating: true,
        versions: current.versions.map((version, index) => (
          index === current.currentVersionIndex ? { ...version, body: '' } : version
        )),
      });
    });
    const { rerender } = render(<Harness />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/^Generating\./);
    expect(screen.getByRole('tooltip')).toHaveClass('is-compact');
    expect(
      screen.getByRole('tooltip').querySelector('.relation-hover-preview-fade'),
    ).toBeNull();

    act(() => useGraphStore.getState().updateNode('child', { generating: false }));
    rerender(<Harness />);
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/^Current\./);
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-compact');
  });

  it('does not show a preview below the shared 35% threshold', () => {
    act(() => useLiveViewportStore.getState().setZoom(0.34));
    render(<Harness />);
    fireEvent.pointerOver(screen.getByTestId('relation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keeps enlarged-view previews screen-sized and available while the underlying canvas is zoomed out', () => {
    act(() => useLiveViewportStore.getState().setZoom(0.2));
    render(<Harness viewer screenSized />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Current opening/);
    expect(screen.getByRole('tooltip')).toHaveStyle({ transform: 'scale(1)' });
  });

  it('does not show a term preview when hovering a citation nested inside a title term', () => {
    render(<Harness citation />);
    fireEvent.pointerOver(screen.getByTestId('citation'), { clientX: 320, clientY: 210 });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens immediately for keyboard focus', () => {
    render(<Harness />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toHaveAccessibleName(/Current opening/);
  });

  it('shows word-ruler terms in a screen-sized viewer even below 35%', () => {
    act(() => useLiveViewportStore.getState().setZoom(0.2));
    render(<Harness viewer screenSized />);
    const relation = screen.getByTestId('relation');
    act(() => {
      useReadingStore.getState().begin('parent', 0, 0, 0);
      useReadingStore.getState().setPos(0, 0, 0, {
        kind: 'term',
        parentNodeId: 'parent',
        term: 'relation',
        childId: 'child',
        element: relation,
      });
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    act(() => useReadingStore.getState().setPos(0, 0, null));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does not auto-preview a ruler selection, but still allows mouse hover', () => {
    render(<Harness selectedText splitSelection />);
    const relation = screen.getByTestId('relation');
    act(() => {
      useReadingStore.getState().begin('parent', 0, 0, 0);
      useReadingStore.getState().setPos(0, 0, 0, {
        kind: 'selection',
        parentNodeId: 'parent',
        childId: 'child',
        arrowId: 'selection-arrow',
        element: relation,
      });
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerOver(relation);
    fireEvent.focusIn(relation);
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
  });

  it.each([0, 120])('keeps mouse previews when the ruler starts after %d ms', (delay) => {
    render(<Harness />);
    const relation = screen.getByTestId('relation');
    fireEvent.pointerOver(relation);
    act(() => vi.advanceTimersByTime(delay));
    act(() => useReadingStore.getState().begin('parent', 0, 0, null));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    act(() => useReadingStore.getState().reset());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    fireEvent.pointerOver(relation);
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
  });

  it.each([false, true])('requires fully expanded bullets (Markdown: %s)', (collapsible) => {
    const { rerender } = render(<Harness expanded={false} collapsible={collapsible} />);
    fireEvent.pointerOver(screen.getByTestId('relation'));
    fireEvent.focusIn(screen.getByTestId('relation'));
    act(() => vi.advanceTimersByTime(120));
    expect(screen.queryByRole('tooltip')).toBeNull();
    rerender(<Harness expanded collapsible={collapsible} />);
    fireEvent.pointerOver(screen.getByTestId('relation'));
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
  });

  it('hides an open preview when its bullet collapses without pointer movement', async () => {
    const { rerender } = render(<Harness expanded />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    await act(async () => { rerender(<Harness expanded={false} />); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows previews in an unfocused node without changing selection', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({ project: { ...project, selection: ['child'] } });
    render(<Harness expanded />);
    fireEvent.pointerOver(screen.getByTestId('relation'));
    act(() => vi.advanceTimersByTime(120));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Current opening');
    expect(useGraphStore.getState().project!.selection).toEqual(['child']);
  });

  it('keeps a canvas-sized card and gap by scaling them with live zoom', () => {
    act(() => useLiveViewportStore.getState().setZoom(0.5));
    render(<Harness />);
    fireEvent.focusIn(screen.getByTestId('relation'));
    const preview = screen.getByRole('tooltip');
    expect(preview).toHaveStyle({
      transform: 'scale(0.5)',
      left: '240px',
      top: '161.5px',
      visibility: 'visible',
    });
  });
});
