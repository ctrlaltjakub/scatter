import type { ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { getGenProject, updateGenNode } from '@/store/bgGen';

/** undefined = unrelated error; false = this warning belongs elsewhere or was dismissed. */
export function showRetainedOutlineWarning(node: ScatterNode): boolean | undefined {
  const warning = node.retainedOutlineWarning;
  if (!warning || warning.message !== node.generationError) return undefined;
  return !warning.ignored && node.versions[node.currentVersionIndex]?.createdAt === warning.versionCreatedAt;
}

export function warnAboutRetainedOutline(projectId: string, nodeId: string, versionIndex: number, message: string): void {
  const version = getGenProject(projectId)?.nodes[nodeId]?.versions[versionIndex];
  if (!version) return;
  updateGenNode(projectId, nodeId, {
    generating: false, streamingText: false, generatingVersionIndex: undefined,
    generationError: message, retainedOutlineWarning: { versionCreatedAt: version.createdAt, message },
  });
}

/** Dismissing is presentation only: no undo step, new request, or change of
 * generation status that could trigger automatic enrichment. */
export function ignoreOutlineWarning(projectId: string, nodeId: string, versionCreatedAt: number): void {
  const project = useGraphStore.getState().project;
  if (project?.id !== projectId) return;
  const node = project.nodes[nodeId], warning = node?.retainedOutlineWarning;
  if (!node || !warning || warning.versionCreatedAt !== versionCreatedAt || !showRetainedOutlineWarning(node)) return;
  // This is a UI dismissal, not a project edit. Keep updatedAt unchanged so a
  // dismissal cannot look like newer project content to the sync service.
  useGraphStore.setState({ project: { ...project, nodes: { ...project.nodes,
    [nodeId]: { ...node, retainedOutlineWarning: { ...warning, ignored: true } },
  } } });
}
