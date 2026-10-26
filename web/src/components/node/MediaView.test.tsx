import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { MediaView } from './MediaView';

describe('MediaView image editor affordance', () => {
  beforeAll(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
  afterEach(() => {
    useImageEditorStore.getState().close();
    useGraphStore.setState({ project: null });
  });

  it('shows an accessible Maximize affordance over an image and opens its editor', () => {
    const project = createBlankProject('media', 'image-node');
    useGraphStore.getState().setProject({
      ...project,
      nodes: {
        'image-node': {
          id: 'image-node',
          type: 'media',
          position: { x: 0, y: 0 },
          frozen: false,
          versions: [{
            header: 'Image', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
            media: { source: 'link', kind: 'image', url: 'https://example.com/image.png' },
          }],
          currentVersionIndex: 0,
        },
      },
      rootNodeId: 'image-node',
    });

    render(<MediaView nodeId="image-node" />);
    const button = screen.getByRole('button', { name: 'Open image editor' });
    expect(button.querySelector('.lucide-maximize')).toHaveAttribute('width', '20');
    fireEvent.click(button);
    expect(useImageEditorStore.getState()).toMatchObject({ open: true, nodeId: 'image-node' });
  });

  it.each(['unsupported', 'broken'] as const)('can return from a %s attachment to the chooser without deleting the previous version', (failure) => {
    const project = createBlankProject('media', 'image-node');
    project.nodes['image-node'] = {
      id: 'image-node', type: 'media', position: { x: 0, y: 0 }, frozen: false, currentVersionIndex: 0,
      versions: [{ header: 'Image', body: '', createdAt: 1, generatedBy: 'media', contentType: 'media',
        media: { source: 'link', kind: 'image', url: 'https://example.com/missing.png',
          ...(failure === 'unsupported' ? { unsupportedReason: 'Unsupported file format.' } : {}) } }],
    };
    useGraphStore.getState().setProject(project);
    const { container } = render(<MediaView nodeId="image-node" />);
    if (failure === 'broken') fireEvent.error(container.querySelector('img')!);
    fireEvent.click(screen.getByRole('button', { name: 'Choose another file or link' }));
    const node = useGraphStore.getState().project!.nodes['image-node']!;
    expect(node.currentVersionIndex).toBe(1);
    expect(node.versions[0]!.media?.url).toBe('https://example.com/missing.png');
    expect(node.versions[1]!.media).toBeUndefined();
    expect(node.versions[1]!.body).toContain('upload');
  });
});
