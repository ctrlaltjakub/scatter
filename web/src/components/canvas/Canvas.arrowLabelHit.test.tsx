import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DEFAULT_SETTINGS, type ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useArrowLabelStore } from '@/store/useArrowLabelStore';
import { useGroupLabelStore } from '@/store/useGroupLabelStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { Canvas } from './Canvas';

vi.mock('@/physics/physicsClient', () => ({
  PhysicsClient: vi.fn(function PhysicsClient() {
    return {
      init: vi.fn(), addNode: vi.fn(), addGraph: vi.fn(), addLink: vi.fn(), removeNodes: vi.fn(), onFailure: vi.fn(() => () => {}),
      setSize: vi.fn(), setFrozen: vi.fn(), setConfig: vi.fn(),
      dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
      onTick: vi.fn(() => () => {}), onInput: vi.fn(() => () => {}), terminate: vi.fn(),
    };
  }),
}));
vi.mock('./NodeView', () => ({ NodeView: () => <div className="chat-scroll" /> }));
vi.mock('./ArrowLayer', () => ({ ArrowLayer: () => null }));
vi.mock('./AsciiAuraLayer', () => ({ AsciiAuraLayer: () => null }));
vi.mock('./SearchHighlighter', () => ({ SearchHighlighter: () => null }));
vi.mock('./ReadingHighlighter', () => ({ ReadingHighlighter: () => null }));
vi.mock('./SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('./CanvasToolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('./NodeSidePanel', () => ({
  PANEL_W: 288,
  PANEL_GAP: 12,
  NodeSidePanel: () => (
    <div className="side-panel">
      <div className="group-popover-existing" data-testid="group-scroll-list" />
    </div>
  ),
}));
vi.mock('./NodeCitationsPanel', () => ({ NodeCitationsPanel: () => null }));
vi.mock('@/components/dev/PixelRuler', () => ({ PixelRuler: () => null }));

const noop = () => {};

function node(id: string, groupId?: string): ScatterNode {
  return {
    id,
    type: id === 'parent' ? 'root' : 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    renderedHeight: 200,
    versions: [{ header: id, body: 'Body.', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
    ...(groupId ? { groupId } : {}),
  };
}

function seed() {
  const project = createBlankProject('labels', 'parent');
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().setProject({
    ...project,
    nodes: { parent: node('parent'), child: node('child') },
    selection: ['parent'],
  });
  useGraphStore.getState().requestPanTo(null);
  useArrowLabelStore.setState({
    entries: {
      arrow: {
        text: 'CHILD',
        targetNodeId: 'child',
        hitRect: { x: 10, y: 20, w: 50, h: 18 },
        startedAt: 0,
        clearedAt: null,
        cells: [{ col: 1, row: 1, glyphIndex: 1, worldX: 0, worldY: 0 }],
        accents: [null],
      },
    },
  });
}

function seedGroupLabel() {
  const project = createBlankProject('group labels', 'parent');
  const groupId = 'group-a';
  const nextProject = {
    ...project,
    viewport: { x: 0, y: 0, zoom: 0.34 },
    groups: {
      [groupId]: { id: groupId, name: 'Ideas', color: '#89b4fa', gravitate: false },
    },
    nodes: {
      parent: node('parent', groupId),
      child: node('child', groupId),
      distant: node('distant', groupId),
    },
    selection: ['parent'],
  };
  useGraphStore.getState().selectGroup(null);
  useGraphStore.setState({ lastInteractedGroupIds: {} });
  useGraphStore.getState().setProject(nextProject);
  useGraphStore.getState().requestPanTo(null);
  useGroupLabelStore.setState({
    entries: {
      cluster: {
        text: 'IDEAS',
        groupId,
        target: { kind: 'group', groupId },
        colorSourceNodeId: 'parent',
        rect: { x: 80, y: 20, w: 80, h: 18 },
        startedAt: 0,
        clearedAt: null,
        cells: [{ col: 1, row: 1, glyphIndex: 1, worldX: 0, worldY: 0 }],
      },
    },
  });
  return { project: nextProject, groupId };
}

function seedUngroupedLabel() {
  const project = createBlankProject('Project family', 'parent');
  const groupId = 'group-a';
  const nextProject = {
    ...project,
    viewport: { x: 0, y: 0, zoom: 0.34 },
    groups: {
      [groupId]: { id: groupId, name: 'Ideas', color: '#89b4fa', gravitate: false },
    },
    nodes: {
      parent: node('parent'),
      child: node('child'),
      distant: node('distant'),
      grouped: node('grouped', groupId),
    },
    selection: ['parent'],
  };
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().setProject(nextProject);
  useGraphStore.getState().requestPanTo(null);
  useGroupLabelStore.setState({
    entries: {
      cluster: {
        text: 'PROJECT FAMILY',
        groupId: '\u0000project:project:ungrouped',
        target: { kind: 'ungrouped' },
        colorSourceNodeId: 'parent',
        rect: { x: 80, y: 20, w: 120, h: 18 },
        startedAt: 0,
        clearedAt: null,
        cells: [{ col: 1, row: 1, glyphIndex: 1, worldX: 0, worldY: 0 }],
      },
    },
  });
  return nextProject;
}

function renderCanvas() {
  return render(
    <Canvas sidebarCollapsed onOpenSettings={noop} onReferenceClick={noop}
      onAskFollowUp={noop} onModify={noop} />,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  seed();
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().setProject(null);
  useArrowLabelStore.setState({ entries: {} });
  useGroupLabelStore.setState({ entries: {} });
});

describe('Canvas ASCII arrow-label interaction', () => {
  it.each(['ctrlKey', 'metaKey'] as const)('zooms in and out over chat content with %s without browser zoom', (modifier) => {
    const { container } = renderCanvas();
    const chat = container.querySelector('.chat-scroll')!;
    const before = useLiveViewportStore.getState().zoom;
    expect(fireEvent.wheel(chat, { clientX: 100, clientY: 100, deltaY: -20, [modifier]: true, cancelable: true })).toBe(false);
    const zoomedIn = useLiveViewportStore.getState().zoom;
    expect(zoomedIn).toBeGreaterThan(before);
    expect(fireEvent.wheel(chat, { clientX: 100, clientY: 100, deltaY: 20, [modifier]: true, cancelable: true })).toBe(false);
    const zoomedOut = useLiveViewportStore.getState().zoom;
    expect(zoomedOut).toBeLessThan(zoomedIn);
    fireEvent.wheel(chat, { deltaY: 100 });
    expect(useLiveViewportStore.getState().zoom).toBe(zoomedOut);
  });

  it('does not zoom the canvas when the Group list receives a wheel event', () => {
    const { container } = renderCanvas();
    const list = container.querySelector('[data-testid="group-scroll-list"]')!;
    const before = useLiveViewportStore.getState().zoom;

    fireEvent.wheel(list, { clientX: 100, clientY: 100, deltaY: 100 });

    expect(useLiveViewportStore.getState().zoom).toBe(before);
  });

  it('navigates to a clicked label without treating it as an empty-canvas click', () => {
    useSettingsStore.setState({ cameraAutoPan: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.cameraAutoPan)
      .map(key => [key, false])) as typeof DEFAULT_SETTINGS.cameraAutoPan });
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;

    fireEvent.pointerDown(host, { pointerId: 1, button: 0, clientX: 35, clientY: 29 });
    fireEvent.pointerUp(host, { pointerId: 1, button: 0, clientX: 35, clientY: 29 });

    expect(useGraphStore.getState().project!.selection).toEqual(['child']);
    expect(useGraphStore.getState().panTo?.id).toBe('child');
  });

  it('cancels label navigation without panning when the press moves over four pixels', () => {
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;
    const before = useLiveViewportStore.getState();

    fireEvent.pointerDown(host, { pointerId: 1, button: 0, clientX: 35, clientY: 29 });
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 45, clientY: 29 });
    fireEvent.pointerUp(host, { pointerId: 1, button: 0, clientX: 45, clientY: 29 });

    expect(useGraphStore.getState().project!.selection).toEqual(['parent']);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useLiveViewportStore.getState().x).toBe(before.x);
    expect(useLiveViewportStore.getState().y).toBe(before.y);
  });

  it('shows the clickable cursor only while hovering a visible label box', () => {
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;

    fireEvent.pointerMove(host, { clientX: 35, clientY: 29 });
    expect(host).toHaveClass('ascii-label-hover');

    fireEvent.pointerMove(host, { clientX: 100, clientY: 100 });
    expect(host).not.toHaveClass('ascii-label-hover');
  });

  it.each([true, false])('selects the whole group with group-label framing=%s', enabled => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, groups: enabled } });
    const { project, groupId } = seedGroupLabel();
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;

    fireEvent.pointerMove(host, { clientX: 110, clientY: 29 });
    expect(host).toHaveClass('ascii-label-hover');
    fireEvent.pointerDown(host, { pointerId: 2, button: 0, clientX: 110, clientY: 29 });
    fireEvent.pointerUp(host, { pointerId: 2, button: 0, clientX: 110, clientY: 29 });
    fireEvent.click(host, { clientX: 110, clientY: 29 });

    const state = useGraphStore.getState();
    expect(state.selectedGroupId).toBe(groupId);
    expect(state.project!.selection).toEqual(['parent', 'child', 'distant']);
    if (enabled) expect(state.panTo).toMatchObject({
      kind: 'nodes',
      ids: expect.arrayContaining(['parent', 'child', 'distant']),
      automatic: 'groups',
    });
    else expect(state.panTo).toBeNull();
    expect(state.lastInteractedGroupIds[project.id]).toBe(groupId);
  });

  it('cancels group-label navigation when the press becomes a drag', () => {
    seedGroupLabel();
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;

    fireEvent.pointerDown(host, { pointerId: 2, button: 0, clientX: 110, clientY: 29 });
    fireEvent.pointerMove(host, { pointerId: 2, clientX: 120, clientY: 29 });
    fireEvent.pointerUp(host, { pointerId: 2, button: 0, clientX: 120, clientY: 29 });

    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    expect(useGraphStore.getState().project!.selection).toEqual(['parent']);
    expect(useGraphStore.getState().panTo).toBeNull();
  });

  it.each([true, false])('respects group framing=%s for the ungrouped project-family label', enabled => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, groups: enabled } });
    seedUngroupedLabel();
    const { container } = renderCanvas();
    const host = container.querySelector('.canvas-host')!;

    fireEvent.pointerDown(host, { pointerId: 3, button: 0, clientX: 110, clientY: 29 });
    fireEvent.pointerUp(host, { pointerId: 3, button: 0, clientX: 110, clientY: 29 });

    const state = useGraphStore.getState();
    expect(state.selectedGroupId).toBeNull();
    expect(state.project!.selection).toEqual([]);
    if (enabled) expect(state.panTo).toMatchObject({
      kind: 'nodes',
      ids: expect.arrayContaining(['parent', 'child', 'distant']),
      automatic: 'groups',
    });
    else expect(state.panTo).toBeNull();
    expect(state.panTo?.ids ?? []).not.toContain('grouped');
  });
});
