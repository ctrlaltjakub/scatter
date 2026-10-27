import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { DEFAULT_SETTINGS, type ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useNodeBirthStore } from '@/store/useNodeBirthStore';
import { Canvas } from './Canvas';
import type { ComponentProps } from 'react';
import type { NodeView } from './NodeView';

const nodeViews = vi.hoisted(() => new Map<string, ComponentProps<typeof NodeView>>());

const physicsMock = vi.hoisted(() => {
  type Instance = {
    init: ReturnType<typeof vi.fn>;
    addNode: ReturnType<typeof vi.fn>;
    addGraph: ReturnType<typeof vi.fn>;
    addLink: ReturnType<typeof vi.fn>;
    removeNodes: ReturnType<typeof vi.fn>;
    removeLinks: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    setFrozen: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    dragStart: ReturnType<typeof vi.fn>;
    dragMove: ReturnType<typeof vi.fn>;
    dragEnd: ReturnType<typeof vi.fn>;
    dragEndMany: ReturnType<typeof vi.fn>;
    onTick: ReturnType<typeof vi.fn>;
    onFailure: ReturnType<typeof vi.fn>;
    onInput: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
  const instances: Instance[] = [];
  return {
    instances,
    create() {
      const inst: Instance = {
        init: vi.fn(),
        addNode: vi.fn(),
        addGraph: vi.fn(),
        addLink: vi.fn(),
        removeNodes: vi.fn(),
        removeLinks: vi.fn(),
        setSize: vi.fn(),
        setFrozen: vi.fn(),
        setConfig: vi.fn(),
        dragStart: vi.fn(),
        dragMove: vi.fn(),
        dragEnd: vi.fn(),
        dragEndMany: vi.fn(),
        onTick: vi.fn(() => () => {}),
        onFailure: vi.fn(() => () => {}),
        onInput: vi.fn(() => () => {}),
        terminate: vi.fn(),
      };
      instances.push(inst);
      return inst;
    },
    reset() {
      instances.length = 0;
    },
  };
});

vi.mock('@/physics/physicsClient', () => ({
  PhysicsClient: vi.fn(function PhysicsClient() {
    return physicsMock.create();
  }),
}));

vi.mock('./NodeView', () => ({
  NodeView: (props: ComponentProps<typeof NodeView>) => {
    nodeViews.set(props.node.id, props);
    return <div data-testid="canvas-node" data-node-id={props.node.id} />;
  },
}));

vi.mock('./ArrowLayer', () => ({
  ArrowLayer: () => null,
}));

vi.mock('./AsciiAuraLayer', () => ({
  AsciiAuraLayer: () => <div data-testid="canvas-aura-layer" />,
}));

vi.mock('./SearchHighlighter', () => ({
  SearchHighlighter: () => null,
}));

vi.mock('./ReadingHighlighter', () => ({
  ReadingHighlighter: () => null,
}));

vi.mock('./SelectionToolbar', () => ({
  SelectionToolbar: () => null,
}));

vi.mock('./CanvasToolbar', () => ({
  CanvasToolbar: () => null,
}));

vi.mock('./NodeSidePanel', () => ({
  PANEL_W: 288,
  PANEL_GAP: 12,
  NodeSidePanel: () => null,
}));

vi.mock('./NodeCitationsPanel', () => ({
  NodeCitationsPanel: () => null,
  rightPanelFallbackWidth: () => 372,
}));

vi.mock('@/components/dev/PixelRuler', () => ({
  PixelRuler: () => null,
}));

const noop = () => {};

function node(id: string, renderedHeight: number, frozen = false): ScatterNode {
  return {
    id,
    type: id === 'n0' ? 'root' : 'term-click',
    position: { x: 0, y: 0 },
    frozen,
    renderedHeight,
    versions: [{
      header: id,
      body: 'Intro.\n\n- **One**\n  - a: detail',
      createdAt: 0,
      generatedBy: 'root',
      width: 624,
      bodyMaxHeight: renderedHeight - 72,
    }],
    currentVersionIndex: 0,
  };
}

function seedProject(count: number) {
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < count; i++) nodes[`n${i}`] = node(`n${i}`, 300 + i);
  const project = createBlankProject('physics sync', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes });
}

function renderCanvas() {
  return render(
    <Canvas
      sidebarCollapsed
      onOpenSettings={noop}
      onReferenceClick={noop}
      onAskFollowUp={noop}
      onModify={noop}
    />,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().requestPanTo(null);
  physicsMock.reset();
  nodeViews.clear();
  useGraphStore.getState().setProject(null);
  useLivePositionsStore.getState().clear();
  useGraphStore.temporal.getState().clear();
});

afterEach(() => {
  cleanup();
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().setProject(null);
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  useGraphStore.getState().requestPanTo(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Canvas physics sync', () => {
  it('does not move the camera toward a provisional position while placement is pending', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const frame = (time: number) => act(() => {
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
    });
    seedProject(1);
    const { container } = renderCanvas();
    Object.defineProperties(container.querySelector('.canvas-host')!, {
      clientWidth: { value: 1200 }, clientHeight: { value: 800 },
    });
    const before = { ...useLiveViewportStore.getState() };
    act(() => {
      useGraphStore.getState().addNodeWithArrow({ ...node('child', 780), position: { x: 9000, y: 9000 } },
        { id: 'arrow', fromNodeId: 'n0', toNodeId: 'child', kind: 'auto' });
      useGraphStore.getState().requestPanTo('child', 'n0', 'newNodes');
    });
    frame(0); frame(16); frame(1000);
    expect(useLiveViewportStore.getState()).toMatchObject({ x: before.x, y: before.y, zoom: before.zoom });
    act(() => useNodeBirthStore.getState().measure('child', 624, 780));
    frame(1016);
    expect(useLiveViewportStore.getState()).toMatchObject({ x: before.x, y: before.y, zoom: before.zoom });
    act(() => physicsMock.instances[0]!.onTick.mock.calls[0]![0](
      [{ id: 'child', x: 686.5, y: 0 }], {}, [], [{ id: 'child', token: useNodeBirthStore.getState().byNode.child!.token }],
    ));
    frame(1032); frame(1048); frame(1064); frame(2000);
    expect(useLiveViewportStore.getState().x).not.toBe(before.x);
    expect(Math.abs(useLiveViewportStore.getState().x)).toBeLessThan(2000);
    expect(Math.abs(useLiveViewportStore.getState().y)).toBeLessThan(2000);
  });

  it('waits for measurement, batches the card and arrow, then reveals without another undo step', () => {
    seedProject(1);
    renderCanvas();
    const phx = physicsMock.instances[0]!;
    useGraphStore.temporal.getState().clear();
    act(() => useGraphStore.getState().addNodeWithArrow(node('child', 780),
      { id: 'child-arrow', fromNodeId: 'n0', toNodeId: 'child', kind: 'auto' }));
    expect(phx.addGraph).not.toHaveBeenCalled();
    expect(phx.addLink).not.toHaveBeenCalled();
    const token = useNodeBirthStore.getState().byNode.child!.token;
    act(() => useNodeBirthStore.getState().measure('child', 624, 780));
    expect(phx.addGraph).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ id: 'child', width: 624, height: 780, birth: { token, parentId: 'n0', regions: undefined } }),
    ], [expect.objectContaining({ source: 'n0', target: 'child', arrowId: 'child-arrow' })]);
    expect(phx.setSize.mock.calls.filter(call => call[0] === 'child')).toEqual([]);
    expect(useNodeBirthStore.getState().byNode.child!.phase).toBe('placing');
    // This canvas captured rAF support at mount, so drain its queued callback.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const tick = phx.onTick.mock.calls[0]![0];
    act(() => tick([{ id: 'child', x: 686.5, y: -240 }], { 'child-arrow': [{ x: 624, y: 150 }, { x: 686.5, y: 150 }] }, [], [{ id: 'child', token }]));
    act(() => frames.splice(0).forEach(frame => frame(1)));
    expect(useNodeBirthStore.getState().byNode.child!.phase).toBe('entering');
    expect(useGraphStore.getState().project!.nodes.child!.position).toEqual({ x: 686.5, y: -240 });
    expect(useArrowAnchorsStore.getState().anchors['child-arrow']).toHaveLength(2);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });

  it('does not insert a cancelled child or wait forever after a worker failure', () => {
    seedProject(1);
    renderCanvas();
    const phx = physicsMock.instances[0]!;
    act(() => useGraphStore.getState().addNode(node('cancelled', 780)));
    act(() => useGraphStore.temporal.getState().undo());
    act(() => useNodeBirthStore.getState().measure('cancelled', 624, 780));
    expect(phx.addGraph).not.toHaveBeenCalled();
    expect(useNodeBirthStore.getState().byNode.cancelled).toBeUndefined();
    act(() => useGraphStore.getState().addNodeWithArrow(node('child', 780),
      { id: 'child-arrow', fromNodeId: 'n0', toNodeId: 'child', kind: 'auto' }));
    act(() => useNodeBirthStore.getState().measure('child', 624, 780));
    act(() => phx.onFailure.mock.calls[0]![0]());
    expect(useNodeBirthStore.getState().byNode.child!.phase).toBe('entering');
    expect(useGraphStore.getState().project!.nodes.child!.position.x).toBeGreaterThanOrEqual(624);
  });

  it('waits for a newly-created parent even if its child is measured first', () => {
    seedProject(1); renderCanvas();
    const phx = physicsMock.instances[0]!;
    act(() => {
      useGraphStore.getState().addNodeWithArrow(node('parent', 780),
        { id: 'parent-arrow', fromNodeId: 'n0', toNodeId: 'parent', kind: 'auto' });
      useGraphStore.getState().addNodeWithArrow(node('child', 390),
        { id: 'child-arrow', fromNodeId: 'parent', toNodeId: 'child', kind: 'auto' });
      useNodeBirthStore.getState().measure('child', 624, 390);
    });
    expect(phx.addGraph).not.toHaveBeenCalled();
    act(() => useNodeBirthStore.getState().measure('parent', 624, 780));
    expect(phx.addGraph.mock.calls[0]![0].map((n: { id: string }) => n.id)).toEqual(['parent', 'child']);
    expect(phx.addGraph.mock.calls[0]![1]).toHaveLength(2);
  });

  it.each(['interactive-build-log', 'interactive-build-error'])('scrolls an unfocused %s without moving the camera', className => {
    seedProject(1);
    const view = renderCanvas();
    const node = view.getByTestId('canvas-node');
    const build = document.createElement('section'); build.className = 'interactive-build';
    const scrollport = document.createElement('div'); scrollport.className = className;
    build.appendChild(scrollport); node.appendChild(build);
    const viewport = () => { const { x, y, zoom } = useLiveViewportStore.getState(); return { x, y, zoom }; };
    const before = viewport();
    fireEvent.wheel(scrollport, { deltaY: 220 });
    fireEvent.wheel(scrollport, { deltaY: -220 });
    expect(viewport()).toEqual(before);
    expect(useGraphStore.getState().project?.selection).toEqual([]);
    // Explicit camera gestures still work over the log, just like over chat.
    fireEvent.wheel(scrollport, { deltaY: -100, ctrlKey: true });
    expect(viewport().zoom).not.toBe(before.zoom);
  });

  it.each(['pointer', 'wheel', 'keyboard'] as const)('follows initial root generation independently and yields to %s input', input => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const frame = (time: number) => act(() => {
      const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time));
    });
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, generation: false, rootGeneration: true } });
    seedProject(1);
    useGraphStore.getState().updateNode('n0', { generating: true });
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;
    Object.defineProperties(host, { clientWidth: { value: 1200 }, clientHeight: { value: 800 } });
    act(() => useGraphStore.getState().requestPanTo('n0', undefined, 'rootGeneration'));
    frame(0); frame(16); frame(1000);
    expect(useGraphStore.getState().panTo?.automatic).toBe('rootGeneration');
    expect(useLiveViewportStore.getState().zoom).toBeLessThanOrEqual(1);
    // A child stopping propagation still reaches the capture handler.
    const child = host.querySelector('[data-node-id]')!;
    if (input === 'pointer') fireEvent.pointerDown(child, { button: 0 });
    else if (input === 'wheel') fireEvent.wheel(child, { deltaY: 0 });
    else fireEvent.keyDown(child, { key: 'Escape' });
    expect(useGraphStore.getState().panTo).toBeNull();
    const viewport = { ...useGraphStore.getState().project!.viewport };
    frame(2000);
    expect(useGraphStore.getState().project?.viewport).toEqual(viewport);
    // A header click also focuses the node. That may fit once, but must not
    // restart initial-root following through the general generation option.
    act(() => useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } }));
    act(() => nodeViews.get('n0')!.onSelect());
    frame(2016); frame(2032); frame(3000);
    expect(useGraphStore.getState().panTo).toBeNull();
    // A new generation version is not this first-root follow session.
    act(() => {
      const node = useGraphStore.getState().project!.nodes.n0!;
      useGraphStore.getState().updateNode('n0', { versions: [...node.versions, { ...node.versions[0]!, createdAt: 100 }],
        currentVersionIndex: 1, generatingVersionIndex: 1 });
      useGraphStore.getState().requestPanTo('n0', undefined, 'focus');
    });
    frame(3016); frame(3032); frame(4000);
    expect(useGraphStore.getState().panTo?.automatic).toBe('focus');
  });

  it.each([true, false])('keeps node focus functional with automatic focus movement=%s', enabled => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, focus: enabled } });
    seedProject(2);
    renderCanvas();
    act(() => nodeViews.get('n1')!.onSelect());
    expect(useGraphStore.getState().project?.selection).toEqual(['n1']);
    expect(useGraphStore.getState().panTo?.id).toBe(enabled ? 'n1' : undefined);
  });

  it.each([
    [true, false], [false, false], [true, true], [false, true],
  ])('keeps dragging functional with edge movement=%s and multiple selection=%s', (enabled, multiple) => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, dragEdges: enabled } });
    seedProject(2);
    useGraphStore.getState().setSelection(multiple ? ['n0', 'n1'] : ['n1']);
    useGraphStore.temporal.getState().clear();
    const { container } = renderCanvas();
    Object.defineProperties(container.querySelector('.canvas-host')!, {
      clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true },
    });
    const view = nodeViews.get('n1')!;
    const physics = physicsMock.instances[0]!;
    act(() => view.onDragStart(500, 200, 'drag'));
    act(() => view.onDragMove(500, 200, { unpinnedByShake: false }));
    act(() => view.onDragMove(600, 200, { unpinnedByShake: false }));
    const camera = useLiveViewportStore.getState();
    if (enabled) expect(camera.x).toBeLessThan(0);
    else expect(camera.x).toBe(0);
    expect(camera.y).toBe(0);
    expect(physics.dragMove).toHaveBeenLastCalledWith('n1', 600 - camera.x, 200);
    if (multiple) expect(physics.dragMove).toHaveBeenCalledWith('n0', 600 - camera.x, 200);

    // Turning it off mid-drag must preserve compensation for movement that
    // already happened, so neither the node nor camera jumps.
    act(() => useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, dragEdges: false } }));
    act(() => view.onDragMove(610, 200, { unpinnedByShake: false }));
    expect(useLiveViewportStore.getState()).toMatchObject({ x: camera.x, y: camera.y, zoom: camera.zoom });
    expect(physics.dragMove).toHaveBeenLastCalledWith('n1', 610 - camera.x, 200);
    act(() => view.onDragEnd());
    expect(useGraphStore.getState().project?.viewport).toEqual({ x: camera.x, y: camera.y, zoom: camera.zoom });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('never edge-pans during a resize, even when drag-edge movement is enabled', () => {
    seedProject(2);
    const { container } = renderCanvas();
    Object.defineProperties(container.querySelector('.canvas-host')!, {
      clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true },
    });
    const view = nodeViews.get('n1')!;
    act(() => view.onDragStart(500, 200, 'resize'));
    act(() => view.onDragMove(500, 200, { unpinnedByShake: false }));
    act(() => view.onDragMove(600, 200, { unpinnedByShake: false }));
    expect(useLiveViewportStore.getState()).toMatchObject({ x: 0, y: 0, zoom: 1 });
    expect(physicsMock.instances[0]!.dragMove).toHaveBeenLastCalledWith('n1', 600, 200);
    act(() => view.onDragEnd());
  });

  it.each([true, false])('finishes the initial pan and only follows generation when enabled (%s)', enabled => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const frame = (time: number) => act(() => {
      const pending = [...frames.entries()]; frames.clear();
      pending.forEach(([, callback]) => callback(time));
    });
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, generation: enabled } });
    seedProject(1);
    useGraphStore.getState().updateNode('n0', { generating: true });
    const { container } = renderCanvas();
    Object.defineProperties(container.querySelector('.canvas-host')!, {
      clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true },
    });
    act(() => useGraphStore.getState().requestPanTo('n0', undefined, 'newNodes'));
    frame(0); frame(16); frame(1000);
    expect(useGraphStore.getState().panTo !== null).toBe(enabled);
    const { x, y, zoom } = useLiveViewportStore.getState();
    act(() => useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, generation: false } }));
    frame(1016);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useLiveViewportStore.getState()).toMatchObject({ x, y, zoom });
    expect(useGraphStore.getState().project?.viewport).toEqual({ x, y, zoom });
  });

  it('reinitializes routes and frozen positions when sync replaces the same project', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    seedProject(2);
    useGraphStore.getState().updateNode('n1', { frozen: true });
    useGraphStore.getState().addArrow({ id: 'a', fromNodeId: 'n0', toNodeId: 'n1', kind: 'auto', gravitates: true });
    renderCanvas();
    const before = physicsMock.instances[0]!;
    const oldTick = before.onTick.mock.calls[0]![0];
    const old = useGraphStore.getState().project!;
    const anchors = [{ x: 624, y: 150 }, { x: 1500, y: 250 }];
    act(() => useGraphStore.getState().setProject({ ...old,
      nodes: { ...old.nodes, n1: { ...old.nodes.n1!, position: { x: 1500, y: 100 } } },
      arrows: { a: { ...old.arrows.a!, anchors } },
    }, { resetRuntime: true }));
    expect(before.terminate).toHaveBeenCalledOnce();
    expect(physicsMock.instances).toHaveLength(2);
    const after = physicsMock.instances[1]!;
    expect(after.init).toHaveBeenCalledWith(
      expect.arrayContaining([{ id: 'n1', x: 1500, y: 100, frozen: true }]),
      expect.arrayContaining([expect.objectContaining({ arrowId: 'a', anchors: expect.arrayContaining(anchors) })]),
      expect.any(Object),
    );
    expect(useLivePositionsStore.getState().positions.n1).toEqual({ x: 1500, y: 100 });
    expect(useArrowAnchorsStore.getState().anchors.a).toEqual(expect.arrayContaining(anchors));
    act(() => oldTick([{ id: 'n1', x: 0, y: 0 }], { a: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, []));
    expect(useLivePositionsStore.getState().positions.n1).toEqual({ x: 1500, y: 100 });
    expect(useArrowAnchorsStore.getState().anchors.a).toEqual(expect.arrayContaining(anchors));
    act(() => useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true }));
    expect(physicsMock.instances).toHaveLength(2);
  });

  it('rejects a queued old-snapshot tick even before React cleans up its worker', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    seedProject(1);
    renderCanvas();
    const tick = physicsMock.instances[0]!.onTick.mock.calls[0]![0];
    act(() => tick([{ id: 'n0', x: 999, y: 999 }], { old: [{ x: 9, y: 9 }] }, []));
    act(() => {
      useGraphStore.getState().setProject(useGraphStore.getState().project!, { resetRuntime: true });
      for (const frame of frames.splice(0)) frame(1);
    });
    expect(useLivePositionsStore.getState().positions.n0).toEqual({ x: 0, y: 0 });
    expect(useArrowAnchorsStore.getState().anchors.old).toBeUndefined();
  });

  it('drags every selected node by the same delta and commits movement without an undo step', async () => {
    seedProject(3);
    useGraphStore.getState().setSelection(['n1', 'n2']);
    useGraphStore.getState().updateNode('n2', { frozen: true });
    renderCanvas();
    await act(async () => {});
    const phx = physicsMock.instances[0]!;
    useLivePositionsStore.getState().setPositions([{ id: 'n1', x: 100, y: 200 }, { id: 'n2', x: 800, y: 350 }]);
    useGraphStore.temporal.getState().clear();
    act(() => nodeViews.get('n1')!.onDragStart(100, 200, 'drag'));
    expect(phx.dragStart.mock.calls).toEqual([['n1', 100, 200], ['n2', 800, 350]]);
    act(() => nodeViews.get('n1')!.onDragMove(140, 250, { unpinnedByShake: false }));
    expect(phx.dragMove.mock.calls).toEqual([['n1', 140, 250], ['n2', 840, 400]]);
    useLivePositionsStore.getState().setPositions([{ id: 'n1', x: 140, y: 250 }, { id: 'n2', x: 840, y: 400 }]);
    act(() => nodeViews.get('n1')!.onDragEnd());
    expect(phx.dragEndMany).toHaveBeenCalledExactlyOnceWith(['n1', 'n2']);
    const project = useGraphStore.getState().project!;
    expect(project.nodes.n1!.position).toEqual({ x: 140, y: 250 });
    expect(project.nodes.n2!.position).toEqual({ x: 840, y: 400 });
    expect(project.nodes.n0!.position).toEqual({ x: 0, y: 0 });
    expect(project.nodes.n2!.frozen).toBe(true);
    expect(project.selection).toEqual(['n1', 'n2']);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('keeps group dragging after clicking one of the selected group’s members', async () => {
    seedProject(3);
    const graph = useGraphStore.getState();
    const groupId = graph.createGroup('Related');
    graph.assignNodesToGroup(['n1', 'n2'], groupId);
    graph.selectGroup(groupId);
    renderCanvas();
    await act(async () => {});
    act(() => nodeViews.get('n1')!.onSelect());
    expect(useGraphStore.getState().selectedGroupId).toBe(groupId);
    expect(useGraphStore.getState().project?.selection).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().panTo).toBeNull();
    const phx = physicsMock.instances[0]!;
    act(() => nodeViews.get('n1')!.onDragStart(0, 0, 'drag'));
    expect(phx.dragStart.mock.calls).toEqual([['n1', 0, 0], ['n2', 0, 0]]);
    act(() => nodeViews.get('n1')!.onDragEnd());
    expect(phx.dragEndMany).toHaveBeenCalledExactlyOnceWith(['n1', 'n2']);
  });

  it('keeps a manual multi-selection when clicking a selected member', () => {
    seedProject(3);
    useGraphStore.getState().setSelection(['n1', 'n2']);
    renderCanvas();
    act(() => nodeViews.get('n1')!.onSelect());
    expect(useGraphStore.getState().project?.selection).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().panTo).toBeNull();
    act(() => nodeViews.get('n0')!.onSelect());
    expect(useGraphStore.getState().project?.selection).toEqual(['n0']);
  });

  it('uses batch presentation for one-node groups and clears it on explicit focus', () => {
    seedProject(2);
    const graph = useGraphStore.getState();
    const groupId = graph.createGroup('Solo');
    graph.assignNodeToGroup('n1', groupId);
    graph.selectGroup(groupId);
    const { container } = renderCanvas();
    expect(container.querySelector('.canvas-host')).toHaveAttribute('data-node-multiselect');
    expect(nodeViews.get('n1')?.multiSelected).toBe(true);
    act(() => graph.requestFitNode('n1'));
    expect(container.querySelector('.canvas-host')).not.toHaveAttribute('data-node-multiselect');
    expect(nodeViews.get('n1')?.multiSelected).toBe(false);
  });

  it('keeps resizing and unselected-node dragging independent of a multi-selection', async () => {
    seedProject(3);
    useGraphStore.getState().setSelection(['n1', 'n2']);
    renderCanvas();
    await act(async () => {});
    const phx = physicsMock.instances[0]!;
    act(() => nodeViews.get('n1')!.onDragStart(0, 0, 'resize'));
    expect(phx.dragStart).toHaveBeenCalledExactlyOnceWith('n1', 0, 0);
    act(() => nodeViews.get('n1')!.onDragEnd());
    phx.dragStart.mockClear();
    act(() => nodeViews.get('n0')!.onDragStart(0, 0, 'drag'));
    expect(phx.dragStart).toHaveBeenCalledExactlyOnceWith('n0', 0, 0);
    act(() => nodeViews.get('n0')!.onDragEnd());
  });
  it('updates a surviving arrow in physics on promotion and when promotion is undone', async () => {
    seedProject(2);
    const graph = useGraphStore.getState();
    graph.addArrow({ id: 'reference', fromNodeId: 'n0', toNodeId: 'n1', kind: 'dotted', gravitates: false });
    renderCanvas();
    await act(async () => {});
    const phx = physicsMock.instances[0]!;
    for (const kind of ['auto', 'dotted'] as const) {
      phx.addLink.mockClear(); phx.removeLinks.mockClear();
      act(() => {
        const project = useGraphStore.getState().project!;
        useGraphStore.setState({ project: { ...project, arrows: { reference: { ...project.arrows.reference!, kind } } } });
      });
      expect(phx.removeLinks).toHaveBeenCalledExactlyOnceWith(['reference']);
      expect(phx.addLink).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ arrowId: 'reference', kind }));
    }
    phx.addLink.mockClear(); phx.removeLinks.mockClear();
    act(() => { useGraphStore.getState().setSelection(['n1']); });
    expect(phx.addLink).not.toHaveBeenCalled();
    expect(phx.removeLinks).not.toHaveBeenCalled();
  });
  it('mounts startup nodes during browser idle time before reporting ready', () => {
    const idleCallbacks: IdleRequestCallback[] = [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestIdleCallback', vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    }));
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    seedProject(3);
    const ready = vi.fn();
    const view = render(
      <Canvas
        progressiveStartup
        onStartupReady={ready}
        sidebarCollapsed
        onOpenSettings={noop}
        onReferenceClick={noop}
        onAskFollowUp={noop}
        onModify={noop}
      />,
    );

    expect(view.queryAllByTestId('canvas-node')).toHaveLength(1);
    act(() => { idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 }); });
    expect(view.queryAllByTestId('canvas-node')).toHaveLength(2);
    act(() => { idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 8 }); });
    expect(view.queryAllByTestId('canvas-node')).toHaveLength(3);
    expect(ready).not.toHaveBeenCalled();
    act(() => { frames.shift()?.(48); });
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('does not run the graph aura renderer underneath the restoration overlay', () => {
    seedProject(1);
    const view = render(
      <Canvas
        suppressAuraLayer
        sidebarCollapsed
        onOpenSettings={noop}
        onReferenceClick={noop}
        onAskFollowUp={noop}
        onModify={noop}
      />,
    );

    expect(view.queryByTestId('canvas-aura-layer')).toBeNull();
  });

  it('does not sync all nodes to physics for a bulletsCollapsed-only project update', async () => {
    seedProject(29);
    renderCanvas();
    await act(async () => {});
    const phx = physicsMock.instances[0]!;
    phx.setSize.mockClear();
    phx.setFrozen.mockClear();

    act(() => {
      useGraphStore.getState().updateNode('n10', { bulletsCollapsed: true });
    });

    expect(phx.setSize).not.toHaveBeenCalled();
    expect(phx.setFrozen).not.toHaveBeenCalled();
  });

  it('syncs only the changed node size after a collapse renderedHeight update', async () => {
    seedProject(29);
    renderCanvas();
    await act(async () => {});
    const phx = physicsMock.instances[0]!;
    phx.setSize.mockClear();
    phx.setFrozen.mockClear();

    act(() => {
      useGraphStore.getState().updateNode('n10', {
        bulletsCollapsed: true,
        renderedHeight: 180,
      });
    });

    expect(phx.setFrozen).not.toHaveBeenCalled();
    expect(phx.setSize).toHaveBeenCalledTimes(1);
    // A pure shrink must WAKE the simulation ('normal', delta-scaled kick):
    // the arrow reroute marked by set-size only executes during ticks, and
    // neighbors need the kick to fill the vacuum. wake:'none' here left
    // arrows pointing at the old taller rect and the graph frozen around
    // the shrunken node.
    expect(phx.setSize).toHaveBeenCalledWith('n10', 624, 180, { wake: 'normal' });
  });

  it('ignores a translated physics tick from a copied project after returning to the source', async () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    const sharedSourceNode = {
      ...node('shared', 300),
      position: { x: 613, y: -74 },
    };
    const source = {
      ...createBlankProject('Source', 'shared'),
      id: 'source',
      nodes: { shared: sharedSourceNode },
    };
    const copied = {
      ...createBlankProject('Copied branch', 'shared'),
      id: 'copied',
      nodes: {
        shared: {
          ...structuredClone(sharedSourceNode),
          position: { x: 0, y: 0 },
        },
      },
    };

    useGraphStore.getState().setProject(source);
    renderCanvas();
    await act(async () => {});

    act(() => { useGraphStore.getState().setProject(copied); });
    await act(async () => {});
    const copiedPhysics = physicsMock.instances.at(-1)!;
    const copiedTick = copiedPhysics.onTick.mock.calls[0]![0] as (
      positions: Array<{ id: string; x: number; y: number }>,
      anchors: Record<string, { x: number; y: number }[]>,
    ) => void;

    act(() => { useGraphStore.getState().setProject(source); });
    await act(async () => {});
    expect(useLivePositionsStore.getState().positions.shared).toEqual({ x: 613, y: -74 });

    // This queued message belongs to the copied project's worker. Its node ID
    // is valid in the source too, but its translated coordinates are not.
    act(() => { copiedTick([{ id: 'shared', x: 0, y: 0 }], {}); });
    expect(useLivePositionsStore.getState().positions.shared).toEqual({ x: 613, y: -74 });
  });
});
