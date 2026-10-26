import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NavActions } from './NavActions';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';

vi.mock('@/opfs/projectsIO', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/opfs/projectsIO')>();
  return { ...actual, saveProjectsIndex: vi.fn(async () => undefined) };
});

beforeEach(() => {
  const project = createBlankProject('Actions', 'root', () => 0.4);
  useGraphStore.setState({
    project,
    projectList: [],
    activeProjectId: project.id,
  });
  useGraphStore.temporal.getState().clear();
  useImageEditorStore.setState({ open: false, nodeId: null, undoHandle: null });
});

describe('NavActions semantic undo labels', () => {
  it('names and applies the next graph undo and redo action', () => {
    useGraphStore.getState().addNode({
      id: 'term',
      type: 'term-click',
      position: { x: 10, y: 20 },
      frozen: false,
      versions: [{
        header: 'Term',
        body: 'Body',
        createdAt: 1,
        generatedBy: 'term-click',
      }],
      currentVersionIndex: 0,
    });

    render(<NavActions onOpenSettings={vi.fn()} />);
    const undo = screen.getByRole('button', { name: 'Undo: Explore term' });
    expect(undo).toHaveAttribute('data-tip', 'Undo: Explore term (⌘Z)');

    fireEvent.click(undo);
    expect(useGraphStore.getState().project!.nodes.term).toBeUndefined();

    const redo = screen.getByRole('button', { name: 'Redo: Explore term' });
    expect(redo).toHaveAttribute('data-tip', 'Redo: Explore term (⌘⇧Z)');
    fireEvent.click(redo);
    expect(useGraphStore.getState().project!.nodes.term).toBeDefined();
  });
});
