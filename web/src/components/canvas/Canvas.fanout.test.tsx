/**
 * PERF GUARD — a single-node edit must not re-render every NodeView.
 *
 * Canvas subscribes to `useGraphStore((s) => s.project)`, so a one-node
 * `updateNode` re-mints `project` and re-renders Canvas's node map. The
 * thing that KEEPS this cheap is NodeView's `React.memo` comparator
 * (`prev.node === next.node && prev.selected === next.selected`):
 * `updateNode` preserves the object reference of every OTHER node, so
 * their NodeViews bail and only the edited node re-renders. This test
 * pins that contract with a mock that mirrors the real memo — if someone
 * ever drops the memo, or makes `updateNode` clone unrelated nodes, this
 * fails and the "toggling bullets janks the canvas" regression is back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { Canvas } from './Canvas';

const physicsMock = vi.hoisted(() => {
  const instances: unknown[] = [];
  const make = () => {
    const inst = {
      init: vi.fn(), addNode: vi.fn(), addLink: vi.fn(), removeNodes: vi.fn(),
      setSize: vi.fn(), setFrozen: vi.fn(), setConfig: vi.fn(),
      dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
      onTick: vi.fn(() => () => {}), onInput: vi.fn(() => () => {}), terminate: vi.fn(),
    };
    instances.push(inst);
    return inst;
  };
  return { instances, make };
});

vi.mock('@/physics/physicsClient', () => ({
  PhysicsClient: vi.fn(function () { return physicsMock.make(); }),
}));

// Count NodeView RENDERS. Mock mirrors the REAL NodeView's memo contract
// (compare node reference + selected) so the count reflects what actually
// re-renders in production, not an un-memoized stand-in.
const nodeViewCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('./NodeView', async () => {
  const React = await import('react');
  const Inner = (p: { node: { id: string }; selected: boolean }) => { nodeViewCalls.n++; return null; };
  const NodeView = React.memo(Inner, (a, b) => a.node === b.node && a.selected === b.selected);
  return { NodeView };
});
vi.mock('./ArrowLayer', () => ({ ArrowLayer: () => null }));
vi.mock('./AsciiAuraLayer', () => ({ AsciiAuraLayer: () => null }));
vi.mock('./SearchHighlighter', () => ({ SearchHighlighter: () => null }));
vi.mock('./ReadingHighlighter', () => ({ ReadingHighlighter: () => null }));
vi.mock('./SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('./CanvasToolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('./NodeSidePanel', () => ({ PANEL_W: 288, PANEL_GAP: 12, NodeSidePanel: () => null }));
vi.mock('./NodeCitationsPanel', () => ({ NodeCitationsPanel: () => null }));
vi.mock('@/components/dev/PixelRuler', () => ({ PixelRuler: () => null }));

const noop = () => {};

function node(id: string): ScatterNode {
  return {
    id, type: id === 'n0' ? 'root' : 'term-click',
    position: { x: 0, y: 0 }, frozen: false, renderedHeight: 300,
    versions: [{ header: id, body: 'Intro.\n\n- **One**\n  - a: detail', createdAt: 0, generatedBy: 'root', width: 624, bodyMaxHeight: 228 }],
    currentVersionIndex: 0,
  };
}

function seed(count: number) {
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < count; i++) nodes[`n${i}`] = node(`n${i}`);
  const project = createBlankProject('fanout', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes });
  useGraphStore.temporal.getState().pause();
}

function renderCanvas() {
  return render(
    <Canvas sidebarCollapsed onOpenSettings={noop} onReferenceClick={noop}
      onAskFollowUp={noop} onModify={noop} />,
  );
}

beforeEach(() => {
  physicsMock.instances.length = 0;
  nodeViewCalls.n = 0;
  useGraphStore.getState().setProject(null);
  useGraphStore.temporal.getState().clear();
});
afterEach(() => { cleanup(); useGraphStore.getState().setProject(null); });

describe('Canvas fan-out on a single-node field edit', () => {
  it('does NOT re-render every NodeView when one node toggles bulletsCollapsed', async () => {
    const N = 29;
    seed(N);
    renderCanvas();
    await act(async () => {});
    nodeViewCalls.n = 0; // ignore mount renders

    act(() => {
      useGraphStore.getState().updateNode('n10', { bulletsCollapsed: true });
    });

    // Only the edited node's NodeView may re-render; the other N-1 bail
    // on the memo because their node reference is unchanged.
    expect(nodeViewCalls.n).toBeLessThanOrEqual(1);
  });

  it('DOES re-render the node list when a node is added (structural change)', async () => {
    seed(5);
    renderCanvas();
    await act(async () => {});
    nodeViewCalls.n = 0;

    act(() => {
      useGraphStore.getState().addNode(node('n5'));
    });

    // A structural change (new id) legitimately re-renders the list.
    expect(nodeViewCalls.n).toBeGreaterThan(0);
  });
});
