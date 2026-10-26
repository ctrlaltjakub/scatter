import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from './useGraphStore';
import { useImageSelectionStore } from './useImageSelectionStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import { useImageEditorStore } from './useImageEditorStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';

let projectId = '';
const regions = [{ x: .1, y: .2, width: .3, height: .4 }];
beforeEach(() => {
  const project = createBlankProject('Image', 'image');
  projectId = project.id;
  project.selection = ['image'];
  project.nodes.image = { id: 'image', type: 'media', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: 'image', body: '', createdAt: 1, generatedBy: 'media' }, { header: 'v2', body: '', createdAt: 2, generatedBy: 'media' }], currentVersionIndex: 0 };
  useGraphStore.getState().setProject(project);
  useGraphStore.temporal.getState().clear();
  useImageSelectionStore.getState().clear();
  useLiveViewportStore.getState().clear();
  useImageEditorStore.getState().close();
});
const select = () => useImageSelectionStore.getState().set({ projectId, nodeId: 'image', versionCreatedAt: 1, regions });
describe('transient image selection', () => {
  it('does not create undo entries and clears on version changes', () => {
    select();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    useGraphStore.getState().updateNode('image', { currentVersionIndex: 1 });
    expect(useImageSelectionStore.getState().selection).toBeNull();
    select();
    expect(useImageSelectionStore.getState().selection).toBeNull();
  });
  it('rejects late gestures after switching projects, even with reused node IDs', () => {
    select();
    useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, id: 'other' });
    expect(useImageSelectionStore.getState().selection).toBeNull();
    select();
    expect(useImageSelectionStore.getState().selection).toBeNull();
  });
  it('requires sole focus, clears on deselection, and rejects gestures in overview mode', () => {
    select();
    expect(useImageSelectionStore.getState().selection).not.toBeNull();
    useGraphStore.getState().setSelection([]);
    expect(useImageSelectionStore.getState().selection).toBeNull();
    select();
    expect(useImageSelectionStore.getState().selection).toBeNull();
    useGraphStore.getState().setSelection(['image', 'other']);
    select();
    expect(useImageSelectionStore.getState().selection).toBeNull();
    useGraphStore.getState().setSelection(['image']);
    select();
    useLiveViewportStore.getState().setZoom(GROUP_LABEL_ZOOM_THRESHOLD - .01);
    expect(useImageSelectionStore.getState().selection).toBeNull();
    select();
    expect(useImageSelectionStore.getState().selection).toBeNull();
    useLiveViewportStore.getState().setZoom(GROUP_LABEL_ZOOM_THRESHOLD);
    select();
    expect(useImageSelectionStore.getState().selection).not.toBeNull();
  });
  it('lets the editor own image selection independently of the canvas camera', () => {
    useGraphStore.getState().setSelection([]);
    useLiveViewportStore.getState().setZoom(.2);
    useImageEditorStore.getState().openImageEditor('image');
    select();
    expect(useImageSelectionStore.getState().selection).not.toBeNull();
    useImageEditorStore.getState().close();
    expect(useImageSelectionStore.getState().selection).toBeNull();
  });
});
