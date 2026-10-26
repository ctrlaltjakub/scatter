import { describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useEditorStore } from '@/store/useEditorStore';
import { spawnMarkdownNote } from './emptyNodes';
import { saveManualEdit } from './generate';
import { nodeTypeLabel } from './nodeContentType';
import type { ScatterNode } from '@/store/types';

describe('Markdown text node', () => {
  it('uses the new type label for existing nodes without changing their saved titles', () => {
    const existing: ScatterNode = { id: 'note', type: 'manual-empty', position: { x: 0, y: 0 }, frozen: false,
      currentVersionIndex: 0, versions: [{ header: 'Custom text', body: 'Existing text', contentType: 'answer',
        markdownNote: true, generatedBy: 'manual', createdAt: 1 }] };
    expect(nodeTypeLabel(existing, false)).toBe('MARKDOWN TEXT');
    expect(existing.versions[0]!.header).toBe('Custom text');
  });
  it('creates an editable answer-format node, retains its label through editing, and supports undo', () => {
    const project = createBlankProject('Notes', 'root');
    project.nodes.root = { id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0,
      versions: [{ header: 'Root', body: 'Context', generatedBy: 'root', createdAt: 1 }] };
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    const id = spawnMarkdownNote('root')!;
    const node = () => useGraphStore.getState().project!.nodes[id]!;
    expect(node().chat).toBeUndefined();
    expect(node().versions[0]).toMatchObject({ header: 'Markdown text', contentType: 'answer', markdownNote: true,
      body: '', chat: { title: 'Markdown text' } });
    expect(nodeTypeLabel(node(), false)).toBe('MARKDOWN TEXT');
    expect(useEditorStore.getState().open).toBe(false);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    saveManualEdit(id, 'My notes', '# Heading\n\nMy **text**');
    expect(node().versions[1]).toMatchObject({ markdownNote: true, contentType: 'answer', generatedBy: 'manual' });
    expect(nodeTypeLabel(node(), false)).toBe('MARKDOWN TEXT');
    useGraphStore.temporal.getState().undo();
    expect(node().versions).toHaveLength(1);
    useGraphStore.temporal.getState().undo();
    expect(node()).toBeUndefined();
    useEditorStore.getState().close();
  });
});
