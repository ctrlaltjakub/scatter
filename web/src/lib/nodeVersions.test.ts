import { afterEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import type { NodeVersion, ScatterNode } from '@/store/types';
import { beginGenerationSession, finishGenerationSession, registerGenerationController, resetGenerationSessionsForTests } from './generationSession';
import { trackGenerationVersions } from './generationVersionTracking';
import { removeNodeVersion } from './nodeVersions';

afterEach(() => { resetGenerationSessionsForTests(); useRewriteStore.setState({ snapshot: {} }); });

describe('version deletion during background generation', () => {
  it('stops ownership when the generated version itself is removed', () => {
    const node: ScatterNode = { id: 'n', type: 'explain', position: { x: 0, y: 0 }, frozen: false,
      currentVersionIndex: 1, generating: true, generatingVersionIndex: 1, streamingText: true,
      versions: [1, 2].map(createdAt => ({ createdAt, header: 'Version', body: 'Text.', generatedBy: 'manual' })) };
    expect(removeNodeVersion(node, 2)).toMatchObject({ versions: [{ createdAt: 1 }], currentVersionIndex: 0,
      generating: false, generatingVersionIndex: undefined, streamingText: false });
  });
  it.each(['explain', 'encyclopedic', 'answer', 'media', 'interactive'] as const)(
    'removes the displayed %s version and retains draft ownership through undo and redo', contentType => {
      const version = (createdAt: number): NodeVersion => ({ createdAt, header: 'Version', body: `Body ${createdAt}`, generatedBy: 'manual', contentType });
      const node: ScatterNode = { id: 'n', type: 'follow-up', position: { x: 0, y: 0 }, frozen: false,
        versions: [version(1), version(2), version(3)], currentVersionIndex: 0, generating: true, generatingVersionIndex: 2 };
      const project = { ...createBlankProject('Version deletion', node.id), nodes: { n: node } };
      useGraphStore.setState({ project, activeProjectId: project.id });
      useGraphStore.temporal.getState().clear();
      const session = beginGenerationSession({ projectId: project.id, nodeId: 'n', kind: 'rewrite', sourceVersionIndex: 1, draftVersionIndex: 2 });
      const controller = new AbortController();
      registerGenerationController(session.id, controller);
      trackGenerationVersions(session);
      useGraphStore.getState().updateNode('n', removeNodeVersion(node, 1)!);
      expect(useGraphStore.getState().project!.nodes.n!).toMatchObject({
        versions: [{ createdAt: 2 }, { createdAt: 3 }], currentVersionIndex: 0, generating: true, generatingVersionIndex: 1,
      });
      expect(session).toMatchObject({ sourceVersionIndex: 0, draftVersionIndex: 1 });
      expect(controller.signal.aborted).toBe(false);
      useGraphStore.temporal.getState().undo();
      expect(session).toMatchObject({ sourceVersionIndex: 1, draftVersionIndex: 2 });
      expect(useGraphStore.getState().project!.nodes.n!.generatingVersionIndex).toBe(2);
      useGraphStore.temporal.getState().redo();
      expect(session).toMatchObject({ sourceVersionIndex: 0, draftVersionIndex: 1 });
      const current = useGraphStore.getState().project!.nodes.n!;
      useGraphStore.getState().updateNode('n', removeNodeVersion(current, 2)!);
      expect(session).toMatchObject({ sourceVersionIndex: null, draftVersionIndex: 0 });
      expect(controller.signal.aborted).toBe(false);
      expect(removeNodeVersion(useGraphStore.getState().project!.nodes.n!, 3)).toBeNull();
      finishGenerationSession(project.id, 'n', session.id);
      useGraphStore.temporal.getState().undo();
      // Finishing removes the subscription; no dormant generation tracks future edits.
      expect(session.draftVersionIndex).toBe(0);
    },
  );
});
