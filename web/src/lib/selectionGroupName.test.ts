import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { Arrow, Project } from '@/store/types';
import { createGroupFromSelection, parseSelectionGroupName, selectedCommonAncestor } from './selectionGroupName';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { dropDetached, getGenProject, projectHasGenerating, stashDetached } from '@/store/bgGen';
import { flushDetachedProjectPersistence } from '@/store/projectPersistence';
import { useSettingsStore } from '@/store/useSettingsStore';
vi.mock('./secondaryTaskCompletion', () => ({ secondaryTaskCompletion: vi.fn() }));
vi.mock('@/store/projectPersistence', () => ({ flushDetachedProjectPersistence: vi.fn(() => new Promise<void>(() => {})), releaseProjectPersistence: vi.fn() }));

function deferredName() {
  let resolve!: (value: string) => void;
  vi.mocked(secondaryTaskCompletion).mockImplementation(() => new Promise(r => { resolve = r; }));
  return async () => { resolve('{"name":"Learning Methods"}'); await Promise.resolve(); };
}
function fixture(): Project {
  const project = createBlankProject('Naming', 'root');
  project.nodes = Object.fromEntries(['root', 'a', 'b', 'c', 'd'].map((id) => [id, {
    id, type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: `Header ${id}`, body: '', createdAt: 1, generatedBy: 'manual' }], currentVersionIndex: 0,
  }]));
  const edge = (from: string, to: string, kind: Arrow['kind'] = 'auto'): Arrow => ({ id: from + to, fromNodeId: from, toNodeId: to, kind });
  project.arrows = Object.fromEntries([edge('root', 'a'), edge('a', 'b'), edge('b', 'c'), edge('root', 'd')].map((a) => [a.id, a]));
  return project;
}
beforeEach(() => {
  vi.mocked(secondaryTaskCompletion).mockReset();
  useGraphStore.setState({ project: fixture() });
  useGraphStore.temporal.getState().clear();
  useSettingsStore.setState({ generationLanguage: 'en' });
});
describe('selection group naming', () => {
  it('uses the selected generation language and accepts compact CJK names', async () => {
    useSettingsStore.setState({ generationLanguage: 'ja' });
    vi.mocked(secondaryTaskCompletion).mockResolvedValue('{"name":"学習と記憶"}');
    const id = createGroupFromSelection(['b', 'd'])!;
    await Promise.resolve();
    expect(secondaryTaskCompletion).toHaveBeenCalledWith(expect.objectContaining({ system: expect.stringContaining('Japanese (ja-JP)') }));
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('学習と記憶');
    expect(parseSelectionGroupName('{"name":"操作系统"}')).toBe('操作系统');
  });
  it('finds a selected structural ancestor, independently of click order or missing intermediate nodes', () => {
    const project = fixture();
    expect(selectedCommonAncestor(project, ['c', 'a', 'b'])).toBe('a');
    expect(selectedCommonAncestor(project, ['c', 'a'])).toBe('a');
    expect(selectedCommonAncestor(project, ['b', 'd'])).toBeNull();
    project.arrows.ref = { id: 'ref', fromNodeId: 'b', toNodeId: 'd', kind: 'dotted' };
    expect(selectedCommonAncestor(project, ['b', 'd'])).toBeNull();
  });
  it('rejects ambiguous cycles', () => {
    const project = fixture();
    project.arrows.cycle = { id: 'cycle', fromNodeId: 'c', toNodeId: 'a', kind: 'auto' };
    expect(selectedCommonAncestor(project, ['a', 'c'])).toBeNull();
  });
  it('uses the ancestor header without calling a model; creation and assignment undo together', async () => {
    useGraphStore.getState().setSelection(['c', 'a']);
    const id = createGroupFromSelection(['c', 'a']);
    expect(secondaryTaskCompletion).not.toHaveBeenCalled();
    expect(useGraphStore.getState().project!.groups[id!]!.name).toBe('Header a');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.groups[id!]).toBeUndefined();
  });
  it('creates and assigns immediately, then finishes naming after deselection with no extra undo step', async () => {
    useGraphStore.getState().setSelection(['b', 'd']);
    const finish = deferredName();
    const id = createGroupFromSelection(['b', 'd'])!;
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('Generating title');
    expect(useGraphStore.getState().project!.nodes.b!.groupId).toBe(id);
    expect(useGraphStore.getState().project!.nodes.d!.groupId).toBe(id);
    useGraphStore.getState().setSelection([]);
    expect(vi.mocked(secondaryTaskCompletion).mock.calls[0]![0].signal?.aborted).toBe(false);
    await finish();
    expect(secondaryTaskCompletion).toHaveBeenCalledWith(expect.objectContaining({ user: '{"headers":["Header b","Header d"]}', rejectTruncated: true }));
    expect(useGraphStore.getState().project!.groups[id!]!.name).toBe('Learning Methods');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    expect(useGraphStore.getState().project!.groups[id]!.titleGeneration).toBeUndefined();
  });
  it('does not resurrect an undone group, and redo restores the completed name', async () => {
    const finish = deferredName();
    const id = createGroupFromSelection(['b', 'd'])!;
    useGraphStore.temporal.getState().undo();
    await finish();
    expect(useGraphStore.getState().project!.groups[id]).toBeUndefined();
    useGraphStore.temporal.getState().redo();
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('Learning Methods');
    expect(useGraphStore.getState().project!.groups[id]!.titleGeneration).toBeUndefined();
  });
  it('never overwrites a manual title, and undoing that edit restores the completed automatic title', async () => {
    const finish = deferredName();
    const id = createGroupFromSelection(['b', 'd'])!;
    useGraphStore.getState().renameGroup(id, 'My own title');
    await finish();
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('My own title');
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('Learning Methods');
  });
  it('does not rewind the completed title when undoing an unrelated action', async () => {
    const finish = deferredName();
    const id = createGroupFromSelection(['b', 'd'])!;
    useGraphStore.getState().setNodesFrozen(['b'], true);
    await finish();
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('Learning Methods');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  });
  it('retains a useful group when naming fails, without a permanent progress state', async () => {
    vi.mocked(secondaryTaskCompletion).mockRejectedValue(new Error('No model configured'));
    const id = createGroupFromSelection(['b', 'd'])!;
    await Promise.resolve();
    expect(useGraphStore.getState().project!.groups[id]).toMatchObject({ name: 'Untitled group', titleGeneration: { error: 'No model configured' } });
    expect(useGraphStore.getState().project!.nodes.b!.groupId).toBe(id);
    expect(projectHasGenerating(useGraphStore.getState().project!)).toBe(false);
  });
  it('continues in a detached project and persists its final title without touching the new active project', async () => {
    const finish = deferredName();
    const id = createGroupFromSelection(['b', 'd'])!;
    const source = useGraphStore.getState().project!;
    expect(projectHasGenerating(source)).toBe(true);
    stashDetached(source);
    const other = fixture();
    useGraphStore.setState({ project: other, activeProjectId: other.id });
    await finish();
    expect(getGenProject(source.id)?.groups[id]?.name).toBe('Learning Methods');
    expect(flushDetachedProjectPersistence).toHaveBeenCalledWith(expect.objectContaining({ id: source.id }));
    expect(useGraphStore.getState().project).toBe(other);
    dropDetached(source.id);
  });
  it('requires a real 2–3-word name', () => {
    expect(parseSelectionGroupName('{"name":"Operating Systems"}')).toBe('Operating Systems');
    for (const name of ['Systems', 'A very long group title', '**Operating Systems**', '']) {
      expect(() => parseSelectionGroupName(JSON.stringify({ name }))).toThrow();
    }
  });
});
