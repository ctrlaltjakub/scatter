import { describe, it, expect, beforeEach } from 'vitest';
import {
  createScatter, switchScatter, deleteScatter, renameScatter, bootstrapScatters, reorderProjects,
  recolorScatter, importScatter, reassignActiveProjectColors, createScatterFromBranch, applySyncedScatter,
} from './projectActions';
import { loadAsset, saveAsset } from '@/opfs/assetsIO';
import { useGraphStore } from './useGraphStore';
import { useSettingsStore } from './useSettingsStore';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import { useActiveIdxStore } from './useActiveIdxStore';
import { scheduleReadingPositionAutosave } from './projectPersistence';
import { saveProject, loadProject as loadLegacyProject } from '@/opfs/projectIO';
import {
  loadProjectsIndex, saveProjectsIndex, saveProjectFile, loadProjectById, metaOf,
} from '@/opfs/projectsIO';
import { completeGenGroupTitle, getGenProject, updateGenNode } from './bgGen';
import { DEFAULT_SETTINGS, type Project, type ScatterNode } from './types';

/* Blob-capable: the returned "file" supports readJSON (`file.text()`) AND
 * readBlob (asset bytes, `blob.arrayBuffer()`) — the import tests below
 * round-trip media bytes. Both readers stay LAZY (data resolved at call time,
 * not at getFile() time) so a fire-and-forget save that races a read — like
 * the detached-generation flush — keeps its real-OPFS ordering. */
class MockFile {
  data: string | Blob = '';
  async getFile() {
    const blob = () => (typeof this.data === 'string' ? new Blob([this.data]) : this.data);
    return {
      text: async () => blob().text(),
      arrayBuffer: async () => blob().arrayBuffer(),
    };
  }
  async createWritable() {
    return { write: async (x: string | Blob) => { this.data = x; }, close: async () => {} };
  }
}
class MockDir {
  files = new Map<string, MockFile>();
  dirs = new Map<string, MockDir>();
  async getFileHandle(n: string, o?: { create?: boolean }) {
    if (!this.files.has(n)) { if (!o?.create) throw new DOMException('NotFound', 'NotFoundError'); this.files.set(n, new MockFile()); }
    return this.files.get(n)!;
  }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) { if (!o?.create) throw new DOMException('NotFound', 'NotFoundError'); this.dirs.set(n, new MockDir()); }
    return this.dirs.get(n)!;
  }
  async removeEntry(n: string) {
    if (!this.files.delete(n) && !this.dirs.delete(n)) {
      throw new DOMException('NotFound', 'NotFoundError');
    }
  }
  // listDir support (the on-load orphan-asset sweep iterates the assets dir).
  async *keys() { yield* [...this.files.keys(), ...this.dirs.keys()]; }
}

beforeEach(() => {
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
  useGraphStore.setState({
    project: null, projectList: [], activeProjectId: null,
    searchQuery: '', selectedGroupId: null,
  });
  useGraphStore.temporal.getState().clear();
  useArrowAnchorsStore.setState({ anchors: {} });
  useLivePositionsStore.setState({ positions: {} });
  useLiveViewportStore.getState().clear();
});

function node(id: string): ScatterNode {
  return {
    id, type: 'manual-empty', position: { x: 10, y: 20 }, frozen: false,
    versions: [], currentVersionIndex: 0,
  };
}
function makeProject(id: string, name: string): Project {
  return {
    id, name, createdAt: 1, updatedAt: 1,
    rootNodeId: 'n1', nodes: {}, arrows: {}, groups: {},
    viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
  };
}

describe('projectActions', () => {
  it('preserves the live camera when cloud content replaces the open project', async () => {
    await createScatter('Open project');
    const incoming = { ...useGraphStore.getState().project!, viewport: { x: 900, y: 500, zoom: 1.2 } };
    const applying = applySyncedScatter(incoming);
    // Move after installation has begun; it must not use an earlier snapshot.
    useLiveViewportStore.getState().setViewport({ x: -725, y: 301, zoom: 0.15 });
    await applying;
    expect(useLiveViewportStore.getState()).toMatchObject({ x: -725, y: 301, zoom: 0.15 });
    expect(useGraphStore.getState().project?.viewport).toEqual({ x: -725, y: 301, zoom: 0.15 });
    useGraphStore.temporal.getState().clear();
    useGraphStore.getState().setViewport({ x: -800, y: 310, zoom: 0.2 });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('saves an unfinished camera gesture on switch and restores it on reopening', async () => {
    const id = await createScatter('Camera project');
    useLiveViewportStore.getState().setViewport({ x: -222, y: 333, zoom: 0.1 });
    await createScatter('Elsewhere');
    await switchScatter(id);
    expect(useLiveViewportStore.getState()).toMatchObject({ x: -222, y: 333, zoom: 0.1 });
    expect((await loadProjectById(id))?.viewport).toEqual({ x: -222, y: 333, zoom: 0.1 });
  });
  it('invalidates same-project physics on a sync replacement, but not inactive sync or ordinary edits', async () => {
    const id = await createScatter('Synced project');
    useGraphStore.getState().addNode(node('n1'));
    const revision = useGraphStore.getState().projectLoadRevision;
    useGraphStore.getState().updateNode('n1', { position: { x: 80, y: 90 } });
    expect(useGraphStore.getState().projectLoadRevision).toBe(revision);
    const incoming = { ...useGraphStore.getState().project!, nodes: { n1: { ...node('n1'), position: { x: 400, y: 700 } } } };
    await applySyncedScatter(incoming);
    expect(useGraphStore.getState().project?.id).toBe(id);
    expect(useGraphStore.getState().projectLoadRevision).toBe(revision + 1);
    expect(useLivePositionsStore.getState().positions.n1).toMatchObject({ x: 400, y: 700 });
    await applySyncedScatter(makeProject('inactive', 'Other project'));
    expect(useGraphStore.getState().projectLoadRevision).toBe(revision + 1);
    expect(useGraphStore.getState().project?.id).toBe(id);
  });
  it('migrates old interactive projects before seeding canvas positions and persists the conversion', async () => {
    const project = makeProject('legacy-interactive', 'Old program');
    project.nodes.n1 = { ...node('n1'), type: 'explain', versions: [{
      header: 'Motion - explained', body: 'Saved prose.', createdAt: 1, generatedBy: 'interactive', contentType: 'interactive',
      interactive: { html: '<!doctype html><html><body>Saved program</body></html>', request: 'Motion', model: 'old', providerId: 'p', viewportSize: 580 },
    }] };
    await saveProjectFile(project);
    await switchScatter(project.id);
    const migrated = useGraphStore.getState().project!;
    expect(migrated.nodes.n1?.versions[0]?.contentType).toBe('explain');
    expect(migrated.nodes['n1-interactive']?.versions[0]?.interactive?.html).toContain('Saved program');
    await createScatter('Elsewhere'); // Flushes the migrated project.
    await switchScatter(project.id);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toHaveLength(2);
    expect((await loadProjectById(project.id))?.nodes['n1-interactive']).toBeDefined();
  });
  it('createScatter adds a registry row and switches to the new scatter', async () => {
    const id = await createScatter('Alpha');
    const s = useGraphStore.getState();
    expect(s.activeProjectId).toBe(id);
    expect(s.project?.id).toBe(id);
    expect(s.project?.name).toBe('Alpha');
    expect(s.projectList.map((m) => m.id)).toEqual([id]);
    // Persisted to the registry too.
    const idx = await loadProjectsIndex();
    expect(idx?.activeId).toBe(id);
  });

  it('switching scatters clears undo history (per-scatter isolation)', async () => {
    const aId = await createScatter('A');
    useGraphStore.getState().addNode(node('n1'));
    expect(useGraphStore.temporal.getState().pastStates.length).toBeGreaterThan(0);

    await createScatter('B');  // flushes A, switches to B, clears history
    expect(useGraphStore.temporal.getState().pastStates.length).toBe(0);
    expect(useGraphStore.getState().activeProjectId).not.toBe(aId);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toHaveLength(0);
  });

  it('switching away persists edits and restores them on return', async () => {
    const aId = await createScatter('A');
    useGraphStore.getState().addNode(node('n1'));
    const bId = await createScatter('B');

    await switchScatter(aId);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toContain('n1');

    await switchScatter(bId);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toHaveLength(0);
  });

  it('switchScatter is a no-op when the id is already active', async () => {
    const aId = await createScatter('A');
    await switchScatter(aId);
    expect(useGraphStore.getState().activeProjectId).toBe(aId);
  });

  it('deleting the active scatter switches to another', async () => {
    const aId = await createScatter('A');
    const bId = await createScatter('B');
    await deleteScatter(bId);
    expect(useGraphStore.getState().activeProjectId).toBe(aId);
    expect(useGraphStore.getState().projectList.map((m) => m.id)).toEqual([aId]);
  });

  it('deleting the last scatter creates a fresh blank', async () => {
    const onlyId = await createScatter('Only');
    await deleteScatter(onlyId);
    const list = useGraphStore.getState().projectList;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).not.toBe(onlyId);
    expect(useGraphStore.getState().activeProjectId).toBe(list[0]!.id);
    expect(await loadProjectById(onlyId)).toBeNull();
  });

  it('createScatter prepends new projects to the top', async () => {
    const a = await createScatter('A');
    const b = await createScatter('B');
    expect(useGraphStore.getState().projectList.map((m) => m.id)).toEqual([b, a]);
  });

  it.each([true, false])('copies a branch and its assets with automatic project fitting=%s', async enabled => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, branchProjects: enabled } });
    const sourceId = await createScatter('Source');
    const source = useGraphStore.getState().project!;
    const root: ScatterNode = {
      id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true,
      versions: [{ header: 'Source root', body: 'Root.', createdAt: 1, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
    const branch: ScatterNode = {
      id: 'branch', type: 'term-click', position: { x: 300, y: 200 }, frozen: false, groupId: 'g1',
      versions: [{ header: 'Copied topic', body: 'Topic.', createdAt: 2, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    };
    const child: ScatterNode = {
      id: 'child', type: 'media', position: { x: 500, y: 350 }, frozen: true,
      versions: [{
        header: 'Diagram', body: '', createdAt: 3, generatedBy: 'media', contentType: 'media',
        media: { source: 'asset', kind: 'image', assetId: 'asset-1' },
      }],
      currentVersionIndex: 0,
    };
    useGraphStore.getState().setProject({
      ...source,
      rootNodeId: root.id,
      nodes: { root, branch, child },
      arrows: {
        into: { id: 'into', fromNodeId: root.id, toNodeId: branch.id, kind: 'auto' },
        child: { id: 'child', fromNodeId: branch.id, toNodeId: child.id, kind: 'auto' },
        internal: { id: 'internal', fromNodeId: branch.id, toNodeId: child.id, kind: 'dotted' },
      },
      groups: { g1: { id: 'g1', name: 'Accent', color: '#445566', gravitate: true } },
      selection: [branch.id],
    });
    await saveAsset(sourceId, 'asset-1', new Blob([new Uint8Array([7, 8, 9])]));

    const newId = await createScatterFromBranch(branch.id);
    const state = useGraphStore.getState();
    expect(state.activeProjectId).toBe(newId);
    expect(state.project).toMatchObject({
      id: newId,
      name: 'Copied topic',
      rootNodeId: branch.id,
      color: '#445566',
      selection: [branch.id],
    });
    expect(Object.keys(state.project!.nodes).sort()).toEqual(['branch', 'child']);
    expect(Object.keys(state.project!.arrows).sort()).toEqual(['child', 'internal']);
    expect(state.project!.nodes.branch).toMatchObject({
      type: 'root', frozen: true, position: { x: 0, y: 0 },
    });
    expect(state.project!.nodes.branch?.groupId).toBeUndefined();
    expect(state.project!.nodes.child?.position).toEqual({ x: 200, y: 150 });
    if (enabled) expect(state.panTo).toMatchObject({ kind: 'nodes', ids: ['branch', 'child'], automatic: 'branchProjects' });
    else expect(state.panTo).toBeNull();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);

    const copiedAsset = await loadAsset(newId, 'asset-1');
    expect(new Uint8Array(await copiedAsset!.arrayBuffer())).toEqual(new Uint8Array([7, 8, 9]));
    const persistedSource = await loadProjectById(sourceId);
    expect(persistedSource?.nodes.branch).toBeTruthy();
    expect(persistedSource?.rootNodeId).toBe(root.id);
    expect(persistedSource?.nodes.branch?.position).toEqual({ x: 300, y: 200 });
    expect(persistedSource?.nodes.child?.position).toEqual({ x: 500, y: 350 });

    await switchScatter(sourceId);
    expect(useGraphStore.getState().project?.nodes.branch?.position).toEqual({ x: 300, y: 200 });
    expect(useGraphStore.getState().project?.nodes.child?.position).toEqual({ x: 500, y: 350 });
    expect(useLivePositionsStore.getState().positions.branch).toEqual({ x: 300, y: 200 });
    expect(useLivePositionsStore.getState().positions.child).toEqual({ x: 500, y: 350 });
    expect(useGraphStore.getState().panTo).toBeNull();
  });

  it('leaves the source active and untouched when a branch asset cannot be copied', async () => {
    const sourceId = await createScatter('Source');
    const source = useGraphStore.getState().project!;
    const root: ScatterNode = {
      id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true,
      versions: [{ header: 'Root', body: '', createdAt: 1, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
    const branch: ScatterNode = {
      id: 'branch', type: 'media', position: { x: 100, y: 0 }, frozen: false,
      versions: [{
        header: 'Missing image', body: '', createdAt: 2, generatedBy: 'media', contentType: 'media',
        media: { source: 'asset', kind: 'image', assetId: 'missing' },
      }],
      currentVersionIndex: 0,
    };
    useGraphStore.getState().setProject({
      ...source,
      rootNodeId: root.id,
      nodes: { root, branch },
      arrows: { edge: { id: 'edge', fromNodeId: root.id, toNodeId: branch.id, kind: 'auto' } },
      selection: [branch.id],
    });

    await expect(createScatterFromBranch(branch.id)).rejects.toThrow(/could not be read/);
    expect(useGraphStore.getState().activeProjectId).toBe(sourceId);
    expect(useGraphStore.getState().project?.nodes.branch).toBeTruthy();
    expect(useGraphStore.getState().projectList).toHaveLength(1);
  });

  it('preserves live source positions when another node keeps generating in the old project', async () => {
    const sourceId = await createScatter('Source with background work');
    const source = useGraphStore.getState().project!;
    const root: ScatterNode = {
      id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true, generating: true,
      versions: [{ header: 'Source root', body: 'Generating elsewhere.', createdAt: 1, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
    const branch: ScatterNode = {
      id: 'branch', type: 'term-click', position: { x: 300, y: 200 }, frozen: false,
      versions: [{ header: 'Copied topic', body: 'Complete.', createdAt: 2, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    };
    useGraphStore.getState().setProject({
      ...source,
      rootNodeId: root.id,
      nodes: { root, branch },
      arrows: { into: { id: 'into', fromNodeId: root.id, toNodeId: branch.id, kind: 'auto' } },
      selection: [branch.id],
    });
    // Physics has moved the visible branch since its last semantic position
    // commit. The source snapshot must retain this visible truth while its
    // unrelated root generation remains detached in the background.
    useLivePositionsStore.getState().setPosition(branch.id, 420, 275);

    await createScatterFromBranch(branch.id);
    await switchScatter(sourceId);

    expect(useGraphStore.getState().project?.nodes.branch?.position).toEqual({ x: 420, y: 275 });
    expect(useLivePositionsStore.getState().positions.branch).toEqual({ x: 420, y: 275 });
  });

  it('persists the source branch live coordinates before translating its copy', async () => {
    const sourceId = await createScatter('Live source');
    const source = useGraphStore.getState().project!;
    const root: ScatterNode = {
      id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true,
      versions: [{ header: 'Root', body: '', createdAt: 1, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
    const branch: ScatterNode = {
      id: 'branch', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
      versions: [{ header: 'Live branch', body: '', createdAt: 2, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    };
    useGraphStore.getState().setProject({
      ...source,
      rootNodeId: root.id,
      nodes: { root, branch },
      arrows: { into: { id: 'into', fromNodeId: root.id, toNodeId: branch.id, kind: 'auto' } },
      selection: [branch.id],
    });
    useLivePositionsStore.getState().seedFromMap([
      ['root', { x: 100, y: 80 }],
      ['branch', { x: 813, y: 25 }],
    ]);

    // Mirror useProjectPersistence's reading-position subscription. Project
    // loading resets this transient store; that reset must be attributed to
    // the incoming project rather than scheduling a delayed save of the old
    // project with the incoming project's same-ID live coordinates.
    const unsubscribe = useActiveIdxStore.subscribe(() => {
      const active = useGraphStore.getState().project;
      if (active) scheduleReadingPositionAutosave(active);
    });
    try {
      await createScatterFromBranch(branch.id);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect((await loadProjectById(sourceId))?.nodes.branch?.position).toEqual({ x: 813, y: 25 });
    } finally {
      unsubscribe();
    }
  });

  it('reorderProjects moves a project to the target position', async () => {
    const a = await createScatter('A');
    const b = await createScatter('B');
    const c = await createScatter('C');
    // prepend order is [c, b, a]; move a to b's slot
    await reorderProjects(a, b);
    expect(useGraphStore.getState().projectList.map((m) => m.id)).toEqual([c, a, b]);
  });

  it('reorderProjects stores a downward move at the displayed target index', async () => {
    const a = await createScatter('A');
    const b = await createScatter('B');
    const c = await createScatter('C');
    // prepend order is [c, b, a]; dragging c over a previews [b, a, c].
    await reorderProjects(c, a);
    expect(useGraphStore.getState().projectList.map((m) => m.id)).toEqual([b, a, c]);
  });

  it('renameScatter updates the registry row and active project', async () => {
    const id = await createScatter('Old');
    useGraphStore.temporal.getState().clear();
    await renameScatter(id, 'New');
    expect(useGraphStore.getState().project?.name).toBe('New');
    expect(useGraphStore.getState().projectList[0]!.name).toBe('New');
    const idx = await loadProjectsIndex();
    expect(idx?.items[0]!.name).toBe('New');

    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.name).toBe('Old');
    expect(useGraphStore.getState().projectList[0]!.name).toBe('Old');
  });

  it('bootstrap migrates a legacy project.json into the per-scatter layout', async () => {
    await saveProject(makeProject('legacy1', 'Old single project'));
    await bootstrapScatters();

    expect(useGraphStore.getState().project?.id).toBe('legacy1');
    expect(useGraphStore.getState().activeProjectId).toBe('legacy1');
    const idx = await loadProjectsIndex();
    expect(idx?.activeId).toBe('legacy1');
    expect(idx?.items.map((m) => m.id)).toEqual(['legacy1']);
    // Per-scatter file written; legacy file removed.
    expect(await loadProjectById('legacy1')).not.toBeNull();
    expect(await loadLegacyProject()).toBeNull();
  });

  it('bootstrap with no saved data starts with one blank scatter', async () => {
    await bootstrapScatters();
    const s = useGraphStore.getState();
    expect(s.projectList).toHaveLength(1);
    expect(s.project).not.toBeNull();
    expect(s.activeProjectId).toBe(s.project!.id);
  });

  it('keeps a project generating in the background after switching away', async () => {
    const aId = await createScatter('A');
    useGraphStore.getState().addNode({ ...node('n1'), generating: true });
    // Switch to a new project — A has a generating node, so it detaches.
    const bId = await createScatter('B');
    expect(useGraphStore.getState().activeProjectId).toBe(bId);

    // A background chunk for A arrives while we're on B — must not touch B.
    updateGenNode(aId, 'n1', {
      versions: [{ header: 'n1', body: 'streamed body', createdAt: 1, generatedBy: 'root' }],
    });
    expect(useGraphStore.getState().project!.nodes['n1']).toBeUndefined();

    // Switch back to A → its live in-memory copy is restored, still generating.
    await switchScatter(aId);
    const a = useGraphStore.getState().project!;
    expect(a.nodes['n1']!.versions[0]!.body).toBe('streamed body');
    expect(a.nodes['n1']!.generating).toBe(true);
  });

  it('persists a background generation when it finishes while detached', async () => {
    const aId = await createScatter('A');
    useGraphStore.getState().addNode({ ...node('n1'), generating: true });
    await createScatter('B'); // A detaches

    updateGenNode(aId, 'n1', {
      versions: [{ header: 'n1', body: 'done body', createdAt: 1, generatedBy: 'root' }],
    });
    updateGenNode(aId, 'n1', { generating: false }); // finishes → saved + dropped

    const onDisk = await loadProjectById(aId);
    expect(onDisk!.nodes['n1']!.versions[0]!.body).toBe('done body');
    expect(onDisk!.nodes['n1']!.generating).toBeUndefined();
  });

  it('keeps group title generation alive across project switches and persists the completed name', async () => {
    const aId = await createScatter('A');
    useGraphStore.getState().addNode(node('n1'));
    useGraphStore.getState().addNode(node('n2'));
    const groupId = useGraphStore.getState().createGroupFromNodes(['n1', 'n2'], 'Generating title',
      { id: 'title-request', headers: ['Memory', 'Practice'] });
    const bId = await createScatter('B');
    expect(getGenProject(aId)?.groups[groupId]?.titleGeneration?.error).toBeUndefined();
    completeGenGroupTitle(aId, groupId, 'title-request', 'Learning Strategies');
    expect(useGraphStore.getState().project?.id).toBe(bId);
    const onDisk = await loadProjectById(aId);
    expect(onDisk?.groups[groupId]?.name).toBe('Learning Strategies');
    await switchScatter(aId);
    expect(useGraphStore.getState().project?.groups[groupId]?.name).toBe('Learning Strategies');
    expect(useGraphStore.getState().project?.nodes.n1?.groupId).toBe(groupId);
  });

  it('bootstrap loads the active scatter from an existing registry', async () => {
    const p = makeProject('x', 'X');
    await saveProjectFile(p);
    await saveProjectsIndex({ activeId: 'x', items: [metaOf(p)] });
    await bootstrapScatters();
    expect(useGraphStore.getState().activeProjectId).toBe('x');
    expect(useGraphStore.getState().project?.id).toBe('x');
    expect(useGraphStore.getState().projectList.map((m) => m.id)).toEqual(['x']);
  });
});

describe('projectActions — importScatter', () => {
  it('mints a fresh id, activates the import, and prepends its row', async () => {
    await createScatter('Existing');
    const id = await importScatter(makeProject('incoming-id', 'Imported'), new Map());
    const s = useGraphStore.getState();
    expect(id).not.toBe('incoming-id');           // never trust the file's id
    expect(s.activeProjectId).toBe(id);
    expect(s.project?.name).toBe('Imported');
    expect(s.projectList[0]!.id).toBe(id);
    // Persisted: its own file + the registry row.
    expect(await loadProjectById(id)).not.toBeNull();
    expect((await loadProjectsIndex())?.activeId).toBe(id);
  });

  it('de-duplicates the imported name against existing scatters', async () => {
    await createScatter('Alpha');
    await importScatter(makeProject('x', 'Alpha'), new Map());
    expect(useGraphStore.getState().project?.name).toBe('Alpha 2');
  });

  it('writes asset bytes under the NEW project id', async () => {
    const p = makeProject('orig', 'With media');
    p.nodes['m1'] = {
      ...node('m1'), type: 'media',
      versions: [{
        header: 'pic', body: '', createdAt: 1, generatedBy: 'media',
        media: { source: 'asset', kind: 'image', assetId: 'A1' },
      }],
    };
    const id = await importScatter(p, new Map([['A1', new Blob([new Uint8Array([1, 2, 3])])]]));
    const stored = await loadAsset(id, 'A1');
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('assigns a base color to a color-less import (lazy migration)', async () => {
    await importScatter(makeProject('x', 'X'), new Map());
    expect(useGraphStore.getState().project!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('clamps an imported viewport to the 150% canvas maximum', async () => {
    const incoming = makeProject('x', 'Zoomed');
    incoming.viewport = { x: 4, y: 5, zoom: 8 };
    await importScatter(incoming, new Map());
    expect(useGraphStore.getState().project?.viewport).toEqual({ x: 4, y: 5, zoom: 1.5 });
    expect(useLiveViewportStore.getState().zoom).toBe(1.5);
  });

  it('leaves the imported scatter with empty undo history', async () => {
    await createScatter('A');
    useGraphStore.getState().addNode(node('n1'));
    await importScatter(makeProject('x', 'X'), new Map());
    expect(useGraphStore.temporal.getState().pastStates.length).toBe(0);
  });

  it('strips transient generation flags from the import', async () => {
    const p = makeProject('x', 'X');
    p.nodes['n1'] = { ...node('n1'), generating: true };
    await importScatter(p, new Map());
    expect(useGraphStore.getState().project!.nodes['n1']!.generating).toBeUndefined();
  });
});

describe('projectActions — project base color migration', () => {
  it('bootstrap assigns a base color to a legacy color-less project', async () => {
    const p = makeProject('x', 'X'); // makeProject has no color — a real legacy fixture
    await saveProjectFile(p);
    await saveProjectsIndex({ activeId: 'x', items: [metaOf(p)] });
    await bootstrapScatters();
    expect(useGraphStore.getState().project!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('switchScatter assigns a base color to a color-less on-disk project', async () => {
    await createScatter('A');
    await saveProjectFile(makeProject('old', 'Old'));
    await switchScatter('old');
    expect(useGraphStore.getState().project!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('metaOf mirrors the project color into the registry row', () => {
    expect(metaOf({ ...makeProject('x', 'X'), color: '#abc123' }).color).toBe('#abc123');
    expect(metaOf(makeProject('y', 'Y')).color).toBeUndefined();
  });

  it('opening a scatter mirrors its (possibly migrated) color into the registry', async () => {
    await createScatter('A');
    await saveProjectFile(makeProject('old', 'Old')); // color-less legacy file
    await switchScatter('old');
    const s = useGraphStore.getState();
    const row = s.projectList.find((m) => m.id === 'old')!;
    expect(row.color).toBe(s.project!.color); // migrated color, mirrored
  });

  it('recolorScatter on the ACTIVE project routes through the store + registry', async () => {
    const id = await createScatter('A');
    await recolorScatter(id, '#112233');
    const s = useGraphStore.getState();
    expect(s.project!.color).toBe('#112233');
    expect(s.projectList.find((m) => m.id === id)!.color).toBe('#112233');
  });

  it('recolorScatter on a NON-active project updates its file + registry row only', async () => {
    const otherId = await createScatter('Other');
    const activeId = await createScatter('Active');
    const activeColorBefore = useGraphStore.getState().project!.color;

    await recolorScatter(otherId, '#445566');

    const s = useGraphStore.getState();
    expect(s.activeProjectId).toBe(activeId);
    expect(s.project!.color).toBe(activeColorBefore);              // active untouched
    expect(s.projectList.find((m) => m.id === otherId)!.color).toBe('#445566');
    expect((await loadProjectById(otherId))!.color).toBe('#445566'); // persisted to disk
  });

  it('reassigns, persists, and mirrors the active project palette atomically', async () => {
    const id = await createScatter('Palette');
    await recolorScatter(id, '#000000');
    useGraphStore.getState().createGroup('First', '#111111');
    useGraphStore.getState().createGroup('Second', '#222222');
    useGraphStore.temporal.getState().clear();
    const before = useGraphStore.getState().project!;

    await reassignActiveProjectColors('golden-angle');

    const state = useGraphStore.getState();
    expect(state.project!.color).not.toBe('#000000');
    expect(state.projectList.find((meta) => meta.id === id)!.color)
      .toBe(state.project!.color);
    expect((await loadProjectById(id))!.goldenColorCursorHue)
      .toBe(state.project!.goldenColorCursorHue);

    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project).toEqual(before);
  });

  it('a project saved WITH a color keeps it on load (no reassignment)', async () => {
    const p = { ...makeProject('y', 'Y'), color: '#aabbcc' };
    await saveProjectFile(p);
    await saveProjectsIndex({ activeId: 'y', items: [metaOf(p)] });
    await bootstrapScatters();
    expect(useGraphStore.getState().project!.color).toBe('#aabbcc');
  });
});
