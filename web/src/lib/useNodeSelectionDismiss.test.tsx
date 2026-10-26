import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { ScatterNode } from '@/store/types';
import { useNodeSelectionDismiss } from './useNodeSelectionDismiss';
import { NodeSelectionToolbar } from '@/components/canvas/NodeSelectionToolbar';

function node(id: string, groupId?: string): ScatterNode {
  return { id, groupId, type: 'term-click', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: id, body: 'Text', createdAt: 1, generatedBy: 'root' }] };
}

function Fixture() {
  const canvasRef = useRef<HTMLDivElement>(null);
  useNodeSelectionDismiss(canvasRef);
  return <>
    <aside data-testid="sidebar-space">
      <button data-sidebar-group-id="g" onClick={() => useGraphStore.getState().selectGroup('g')}><span>Group</span></button>
      <button data-sidebar-group-id="other" onClick={() => useGraphStore.getState().selectGroup('other')}>Other group</button>
      <button onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>Toolbar action</button>
      <input aria-label="Search nodes" />
    </aside>
    <div className="canvas-host" ref={canvasRef} data-testid="canvas">
      <div className="node" data-node-id="member">
        <span>Member text</span>
        <button className="node-corner-btn">Node action</button>
        <div className="node-followup-bar"><textarea aria-label="Follow-up" /></div>
      </div>
      <div className="node" data-node-id="member2">Second member</div>
      <div className="node" data-node-id="outside">Other node</div>
      <div className="node" data-node-id="root">Ungrouped node</div>
      <NodeSelectionToolbar />
    </div>
    {createPortal(<button onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>Portal action</button>, document.body)}
  </>;
}

beforeEach(() => {
  const project = createBlankProject('Group selection', 'root');
  useGraphStore.setState({ project: { ...project,
    groups: { g: { id: 'g', name: 'Group', color: '#abcdef', gravitate: false },
      other: { id: 'other', name: 'Other group', color: '#fedcba', gravitate: false } },
    nodes: { root: node('root'), member: node('member', 'g'), member2: node('member2', 'g'), outside: node('outside', 'other') },
  }, selectedGroupId: null, panTo: null });
  useGraphStore.getState().selectGroup('g');
  useGraphStore.temporal.getState().clear();
});
afterEach(() => {
  cleanup();
  useGraphStore.setState({ project: null, selectedGroupId: null });
});

describe.each(['group', 'manual'] as const)('click-away %s selection', mode => {
  beforeEach(() => {
    if (mode === 'manual') useGraphStore.getState().setSelection(['member', 'member2']);
  });
  it.each(['Toolbar action', 'Portal action', 'Other node', 'Ungrouped node', 'Node action'])
    ('clears the group when pressing %s, even if propagation is stopped', label => {
      render(<Fixture />);
      fireEvent.pointerDown(screen.getByText(label));
      expect(useGraphStore.getState().selectedGroupId).toBeNull();
      expect(useGraphStore.getState().project?.selection).toEqual([]);
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    });

  it('also clears on search fields, empty sidebar space, and the follow-up panel', () => {
    render(<Fixture />);
    for (const element of [screen.getByLabelText('Search nodes'), screen.getByTestId('sidebar-space'), screen.getByLabelText('Follow-up')]) {
      act(() => mode === 'group' ? useGraphStore.getState().selectGroup('g') : useGraphStore.getState().setSelection(['member', 'member2']));
      fireEvent.pointerDown(element);
      expect(useGraphStore.getState().selectedGroupId).toBeNull();
      expect(useGraphStore.getState().project?.selection).toEqual([]);
    }
  });

  it('keeps the group selected on its own tab and while focusing or dragging a member', () => {
    render(<Fixture />);
    const tab = screen.getByText('Group');
    fireEvent.pointerDown(tab);
    fireEvent.click(tab);
    const member = screen.getByText('Member text');
    fireEvent.pointerDown(member);
    fireEvent.pointerMove(member, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(member);
    fireEvent.click(member);
    expect(useGraphStore.getState().selectedGroupId).toBe('g');
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('allows another group tab to select its own group after dismissing the previous one', () => {
    render(<Fixture />);
    const other = screen.getByText('Other group');
    fireEvent.pointerDown(other);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    fireEvent.click(other);
    expect(useGraphStore.getState().selectedGroupId).toBe('other');
  });

  it('handles keyboard-triggered clicks without requiring pointer events', () => {
    render(<Fixture />);
    fireEvent.click(screen.getByText('Toolbar action'), { detail: 0 });
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    expect(useGraphStore.getState().project?.selection).toEqual([]);
  });

  it('leaves background gestures to Canvas and does not dismiss on wheel or hover', () => {
    render(<Fixture />);
    fireEvent.pointerDown(screen.getByTestId('canvas'));
    fireEvent.click(screen.getByTestId('canvas'));
    fireEvent.wheel(screen.getByTestId('sidebar-space'), { deltaY: 100 });
    fireEvent.pointerMove(screen.getByText('Toolbar action'));
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
  });

  it('removes its document listeners when the canvas unmounts', () => {
    const view = render(<Fixture />);
    view.unmount();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
  });

  it('keeps selected nodes active on ordinary member clicks', () => {
    render(<Fixture />);
    fireEvent.pointerDown(screen.getByText('Member text'));
    fireEvent.click(screen.getByText('Member text'));
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
  });

  it('keeps the bottom toolbar and its drop-up usable through pointer and keyboard activation', () => {
    render(<Fixture />);
    const pin = screen.getByRole('button', { name: 'Pin selected nodes' });
    fireEvent.pointerDown(pin);
    fireEvent.click(pin);
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
    expect(useGraphStore.getState().project?.nodes.member?.frozen).toBe(true);
    expect(useGraphStore.getState().project?.nodes.member2?.frozen).toBe(true);
    const group = screen.getByRole('button', { name: 'Add to group' });
    fireEvent.pointerDown(group);
    fireEvent.click(group);
    const option = screen.getByRole('button', { name: 'Add selected nodes to Other group' });
    fireEvent.pointerDown(option);
    fireEvent.click(option, { detail: 0 });
    expect(useGraphStore.getState().project?.selection).toEqual(['member', 'member2']);
    expect(useGraphStore.getState().project?.nodes.member?.groupId).toBe('other');
    expect(useGraphStore.getState().project?.nodes.member2?.groupId).toBe('other');
  });
});

it('does not change single-node focus when clicking unrelated UI', () => {
  useGraphStore.getState().setSelection(['member']);
  render(<Fixture />);
  fireEvent.pointerDown(screen.getByText('Toolbar action'));
  fireEvent.click(screen.getByText('Toolbar action'));
  expect(useGraphStore.getState().project?.selection).toEqual(['member']);
});
