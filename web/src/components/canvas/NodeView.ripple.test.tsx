/**
 * Focus-ripple scoping.
 *
 * The aura ripples ONLY on a real focus change, driven by the selection
 * transition in sceneState (see rippleSim.diag.test.ts). NodeView's job here is
 * just the selection plumbing: clicking an UNSELECTED node calls onSelect()
 * (which selects it → sceneState ripples); re-clicking an ALREADY-SELECTED node
 * (e.g. clicking a bullet to expand it) is NOT a refocus and must not re-select.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeView } from './NodeView';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { INTERACTIVE_NODE_W } from '@/lib/nodeSize';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) h = 28;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

const BODY = `Intro paragraph.

- **One**
  - a: first
  - b: second`;

function makeNode(id: string): ScatterNode {
  return {
    id,
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: 'Node', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

const noop = () => {};

function renderNode(selected: boolean, onSelect: () => void) {
  const node = makeNode('n0');
  const proj = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
  return render(
    <NodeView
      node={node}
      selected={selected}
      onSelect={onSelect}
      onReferenceClick={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
    />,
  );
}

describe('NodeView — focus ripple', () => {
  it('does NOT re-select when an already-selected node is re-clicked (no refocus)', () => {
    const onSelect = vi.fn();
    const { container } = renderNode(true, onSelect);
    const wrapper = container.querySelector<HTMLElement>('[data-node-id="n0"]')!;
    fireEvent.click(wrapper);
    // Already selected: not a focus change → onSelect skipped (no re-ripple).
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects when an unselected node is clicked (which drives the ripple)', () => {
    const onSelect = vi.fn();
    const { container } = renderNode(false, onSelect);
    const wrapper = container.querySelector<HTMLElement>('[data-node-id="n0"]')!;
    fireEvent.click(wrapper);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('NodeView — opening-paragraph click on an unfocused node', () => {
  afterEach(() => {
    act(() => { useActiveIdxStore.getState().set('n0', null); });
  });

  it('focuses the node AND collapses the active bullet in one click', () => {
    const onSelect = vi.fn();
    const { container } = renderNode(false, onSelect);
    // A bullet is expanded (active) inside this unfocused node.
    act(() => { useActiveIdxStore.getState().set('n0', 0); });
    expect(useActiveIdxStore.getState().byNodeId['n0']).toBe(0);

    const freetext = container.querySelector<HTMLElement>('.sc-ab-freetext')!;
    fireEvent.click(freetext);

    // Focus: the click bubbled to NodeView's wrapper → onSelect.
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Collapse: the active bullet was cleared.
    expect(useActiveIdxStore.getState().byNodeId['n0'] ?? null).toBeNull();
  });
});

describe('NodeView — explain footer', () => {
  afterEach(() => {
    act(() => {
      useRewriteStore.setState({
        activeByNode: {},
        workingBody: {},
        snapshot: {},
        pendingSnapDown: {},
      });
    });
  });

  it('does not render the encyclopedic bullet chevron', () => {
    const node = makeNode('n0');
    node.type = 'explain';
    node.versions[0] = {
      ...node.versions[0]!,
      header: 'Node - explained',
      body: 'A prose-only explanation.',
      contentType: 'explain',
    };
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
    useGraphStore.temporal.getState().pause();

    const { container } = render(
      <NodeView
        node={node}
        selected
        onSelect={noop}
        onReferenceClick={noop}
        onDragStart={noop}
        onDragMove={noop}
        onDragEnd={noop}
      />,
    );

    expect(container.querySelector('.bullets-toggle-btn')).toBeNull();
  });


});

describe('NodeView — media footer', () => {
  it('has no collapse chevron and labels generated images as AI generated', () => {
    const node = makeNode('n0');
    node.type = 'media';
    node.versions[0] = {
      header: 'Image: cell', body: '', createdAt: 0, generatedBy: 'media', contentType: 'media',
      media: { source: 'link', kind: 'image', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
      imageGeneration: { prompt: 'cell', promptSource: 'media-prompt', providerId: 'p', model: 'm' },
    };
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });

    const { container } = render(
      <NodeView
        node={node} selected onSelect={noop} onReferenceClick={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      />,
    );
    expect(container.querySelector('.bullets-toggle-btn')).toBeNull();
    expect(container.querySelector('.node-footer > .node-tag')).toHaveTextContent('MEDIA');
    expect(container.querySelector('.node-tag--ai-generated')).toHaveTextContent('AI generated');
  });
});

describe('NodeView — fact-check footer provenance', () => {
  it.each(['encyclopedic', 'explain', 'answer'] as const)('keeps the fact-checked label for a checked %s node', (contentType) => {
    const node = makeNode('n0');
    const current = node.versions[0]!;
    current.contentType = contentType;
    if (contentType === 'answer') {
      current.chat = { turnId: 't1', question: 'Question', title: 'Answer',
        informationChunking: true, contextPath: [], state: 'complete' };
    }
    current.factCheck = {
      complete: {
        schemaVersion: 1,
        bodyFingerprint: 'checked-body',
        versionCreatedAt: current.createdAt,
        providerId: 'provider',
        model: 'model',
        startedAt: 1,
        completedAt: 2,
        complete: true,
        failedUnitIds: [],
        units: [],
      },
    };
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });

    const { container } = render(
      <NodeView
        node={node} selected onSelect={noop} onReferenceClick={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      />,
    );
    expect(container.querySelector('.node-tag--fact-checked')).toHaveTextContent('Fact-checked');
  });

  it('does not label an entire chat as fact-checked when one of its messages is checked', () => {
    let node = createChatNode({ id: 'n0', createdAt: 0, position: { x: 0, y: 0 }, bodyHeight: 300 });
    for (const createdAt of [1, 2]) {
      node = appendChatAnswer(node, { turnId: `t${createdAt}`, createdAt, question: `Question ${createdAt}` });
      node = updateChatAnswer(node, { turnId: `t${createdAt}`, versionCreatedAt: createdAt },
        { body: `Answer ${createdAt}.` }, { state: 'complete' });
    }
    node = { ...node, generating: false, streamingText: false, generatingVersionIndex: undefined, currentVersionIndex: 1 };
    node.versions[1]!.factCheck = {
      complete: {
        schemaVersion: 1, bodyFingerprint: 'checked-body', versionCreatedAt: 1,
        providerId: 'provider', model: 'model', startedAt: 1, completedAt: 2,
        complete: true, failedUnitIds: [], units: [],
      },
    };
    const project = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
    const props = { selected: false, onSelect: noop, onReferenceClick: noop,
      onDragStart: noop, onDragMove: noop, onDragEnd: noop };
    const { container, rerender } = render(<NodeView {...props} node={node} />);

    expect(container.querySelector('.node-tag--fact-checked')).toBeNull();
    expect(container.querySelector('[data-chat-turn="t1"]')).toHaveTextContent('Show fact-check');
    expect(container.querySelector('[data-chat-turn="t2"]')).not.toHaveTextContent('Show fact-check');

    // Selecting an unchecked message must not change the footer either.
    rerender(<NodeView {...props} node={{ ...node, currentVersionIndex: 2 }} />);
    expect(container.querySelector('.node-tag--fact-checked')).toBeNull();
  });
});

describe('NodeView — controls during generation', () => {
  it('keeps pin enabled while resize handles stay hidden', () => {
    const node = makeNode('n0');
    node.generating = true;
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
    const { container } = render(
      <NodeView
        node={node}
        selected
        onSelect={noop}
        onReferenceClick={noop}
        onDragStart={noop}
        onDragMove={noop}
        onDragEnd={noop}
      />,
    );
    const pin = container.querySelector<HTMLButtonElement>('[aria-label="Pin node"]')!;
    expect(pin.disabled).toBe(false);
    expect(container.querySelector('.node-resize')).toBeNull();
  });

  it('keeps the source body-height floor while a whole rewrite has only opening prose', () => {
    const node = makeNode('n0');
    node.generating = true;
    node.generatingVersionIndex = 0;
    node.versions[0] = {
      ...node.versions[0]!,
      body: 'Only the first streamed paragraph has arrived.',
      bodyMaxHeight: 120,
      freeTextHeight: 38,
    };
    const project = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({
      ...project,
      nodes: { n0: node },
      selection: ['n0'],
    });
    useRewriteStore.setState({
      activeByNode: {
        n0: [{
          id: 'whole',
          nodeId: 'n0',
          kind: 'whole',
          abortController: new AbortController(),
        }],
      },
      workingBody: { n0: node.versions[0]!.body },
      snapshot: {
        n0: {
          preBurstBody: BODY,
          preBurstVersionIndex: 0,
          draftVersionIndex: 0,
          generationSessionId: 1,
          preBurstBodyMaxHeight: 240,
          preBurstMinBodyHeight: 180,
          preBurstBodyHeightFloor: 240,
          preBurstFreeTextHeight: 70,
          preBurstHadBullets: true,
          preBurstWasAtMin: false,
        },
      },
      pendingSnapDown: {},
    });

    const { container } = render(
      <NodeView
        node={node}
        selected
        onSelect={noop}
        onReferenceClick={noop}
        onDragStart={noop}
        onDragMove={noop}
        onDragEnd={noop}
      />,
    );

    expect(container.querySelector('.node-body')).toHaveStyle({ height: '240px' });
  });
});

describe('NodeView — web-search provenance', () => {
  it('does not render a footer label when the model answers without using web search', () => {
    const node = makeNode('n0');
    node.versions[0] = { ...node.versions[0]!, webSearchFailed: true };
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
    const { container } = render(
      <NodeView
        node={node} selected onSelect={noop} onReferenceClick={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      />,
    );
    expect(container.querySelector('.node-tag--web-failed')).toBeNull();
  });

  it('does not render a footer label when web search was confirmed', () => {
    const node = makeNode('n0');
    node.versions[0] = { ...node.versions[0]!, webSearched: true, sources: undefined };
    const proj = createBlankProject('t', 'n0');
    useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
    const { container } = render(
      <NodeView
        node={node} selected onSelect={noop} onReferenceClick={noop}
        onDragStart={noop} onDragMove={noop} onDragEnd={noop}
      />,
    );
    expect(container.querySelector('.node-tag--web')).toBeNull();
  });
});
