import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from './useGraphStore';
import { useHistoryMetaStore } from './useHistoryMetaStore';
import type { FactCheckState, NodeVersion, ScatterNode } from './types';

function version(
  header: string,
  createdAt: number,
  patch: Partial<NodeVersion> = {},
): NodeVersion {
  return {
    header,
    body: `${header} body`,
    createdAt,
    generatedBy: 'manual',
    ...patch,
  };
}

function node(
  id: string,
  versions: NodeVersion[] = [version(id, 1)],
): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions,
    currentVersionIndex: versions.length - 1,
  };
}

beforeEach(() => {
  const project = createBlankProject('History', 'root', () => 0.2);
  project.nodes.root = node('root');
  useGraphStore.setState({
    project,
    projectList: [],
    activeProjectId: project.id,
    selectedGroupId: null,
  });
  useGraphStore.temporal.getState().clear();
});

describe('semantic graph history', () => {
  it('ignores navigation, layout, ordering, and auxiliary-analysis writes', () => {
    const graph = useGraphStore.getState();
    graph.setSelection(['root']);
    graph.setViewport({ x: 240, y: -80, zoom: 0.45 });
    graph.updateNode('root', {
      position: { x: 50, y: 60 },
      currentVersionIndex: 0,
      bulletsCollapsed: true,
      activeBulletIdx: 2,
      chunkIntro: true,
      renderedHeight: 410,
    });
    graph.setVersionSize('root', {
      width: 520,
      bodyMaxHeight: 360,
      freeTextHeight: 90,
    });

    const first = graph.createGroup('First');
    const second = graph.createGroup('Second');
    useGraphStore.temporal.getState().clear();
    graph.reorderGroup(first, second);

    const current = useGraphStore.getState().project!.nodes.root!;
    const factCheck: FactCheckState = {
      pending: {
        schemaVersion: 1,
        bodyFingerprint: 'body',
        versionCreatedAt: 1,
        providerId: 'provider',
        model: 'model',
        startedAt: 1,
        complete: false,
        units: [],
        failedUnitIds: [],
      },
    };
    graph.updateNode('root', {
      versions: [{ ...current.versions[0]!, factCheck }],
    });

    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useHistoryMetaStore.getState().past).toHaveLength(0);
  });

  it('records content, group membership, pinning, and deletion with names', () => {
    const graph = useGraphStore.getState();
    graph.addNode(node('member'));
    useGraphStore.temporal.getState().clear();

    graph.updateNode('root', {
      versions: [...graph.project!.nodes.root!.versions, version('Edited', 2)],
      currentVersionIndex: 1,
    });
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Save text edit');

    const groupId = graph.createGroup('Research');
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Create group');

    graph.assignNodeToGroup('member', groupId);
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Change group membership');

    graph.updateNode('root', { frozen: true });
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Pin node');

    graph.addNode(node('child'));
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Explore term');

    graph.deleteNodeCascade('child');
    expect(useHistoryMetaStore.getState().past.at(-1)?.label).toBe('Delete node');
  });

  it('undoes content without moving or resizing the current canvas', () => {
    const graph = useGraphStore.getState();
    const original = graph.project!.nodes.root!;
    graph.updateNode('root', {
      versions: [...original.versions, version('Generated', 2, { width: 600 })],
      currentVersionIndex: 1,
    });

    graph.updateNode('root', {
      position: { x: 333, y: 444 },
      bulletsCollapsed: true,
      currentVersionIndex: 0,
    });
    graph.setVersionSize('root', { width: 480, bodyMaxHeight: 320 });
    graph.setViewport({ x: -90, y: 120, zoom: 0.6 });
    graph.setSelection(['root']);

    useGraphStore.temporal.getState().undo();
    const restoredProject = useGraphStore.getState().project!;
    const restored = restoredProject.nodes.root!;
    expect(restored.versions).toHaveLength(1);
    expect(restored.position).toEqual({ x: 333, y: 444 });
    expect(restored.bulletsCollapsed).toBe(true);
    expect(restored.versions[0]!.width).toBe(480);
    expect(restored.versions[0]!.bodyMaxHeight).toBe(320);
    expect(restoredProject.viewport).toEqual({ x: -90, y: 120, zoom: 0.6 });
    expect(restoredProject.selection).toEqual(['root']);
  });

  it('restores a deleted version as the viewed version and redo removes it again', () => {
    const graph = useGraphStore.getState();
    graph.updateNode('root', {
      versions: [version('One', 1), version('Two', 2), version('Three', 3)],
      currentVersionIndex: 1,
    });
    useGraphStore.temporal.getState().clear();

    graph.updateNode('root', {
      versions: [version('One', 1), version('Three', 3)],
      currentVersionIndex: 0,
    });
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes.root!.versions.map((item) => item.header))
      .toEqual(['One', 'Two', 'Three']);
    expect(useGraphStore.getState().project!.nodes.root!.currentVersionIndex).toBe(1);

    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project!.nodes.root!.versions.map((item) => item.header))
      .toEqual(['One', 'Three']);
    expect(useGraphStore.getState().project!.nodes.root!.currentVersionIndex).toBe(0);
  });

  it('preserves a later group reorder while undoing an earlier rename', () => {
    const graph = useGraphStore.getState();
    const first = graph.createGroup('First');
    const second = graph.createGroup('Second');
    const third = graph.createGroup('Third');
    useGraphStore.temporal.getState().clear();

    graph.renameGroup(first, 'Renamed');
    graph.reorderGroup(first, third);
    const reordered = Object.keys(useGraphStore.getState().project!.groups);

    useGraphStore.temporal.getState().undo();
    const restored = useGraphStore.getState().project!;
    expect(restored.groups[first]!.name).toBe('First');
    expect(Object.keys(restored.groups)).toEqual(reordered);
    expect(restored.groups[second]).toBeDefined();
  });

  it('restores a deleted group and its memberships without reordering survivors', () => {
    const graph = useGraphStore.getState();
    graph.addNode(node('member'));
    const first = graph.createGroup('First');
    const second = graph.createGroup('Second');
    const third = graph.createGroup('Third');
    graph.assignNodeToGroup('member', second);
    useGraphStore.temporal.getState().clear();

    graph.deleteGroup(second);
    graph.reorderGroup(first, third);
    const survivorOrder = Object.keys(useGraphStore.getState().project!.groups);

    useGraphStore.temporal.getState().undo();
    const restored = useGraphStore.getState().project!;
    expect(restored.groups[second]!.name).toBe('Second');
    expect(restored.nodes.member!.groupId).toBe(second);
    expect(Object.keys(restored.groups).filter((id) => id !== second)).toEqual(survivorOrder);
  });

  it('does not record switching the version being viewed', () => {
    const graph = useGraphStore.getState();
    graph.updateNode('root', {
      versions: [version('One', 1), version('Two', 2)],
      currentVersionIndex: 1,
    });
    useGraphStore.temporal.getState().clear();

    graph.updateNode('root', { currentVersionIndex: 0 });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useHistoryMetaStore.getState().past).toHaveLength(0);
  });

  it('undoes pinning while keeping movement that happened afterward', () => {
    const graph = useGraphStore.getState();
    graph.updateNode('root', { frozen: true });
    graph.updateNode('root', { position: { x: 800, y: -200 } });

    useGraphStore.temporal.getState().undo();
    const restored = useGraphStore.getState().project!.nodes.root!;
    expect(restored.frozen).toBe(false);
    expect(restored.position).toEqual({ x: 800, y: -200 });
  });

  it('does not rewind an unrelated generation that streamed after the snapshot', () => {
    const graph = useGraphStore.getState();
    graph.updateNode('root', {
      versions: [version('Source', 1), version('Draft', 2, { body: 'partial' })],
      currentVersionIndex: 1,
      generating: true,
      generatingVersionIndex: 1,
      streamingText: true,
    });
    const groupId = graph.createGroup('Original');
    useGraphStore.temporal.getState().clear();

    graph.renameGroup(groupId, 'Changed');
    useGraphStore.temporal.getState().pause();
    try {
      const current = useGraphStore.getState().project!.nodes.root!;
      graph.updateNode('root', {
        versions: [
          current.versions[0]!,
          { ...current.versions[1]!, body: 'latest streamed text' },
        ],
      });
    } finally {
      useGraphStore.temporal.getState().resume();
    }

    useGraphStore.temporal.getState().undo();
    const restored = useGraphStore.getState().project!;
    expect(restored.groups[groupId]!.name).toBe('Original');
    expect(restored.nodes.root!.versions[1]!.body).toBe('latest streamed text');
    expect(restored.nodes.root!.generating).toBe(true);
  });
});
