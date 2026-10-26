import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NodeVersion,
  Project,
  ScatterNode,
} from './types';
import type { RuntimePersistenceOverlay } from '@/opfs/projectPersistenceProtocol';

const io = vi.hoisted(() => ({
  patchProjectFile: vi.fn(),
  flushProjectFileMirror: vi.fn(),
  saveProjectFile: vi.fn(),
  evictProjectFileMirror: vi.fn(),
}));

vi.mock('@/opfs/projectsIO', () => io);

import {
  adoptProjectPersistenceMirror,
  buildProjectFilePatch,
  flushProjectPersistence,
  resetProjectPersistenceForTests,
  scheduleProjectAutosave,
} from './projectPersistence';
import { applyProjectFilePatch } from '@/opfs/projectPersistenceApply';
import { useActiveIdxStore } from './useActiveIdxStore';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { useLiveViewportStore } from './useLiveViewportStore';

function version(patch: Partial<NodeVersion> = {}): NodeVersion {
  return {
    header: 'Header',
    body: 'Body',
    createdAt: 1,
    generatedBy: 'manual',
    ...patch,
  };
}

function node(id: string, ver = version()): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 10, y: 20 },
    frozen: false,
    versions: [ver],
    currentVersionIndex: 0,
  };
}

function project(n: ScatterNode = node('n1')): Project {
  return {
    id: 'p1',
    name: 'Project',
    createdAt: 1,
    updatedAt: 2,
    rootNodeId: 'n1',
    nodes: { [n.id]: n },
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
  };
}

function runtime(p: Project): RuntimePersistenceOverlay {
  return {
    positions: Object.fromEntries(
      Object.entries(p.nodes).map(([id, item]) => [id, item.position]),
    ),
    anchors: {},
    activeBulletIdx: {},
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  await resetProjectPersistenceForTests();
  vi.clearAllMocks();
  io.patchProjectFile.mockResolvedValue(true);
  io.flushProjectFileMirror.mockResolvedValue(true);
  io.saveProjectFile.mockResolvedValue(undefined);
  io.evictProjectFileMirror.mockResolvedValue(undefined);
  useLivePositionsStore.setState({ positions: {} });
  useArrowAnchorsStore.setState({ anchors: {} });
  useActiveIdxStore.setState({ byNodeId: {} });
  useLiveViewportStore.getState().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('incremental project persistence', () => {
  it('flushes the live camera even before the gesture commits to the project', async () => {
    const before = project();
    adoptProjectPersistenceMirror(before);
    useLiveViewportStore.getState().setViewport({ x: 151, y: -840, zoom: 0.15 });
    await flushProjectPersistence(before);
    const patch = io.patchProjectFile.mock.calls[0]![1];
    expect(applyProjectFilePatch(before, patch)).toMatchObject({
      viewport: { x: 151, y: -840, zoom: 0.15 }, viewportUpdatedAt: Date.now(),
    });
    expect(before.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });
  it('sends only changed fields from an existing large version', () => {
    const marker = `large-interactive-${'x'.repeat(500_000)}`;
    const before = project(node('n1', version({
      interactive: {
        html: marker,
        request: 'request',
        providerId: 'openrouter',
        model: 'model',
      },
    })));
    const beforeNode = before.nodes.n1!;
    const beforeVersion = beforeNode.versions[0]!;
    const after = {
      ...before,
      updatedAt: 3,
      nodes: {
        n1: {
          ...beforeNode,
          versions: [{ ...beforeVersion, body: 'New body', width: 620 }],
        },
      },
    };

    const patch = buildProjectFilePatch(before, after, runtime(before), runtime(after), 1);
    expect(Object.keys(patch.nodes.update)).toEqual(['n1']);
    expect(patch.nodes.update.n1!.versions!.update['0']!.set).toEqual({
      body: 'New body',
      width: 620,
    });
    expect(JSON.stringify(patch)).not.toContain('large-interactive-');
    expect(applyProjectFilePatch(before, patch)).toEqual(after);
  });

  it('applies entity additions, removals, positions, anchors, and cleared reading state', () => {
    const beforeNode = { ...node('n1'), activeBulletIdx: 2 };
    const before: Project = {
      ...project(beforeNode),
      arrows: {
        a1: {
          id: 'a1',
          fromNodeId: 'n1',
          toNodeId: 'n2',
          kind: 'auto',
          anchors: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        },
      },
      groups: {
        g1: { id: 'g1', name: 'Old', color: '#fff', gravitate: false },
      },
    };
    const after: Project = {
      ...before,
      updatedAt: 4,
      nodes: { n2: node('n2') },
      arrows: {},
      groups: {
        g2: { id: 'g2', name: 'New', color: '#000', gravitate: false },
      },
    };
    const nextRuntime: RuntimePersistenceOverlay = {
      positions: { n2: { x: 50, y: 60 } },
      anchors: {},
      activeBulletIdx: {},
    };
    const patch = buildProjectFilePatch(before, after, {
      positions: { n1: beforeNode.position },
      anchors: { a1: before.arrows.a1!.anchors! },
      activeBulletIdx: { n1: 2 },
    }, nextRuntime, 1);

    const applied = applyProjectFilePatch(before, patch);
    expect(Object.keys(applied.nodes)).toEqual(['n2']);
    expect(applied.nodes.n2!.position).toEqual({ x: 50, y: 60 });
    expect(Object.keys(applied.arrows)).toEqual([]);
    expect(Object.keys(applied.groups)).toEqual(['g2']);
  });

  it('coalesces a burst into one patch containing the latest state', async () => {
    const before = project();
    adoptProjectPersistenceMirror(before);
    const first = {
      ...before,
      updatedAt: 3,
      nodes: {
        n1: {
          ...before.nodes.n1!,
          versions: [{ ...before.nodes.n1!.versions[0]!, body: 'First' }],
        },
      },
    };
    const second = {
      ...first,
      updatedAt: 4,
      nodes: {
        n1: {
          ...first.nodes.n1!,
          versions: [{ ...first.nodes.n1!.versions[0]!, body: 'Second' }],
        },
      },
    };

    scheduleProjectAutosave(first);
    scheduleProjectAutosave(second);
    await vi.advanceTimersByTimeAsync(299);
    expect(io.patchProjectFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(io.patchProjectFile).toHaveBeenCalledTimes(1);
    const sent = io.patchProjectFile.mock.calls[0]![1];
    expect(sent.nodes.update.n1.versions.update['0'].set.body).toBe('Second');
    expect(io.flushProjectFileMirror).toHaveBeenCalledTimes(1);
    expect(io.saveProjectFile).not.toHaveBeenCalled();
  });

  it('flushes one latest follow-up after a change arrives during a write', async () => {
    const before = project();
    adoptProjectPersistenceMirror(before);
    let resolveFirst!: (value: boolean) => void;
    const firstPatch = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
    io.patchProjectFile
      .mockImplementationOnce(() => firstPatch)
      .mockResolvedValue(true);

    const first = {
      ...before,
      updatedAt: 3,
      nodes: {
        n1: {
          ...before.nodes.n1!,
          versions: [{ ...before.nodes.n1!.versions[0]!, body: 'First' }],
        },
      },
    };
    const second = {
      ...first,
      updatedAt: 4,
      nodes: {
        n1: {
          ...first.nodes.n1!,
          versions: [{ ...first.nodes.n1!.versions[0]!, body: 'Second' }],
        },
      },
    };

    scheduleProjectAutosave(first);
    await vi.advanceTimersByTimeAsync(300);
    scheduleProjectAutosave(second);
    const forcedFlush = flushProjectPersistence(second);
    resolveFirst(true);
    await forcedFlush;

    expect(io.patchProjectFile).toHaveBeenCalledTimes(2);
    const latest = io.patchProjectFile.mock.calls[1]![1];
    expect(latest.nodes.update.n1.versions.update['0'].set.body).toBe('Second');
  });

  it('falls back to a complete save when the worker mirror is unavailable', async () => {
    const before = project();
    adoptProjectPersistenceMirror(before);
    io.patchProjectFile.mockResolvedValue(false);
    const after = { ...before, name: 'Renamed', updatedAt: 3 };

    await flushProjectPersistence(after);

    expect(io.saveProjectFile).toHaveBeenCalledTimes(1);
    expect(io.saveProjectFile.mock.calls[0]![0].name).toBe('Renamed');
  });
});
