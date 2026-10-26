import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { saveManualEdit } from './generate';

describe('structured manual header versions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T10:00:00Z'));
  });

  it('appends the complete structured title while preserving its semantic split', () => {
    const node: ScatterNode = {
      id: 'n0', type: 'explain', position: { x: 5, y: 9 }, frozen: true,
      versions: [{ header: 'Old - explained', body: 'Body', createdAt: 1, generatedBy: 'explain', contentType: 'explain' }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('header-version', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });

    saveManualEdit(node.id, { subject: 'Manual exact title', question: 'Why?', suffix: 'explained' }, 'Edited body');

    const version = useGraphStore.getState().project!.nodes[node.id]!.versions[1]!;
    expect(version).toMatchObject({
      header: 'Manual exact title: Why? - explained',
      headerParts: { subject: 'Manual exact title', question: 'Why?', suffix: 'explained' },
      body: 'Edited body',
      generatedBy: 'manual',
      selectedTextQuestion: 'Why?',
      contentType: 'explain',
    });
  });
});
