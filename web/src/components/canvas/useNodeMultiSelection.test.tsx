import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useNodeMultiSelection } from './useNodeMultiSelection';
import { useCanvasSelectionStore } from '@/store/useCanvasSelectionStore';
import { ReferenceChip } from '@/components/node/ReferenceChip';
import { useNodeSelectionDismiss } from '@/lib/useNodeSelectionDismiss';

const onFocus = vi.fn();
const onDrag = vi.fn();
const onChip = vi.fn();
const onExpand = vi.fn();
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  useNodeSelectionDismiss(ref);
  const { handlers } = useNodeMultiSelection(ref);
  const project = useGraphStore((s) => s.project)!;
  return <div ref={ref} data-testid="canvas" {...handlers}>
    {Object.values(project.nodes).map((node) => <div key={node.id} className="node" data-node-id={node.id}
      onClick={onFocus} onPointerDown={onDrag}>
      <span>{node.id}</span>
      <ul><li role="button" className="sc-ab-item" onClick={onExpand} tabIndex={0} aria-expanded={false}>
        <span>Bullet in {node.id}</span>
        <ReferenceChip term={`Term in ${node.id}`} parentNodeId={node.id} onClick={onChip}>
          <strong>Term in {node.id}</strong>
        </ReferenceChip>
      </li></ul>
    </div>)}
  </div>;
}
beforeEach(() => {
  const project = createBlankProject('Test', 'a');
  project.nodes = Object.fromEntries(['a', 'b', 'c'].map((id, index) => [id, {
    id, type: 'term-click', position: { x: index * 600, y: 0 }, frozen: true, renderedHeight: 100,
    versions: [{ header: id, body: 'Text.', width: 300, createdAt: 1, generatedBy: 'manual' }], currentVersionIndex: 0,
  }]));
  useGraphStore.setState({ project, selectedGroupId: null });
  useGraphStore.temporal.getState().clear();
  useLivePositionsStore.getState().clear();
  useLiveViewportStore.getState().setViewport({ x: 50, y: 40, zoom: 0.5 });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  onFocus.mockClear(); onDrag.mockClear(); onChip.mockClear(); onExpand.mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const selection = () => useGraphStore.getState().project!.selection;
function start(host: HTMLElement, x = 30, y = 20) {
  fireEvent.pointerDown(host, { button: 0, pointerId: 1, shiftKey: true, clientX: x, clientY: y });
}
function move(host: HTMLElement, x: number, y: number) {
  fireEvent.pointerMove(host, { pointerId: 1, clientX: x, clientY: y });
}
describe('node multi-selection gestures', () => {
  it('Ctrl/Command click toggles membership without focusing, dragging, or panning', () => {
    render(<Harness />);
    fireEvent.pointerDown(screen.getByText('a'), { button: 0, ctrlKey: true });
    fireEvent.click(screen.getByText('a'), { ctrlKey: true });
    fireEvent.click(screen.getByText('b'), { metaKey: true });
    expect(selection()).toEqual(['a', 'b']);
    fireEvent.click(screen.getByText('a'), { ctrlKey: true });
    expect(selection()).toEqual(['b']);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it.each(['ctrlKey', 'metaKey'] as const)('keeps the existing selection when adding a third node with %s', modifier => {
    useGraphStore.getState().setSelection(['a', 'b']);
    render(<Harness />);
    const target = screen.getByText('c');
    fireEvent.pointerDown(target, { button: 0, [modifier]: true });
    fireEvent.click(target, { [modifier]: true });
    expect(selection()).toEqual(['a', 'b', 'c']);
  });
  it('can extend a group selection and drops only the group origin', () => {
    const graph = useGraphStore.getState();
    const groupId = graph.createGroup('Group');
    graph.assignNodesToGroup(['b', 'c'], groupId);
    graph.selectGroup(groupId);
    render(<Harness />);
    const target = screen.getByText('a');
    fireEvent.pointerDown(target, { button: 0, ctrlKey: true });
    fireEvent.click(target, { ctrlKey: true });
    expect(selection()).toEqual(['b', 'c', 'a']);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });
  it('restores a group after cancelling a Shift-drag begun on an unselected node', () => {
    const graph = useGraphStore.getState();
    const groupId = graph.createGroup('Group');
    graph.assignNodesToGroup(['b', 'c'], groupId);
    graph.selectGroup(groupId);
    render(<Harness />);
    start(screen.getByText('a'), 60, 45);
    move(screen.getByTestId('canvas'), 480, 100);
    expect(selection()).toEqual(['a', 'b']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(selection()).toEqual(['b', 'c']);
    expect(useGraphStore.getState().selectedGroupId).toBe(groupId);
  });
  it.each(['ctrlKey', 'metaKey'] as const)('preserves %s term activation, including nested bold text', modifier => {
    render(<Harness />);
    const term = screen.getByText('Term in a');
    fireEvent.pointerDown(term, { button: 0, [modifier]: true });
    fireEvent.click(term, { [modifier]: true });
    expect(onChip).toHaveBeenCalledExactlyOnceWith('Term in a', { withModifier: true });
    expect(selection()).toEqual([]);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onExpand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('b'));
    expect(onFocus).toHaveBeenCalled();
  });
  it.each(['ctrlKey', 'metaKey'] as const)('keeps %s on ordinary bullet text available for multi-selection', modifier => {
    render(<Harness />);
    const bullet = screen.getByText('Bullet in a');
    fireEvent.pointerDown(bullet, { button: 0, [modifier]: true });
    fireEvent.click(bullet, { [modifier]: true });
    expect(selection()).toEqual(['a']);
    expect(onExpand).not.toHaveBeenCalled();
    expect(onChip).not.toHaveBeenCalled();
    expect(onFocus).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
  });
  it('uses live positions and viewport coordinates, in either drag direction', () => {
    render(<Harness />);
    const host = screen.getByTestId('canvas');
    useLivePositionsStore.getState().setPosition('c', 650, 0);
    start(host, 490, 110);
    move(host, 30, 20);
    expect(selection()).toEqual(['a', 'b', 'c']);
    expect(useCanvasSelectionStore.getState().marquee?.rect).toEqual({ x: 30, y: 20, w: 460, h: 90 });
    expect(host).toHaveAttribute('data-node-box-selecting');
    fireEvent.pointerUp(host, { pointerId: 1, clientX: 30, clientY: 20 });
    expect(host).not.toHaveAttribute('data-node-box-selecting');
    expect(useCanvasSelectionStore.getState().marquee).toBeNull();
    fireEvent.click(screen.getByText('a'));
    expect(onFocus).not.toHaveBeenCalled();
  });
  it('can begin over a node without starting a node drag; cancellation restores selection', () => {
    render(<Harness />);
    act(() => useGraphStore.getState().setSelection(['c']));
    start(screen.getByText('a'), 60, 45);
    move(screen.getByTestId('canvas'), 480, 100);
    expect(selection()).toEqual(['a', 'b']);
    expect(onDrag).not.toHaveBeenCalled();
    fireEvent.pointerCancel(screen.getByTestId('canvas'), { pointerId: 1 });
    expect(selection()).toEqual(['c']);
  });
  it('Escape cancels a rectangle and a project switch cannot leak its selection', () => {
    render(<Harness />);
    const host = screen.getByTestId('canvas');
    start(host); move(host, 480, 100);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(selection()).toEqual([]);
    start(host); move(host, 480, 100);
    act(() => useGraphStore.getState().setProject(createBlankProject('Other', 'other')));
    move(host, 800, 100);
    expect(selection()).toEqual([]);
    expect(useCanvasSelectionStore.getState().marquee).toBeNull();
  });
  it('Ctrl+Shift-drag adds to the selection, and lost pointer capture cancels safely', () => {
    render(<Harness />);
    act(() => useGraphStore.getState().setSelection(['c']));
    const host = screen.getByTestId('canvas');
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, shiftKey: true, ctrlKey: true, clientX: 30, clientY: 20 });
    move(host, 480, 100);
    expect(selection()).toEqual(['c', 'a', 'b']);
    fireEvent.lostPointerCapture(host, { pointerId: 1 });
    expect(selection()).toEqual(['c']);
    expect(useCanvasSelectionStore.getState().marquee).toBeNull();
  });
  it('changes the cursor on Shift alone, and resets on key-up or window blur', () => {
    render(<Harness />);
    const host = screen.getByTestId('canvas');
    fireEvent.keyDown(window, { key: 'Shift' });
    expect(host).toHaveAttribute('data-node-selection-ready');
    fireEvent.keyUp(window, { key: 'Shift' });
    expect(host).not.toHaveAttribute('data-node-selection-ready');
    fireEvent.keyDown(window, { key: 'Shift' });
    fireEvent.blur(window);
    expect(host).not.toHaveAttribute('data-node-selection-ready');
  });
});
