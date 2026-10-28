import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AddNodeMenu } from './AddNodeMenu';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { imageArrowCandidates, imageArrowContext, imageContextMatches } from '@/lib/imageAtlas';

const regions = [{ x: .1, y: .2, width: .2, height: .3 }, { x: .6, y: .4, width: .1, height: .2 }];
function select() {
  const project = useGraphStore.getState().project!;
  useImageSelectionStore.getState().set({ projectId: project.id, nodeId: 'image', versionCreatedAt: 1, regions });
}
beforeEach(() => {
  useImageEditorStore.getState().close();
  useLiveViewportStore.getState().clear();
  const project = createBlankProject('Synthetic image', 'image');
  project.selection = ['image'];
  project.nodes.image = { id: 'image', type: 'media', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
    versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
      media: { source: 'asset', kind: 'image', assetId: 'fixture', mime: 'image/png', naturalWidth: 800, naturalHeight: 600 } }] };
  useGraphStore.getState().setProject(project);
  useGraphStore.temporal.getState().resume();
  useGraphStore.temporal.getState().clear();
  useImageSelectionStore.getState().clear();
});

describe('Add node from an image selection', () => {
  it('updates the label live, including while the menu is open', () => {
    render(<AddNodeMenu nodeId="image" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    act(select);
    expect(screen.getByRole('button', { name: 'Add node (selection)' })).toHaveAttribute('aria-expanded', 'true');
    act(() => useImageSelectionStore.getState().clear());
    expect(screen.getByRole('button', { name: 'Add node' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Explanation' }));
    expect(Object.values(useGraphStore.getState().project!.arrows)[0]!.sourceImage).toBeUndefined();
  });

  it.each(['Chat', 'Image or video', 'Encyclopedic node', 'Explanation', 'Interactive node', 'Markdown text node'])(
    'connects %s to the captured regions in one undo step, retaining atlas origins after reload', label => {
      render(<AddNodeMenu nodeId="image" />);
      act(select);
      fireEvent.click(screen.getByRole('button', { name: 'Add node (selection)' }));
      fireEvent.click(screen.getByRole('button', { name: label }));
      const project = useGraphStore.getState().project!;
      const [arrow] = Object.values(project.arrows);
      const child = project.nodes[arrow!.toNodeId]!;
      expect(child).toBeDefined();
      expect(child.generating).not.toBe(true);
      expect(arrow!.sourceImage).toEqual({ sourceMedia: project.nodes.image!.versions[0]!.media, sourceVersionCreatedAt: 1, regions });
      expect(arrow!.sourceImage!.regions).not.toBe(regions);
      expect(project.selection).toEqual([child.id]);
      expect(useImageSelectionStore.getState().selection).toBeNull();
      expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
      act(() => useGraphStore.temporal.getState().undo());
      expect(Object.keys(useGraphStore.getState().project!.nodes)).toEqual(['image']);
      expect(Object.keys(useGraphStore.getState().project!.arrows)).toHaveLength(0);
      act(() => useGraphStore.temporal.getState().redo());
      const saved = JSON.parse(JSON.stringify(useGraphStore.getState().project!));
      act(() => useGraphStore.getState().setProject(saved));
      const restored = imageArrowCandidates(saved.arrows, 'image')[0]!;
      expect(imageArrowContext(restored, saved.nodes[child.id])).toEqual(arrow!.sourceImage);
      expect(imageContextMatches(restored.sourceImage!, saved.nodes.image)).toBe(true);
    });

  it('does not attach an old selection after changing image versions', () => {
    render(<AddNodeMenu nodeId="image" />);
    act(select);
    fireEvent.click(screen.getByRole('button', { name: 'Add node (selection)' }));
    act(() => {
      const node = useGraphStore.getState().project!.nodes.image!;
      useGraphStore.getState().updateNode('image', { versions: [...node.versions, { ...node.versions[0]!, createdAt: 2 }], currentVersionIndex: 1 });
    });
    expect(screen.getByRole('button', { name: 'Add node' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(Object.values(useGraphStore.getState().project!.arrows)[0]!.sourceImage).toBeUndefined();
  });
});
