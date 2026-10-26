import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGraphStore, createBlankProject } from './useGraphStore';
import { useSettingsStore } from './useSettingsStore';
import { DEFAULT_SETTINGS, type ScatterNode } from './types';
import { normalizeSettings } from '@/opfs/settingsIO';
import { settingsSnapshot } from './settingsSnapshot';
import { normalizeCameraAutoPan, type CameraPanTrigger } from '@/lib/cameraPreferences';

vi.mock('@/opfs/settingsIO', async original => ({ ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}) }));

function node(id: string): ScatterNode {
  return { id, type: 'term-click', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: id, body: 'Text', createdAt: 1, generatedBy: 'root' }] };
}
beforeEach(() => {
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  const project = { ...createBlankProject('Camera', 'root'), nodes: { root: node('root'), child: node('child') },
    arrows: { arrow: { id: 'arrow', fromNodeId: 'root', toNodeId: 'child', kind: 'auto' as const } } };
  useGraphStore.setState({ project, panTo: null, panArrival: null });
  useGraphStore.temporal.getState().clear();
});
afterEach(() => {
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  useGraphStore.setState({ project: null, panTo: null });
});

describe('automatic camera preferences', () => {
  it('preserves existing behavior for old files, validates fields, and persists explicit off choices', () => {
    expect(normalizeCameraAutoPan(undefined)).toEqual(DEFAULT_SETTINGS.cameraAutoPan);
    expect(normalizeCameraAutoPan({ focus: false, generation: 'false', unknown: false }))
      .toEqual({ ...DEFAULT_SETTINGS.cameraAutoPan, focus: false });
    useSettingsStore.getState().setCameraAutoPan('focus', false);
    useSettingsStore.getState().setCameraAutoPan('groups', false);
    useSettingsStore.getState().setCameraAutoPan('branchProjects', false);
    useSettingsStore.getState().setCameraAutoPan('dragEdges', false);
    expect(normalizeSettings(settingsSnapshot(useSettingsStore.getState())).cameraAutoPan.focus).toBe(false);
    expect(normalizeSettings(settingsSnapshot(useSettingsStore.getState())).cameraAutoPan)
      .toMatchObject({ groups: false, branchProjects: false, dragEdges: false });
    expect(normalizeCameraAutoPan({ focus: false, newNodes: false, generation: false, expand: false,
      panels: false, reading: false, delete: false })).toMatchObject({ groups: true, branchProjects: true, dragEdges: true });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it.each(['focus', 'groups', 'newNodes', 'branchProjects', 'rootGeneration', 'expand', 'panels', 'reading', 'delete'] as CameraPanTrigger[])
    ('gates %s without blocking explicit navigation or other automatic behaviors', reason => {
      const graph = useGraphStore.getState();
      useSettingsStore.getState().setCameraAutoPan(reason, false);
      graph.requestPanTo('child', 'root', reason);
      expect(useGraphStore.getState().panTo).toBeNull();
      graph.requestPanTo('child');
      expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'node', id: 'child' });
      const explicit = useGraphStore.getState().panTo;
      graph.requestPanTo('root', undefined, reason);
      expect(useGraphStore.getState().panTo).toBe(explicit);
      useSettingsStore.getState().setCameraAutoPan(reason, true);
      graph.requestPanTo('child', 'root', reason);
      expect(useGraphStore.getState().panTo).toMatchObject({ automatic: reason, id: 'child', includeId: 'root' });
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    });

  it.each(['groups', 'branchProjects'] as const)('gates multi-node fits for %s independently', reason => {
    const graph = useGraphStore.getState();
    useSettingsStore.getState().setCameraAutoPan(reason, false);
    graph.requestFitNodes(['root', 'child'], reason);
    expect(useGraphStore.getState().panTo).toBeNull();
    graph.requestFitNodes(['root', 'child']);
    const explicit = useGraphStore.getState().panTo;
    graph.requestFitNodes(['root'], reason);
    expect(useGraphStore.getState().panTo).toBe(explicit);
    useSettingsStore.getState().setCameraAutoPan(reason, true);
    graph.requestFitNodes(['root', 'child'], reason);
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'nodes', ids: ['root', 'child'], automatic: reason });
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('keeps explicit fits available when every automatic behavior is off', () => {
    useSettingsStore.setState({ cameraAutoPan: Object.fromEntries(Object.keys(DEFAULT_SETTINGS.cameraAutoPan).map(key => [key, false])) as typeof DEFAULT_SETTINGS.cameraAutoPan });
    const graph = useGraphStore.getState();
    graph.requestPanelReveal('child');
    graph.requestFitNodes(['child'], 'panels');
    expect(useGraphStore.getState().panTo).toBeNull();
    graph.requestFitNode('child');
    expect(useGraphStore.getState().project?.selection).toEqual(['child']);
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'node', id: 'child', fit: 'centered' });
    graph.requestFitNodes(['root', 'child']);
    expect(useGraphStore.getState().panTo).toMatchObject({ kind: 'nodes', ids: ['root', 'child'] });
  });

  it.each([true, false])('deletes and undoes normally with return-to-parent=%s', enabled => {
    useSettingsStore.getState().setCameraAutoPan('delete', enabled);
    useGraphStore.getState().deleteNodeCascade('child');
    expect(useGraphStore.getState().project?.nodes.child).toBeUndefined();
    expect(useGraphStore.getState().panTo?.id ?? null).toBe(enabled ? 'root' : null);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project?.nodes.child).toBeDefined();
  });
});
