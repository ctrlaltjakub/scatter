import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { NodeSidePanel } from './NodeSidePanel';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { spawnInteractiveNode } from '@/lib/interactiveActions';
import { useSettingsStore } from '@/store/useSettingsStore';

vi.mock('@/lib/interactiveActions', () => ({ spawnInteractiveNode: vi.fn(), buildInteractiveNode: vi.fn(), stopInteractiveBuild: vi.fn() }));

function makeNode(contentType: 'encyclopedic' | 'explain' | 'interactive'): ScatterNode {
  return {
    id: 'n0',
    type: contentType === 'explain' ? 'explain' : 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{
      header: contentType === 'explain' ? 'Entropy - explained' : 'Entropy',
      body: contentType === 'explain' ? 'Entropy measures uncertainty.' : 'Intro.\n\n- **History**\n  - Early work.',
      createdAt: 0,
      generatedBy: 'root',
      contentType,
      ...(contentType === 'interactive' ? {
        interactive: {
          html: '<!doctype html><html><body>demo</body></html>',
          request: 'Entropy', providerId: 'p', model: 'm', viewportSize: 580 as const,
        },
      } : {}),
    }],
    currentVersionIndex: 0,
  };
}

function renderPanel(
  contentType: 'encyclopedic' | 'explain' | 'interactive',
  generating = false,
  activeIdx: number | null = null,
) {
  const node = makeNode(contentType);
  node.generating = generating;
  const project = createBlankProject('panel-test', node.id);
  useGraphStore.getState().setProject({
    ...project,
    nodes: { [node.id]: node },
    rootNodeId: node.id,
    selection: [node.id],
  });
  useGraphStore.temporal.getState().pause();
  useActiveIdxStore.getState().set(node.id, activeIdx);
  return render(<NodeSidePanel />);
}

describe('NodeSidePanel explain actions', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    useActiveIdxStore.getState().replaceAll([]);
    vi.restoreAllMocks();
  });

  it('shows exactly one Expand action and no bullet-specific actions', () => {
    renderPanel('explain');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getAllByRole('button', { name: 'Expand' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Expand whole' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand bullet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Extract bullet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit header' })).toBeNull();
  });

  it('names the section action after the opening paragraph at scrollbar stop zero', () => {
    renderPanel('encyclopedic');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(document.querySelector('.side-disclosure-content button')).toBe(screen.getByRole('button', { name: 'Edit header' }));
    expect(screen.getByRole('button', { name: 'Expand whole' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand opening paragraph' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extract bullet' })).toBeTruthy();
  });

  it('names the section action after the active bullet', () => {
    renderPanel('encyclopedic', false, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Expand bullet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Expand opening paragraph' })).toBeNull();
  });

  it('allows deleting a freshly generating node', () => {
    renderPanel('explain', true);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(useGraphStore.getState().project?.nodes.n0).toBeUndefined();
  });

  it('offers explicit creation and interactive-only regeneration actions', () => {
    const first = renderPanel('explain');
    const create = screen.getByRole('button', { name: 'Generate interactive explanation' });
    expect(create).toHaveAttribute('data-tip', expect.stringContaining('Higher costs compared to the text or image nodes.'));
    expect([...create.querySelectorAll('.interactive-cost-icons svg')].map(icon => icon.getAttribute('class')))
      .toEqual([expect.stringContaining('lucide-triangle-alert'), expect.stringContaining('lucide-dollar-sign')]);
    first.unmount();
    renderPanel('interactive');
    const regenerate = screen.getByRole('button', { name: 'Regenerate' });
    expect(regenerate.closest('.versions-row-actions')).not.toBeNull();
    expect(regenerate.querySelector('svg')).toHaveClass('lucide-rotate-ccw');
    expect(regenerate.querySelector('svg')).toHaveAttribute('width', '14');
    expect(screen.getByRole('button', { name: 'Restart' }).querySelector('svg')).toHaveClass('lucide-play');
    expect(screen.getByRole('button', { name: 'Open enlarged' }).querySelector('svg')).toHaveClass('lucide-maximize');
    expect(screen.queryByRole('button', { name: 'Create project from branch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate text-only explanation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand text' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('creates a separate interactive node instead of converting the explanation', () => {
    useSettingsStore.setState({ providers: [{ id: 'p', preset: 'custom', apiKey: 'test', enabledModels: ['code'] }], activeModelRef: { providerId: 'p', model: 'code' }, interactiveModelRef: undefined });
    renderPanel('explain');
    const original = useGraphStore.getState().project!.nodes.n0;
    fireEvent.click(screen.getByRole('button', { name: 'Generate interactive explanation' }));
    expect(spawnInteractiveNode).toHaveBeenCalledWith('n0', true);
    expect(useGraphStore.getState().project!.nodes.n0).toBe(original);
  });

  it('does not offer project creation from a non-root interactive branch', () => {
    renderPanel('interactive');
    act(() => {
      const project = useGraphStore.getState().project!;
      const root = { ...makeNode('encyclopedic'), id: 'other-root' };
      useGraphStore.getState().setProject({ ...project, rootNodeId: root.id, nodes: { ...project.nodes, [root.id]: root } });
    });
    expect(screen.queryByRole('button', { name: 'Create project from branch' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Regenerate' }).closest('.versions-row')).not.toBeNull();
  });

  it('offers an empty interactive node from Add node', () => {
    renderPanel('encyclopedic');
    fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
    const addInteractive = screen.getByRole('button', { name: 'Interactive node' });
    expect(addInteractive).toHaveAttribute('data-tip', expect.stringContaining('Higher costs compared to the text or image nodes.'));
    expect([...addInteractive.querySelectorAll('.interactive-cost-icons svg')].map(icon => icon.getAttribute('class')))
      .toEqual([expect.stringContaining('lucide-triangle-alert'), expect.stringContaining('lucide-dollar-sign')]);
    fireEvent.click(addInteractive);
    expect(spawnInteractiveNode).toHaveBeenCalledWith('n0');
  });
});
