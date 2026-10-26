import { spawnTermClick } from '@/lib/generate';
import { navigateExistingRelation } from '@/lib/relationNavigation';
import { useGraphStore } from '@/store/useGraphStore';
import type { ChatAnswerRef } from '@/store/chatTypes';

export interface ReferenceActionResult {
  kind: 'existing' | 'spawned';
  completion?: Promise<string>;
}

/** One shared route for reference chips on the canvas and in the interactive
 * viewer. Creation mutates the graph synchronously before its generation
 * promise continues in the background. */
export function activateReference(
  parentId: string,
  term: string,
  opts: { withModifier: boolean; sourceAnswer?: ChatAnswerRef },
): ReferenceActionResult {
  const project = useGraphStore.getState().project;
  const parent = project?.nodes[parentId];
  const answer = parent?.versions[parent.currentVersionIndex];
  const sourceAnswer = opts.sourceAnswer ?? (answer?.chat
    ? { turnId: answer.chat.turnId, versionCreatedAt: answer.createdAt } : undefined);
  const existing = project
    ? Object.values(project.arrows).find(
      (arrow) => (arrow.kind === 'auto' || !!sourceAnswer)
        && arrow.fromNodeId === parentId
        && (!sourceAnswer || (arrow.sourceAnswer?.turnId === sourceAnswer.turnId
          && arrow.sourceAnswer.versionCreatedAt === sourceAnswer.versionCreatedAt))
        && arrow.label === term && !!project.nodes[arrow.toNodeId],
    )
    : undefined;
  if (existing) {
    navigateExistingRelation(existing);
    return { kind: 'existing' };
  }
  return {
    kind: 'spawned',
    completion: spawnTermClick(parentId, term, { bulletsCollapsed: opts.withModifier, sourceAnswer }),
  };
}
