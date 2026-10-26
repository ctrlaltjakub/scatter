import type { Arrow } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { resolveArrowSourceSelection } from './sourceSelection';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { answerVersion } from './chat/model';

/** Reveal the selected source passage in its parent without changing which node
 * is focused. Returns false when a later parent version no longer contains one
 * unambiguous match, so navigation never expands an unrelated bullet. */
export function revealRelationSource(arrow: Arrow): boolean {
  const graph = useGraphStore.getState();
  const parent = graph.project?.nodes[arrow.fromNodeId];
  if (parent && (parent.chat || parent.versions[parent.currentVersionIndex]?.contentType === 'answer') && arrow.sourceAnswer) {
    const version = answerVersion(parent, arrow.sourceAnswer);
    // A deleted turn is an unavailable origin, never a match in another turn.
    if (!version) return false;
    const runtime = useChatRuntimeStore.getState();
    runtime.view(parent.id, { active: arrow.sourceAnswer,
      previews: { ...runtime.views[parent.id]?.previews,
        [arrow.sourceAnswer.turnId]: arrow.sourceAnswer.versionCreatedAt } });
    useGraphStore.temporal.getState().pause();
    try { graph.updateNode(parent.id, { currentVersionIndex: parent.versions.indexOf(version) }); }
    finally { useGraphStore.temporal.getState().resume(); }
    runtime.jumpTo(parent.id, arrow.sourceAnswer.turnId, arrow.sourceSelection?.text ?? arrow.label);
    return true;
  }
  if (!arrow.sourceSelection) return false;
  const version = parent?.versions[parent.currentVersionIndex];
  if (!parent || !version) return false;
  const resolved = resolveArrowSourceSelection(
    version.body,
    version.createdAt,
    arrow.sourceSelection,
  );
  const firstPart = resolved?.parts[0];
  if (!firstPart) return false;

  const bullet = /^b:(\d+):/.exec(firstPart.sourceField);
  if (!bullet) {
    // Opening-paragraph selections are already visible. Clear a previously
    // forced bullet so the opening passage gets the available reading space.
    useActiveIdxStore.getState().set(parent.id, null);
    return true;
  }

  const bulletIndex = Number(bullet[1]);
  if (!Number.isInteger(bulletIndex) || bulletIndex < 0) return false;
  if (parent.bulletsCollapsed) {
    graph.updateNode(parent.id, { bulletsCollapsed: false });
  }
  useActiveIdxStore.getState().set(parent.id, bulletIndex);
  return true;
}

/** Reuse the complete existing-chip route for any persisted source relation. */
export function navigateExistingRelation(arrow: Arrow): void {
  const store = useGraphStore.getState();
  revealRelationSource(arrow);
  store.requestPanTo(arrow.toNodeId);
  store.flashHighlight({
    parentNodeId: arrow.fromNodeId,
    childNodeId: arrow.toNodeId,
    arrowId: arrow.id,
    ...(arrow.label ? { term: arrow.label } : {}),
    source: 'chip',
  });
}
