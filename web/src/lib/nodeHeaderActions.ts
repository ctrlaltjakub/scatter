import { useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { canInlineEditNodeHeader, normalizeEditableHeader } from './nodeHeaderText';

export function requestNodeHeaderEdit(nodeId: string) {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  if (!project || !node || node.generating || !canInlineEditNodeHeader(node, project.arrows)) return;
  const runtime = useChatRuntimeStore.getState();
  runtime.view(nodeId, { titleEditNonce: (runtime.views[nodeId]?.titleEditNonce ?? 0) + 1 });
}

/** One content action on blur (and hence one undo step). Preserve version,
 * language, image pixels, citations, and interactive code; do not call AI. */
export function saveNodeHeader(projectId: string, nodeId: string, versionCreatedAt: number, text: string) {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const node = project?.nodes[nodeId];
  const title = normalizeEditableHeader(text);
  if (!project || project.id !== projectId || !node || !title) return;
  if (node.chat) {
    if (node.chat.title !== title) graph.updateNode(nodeId, { chat: { ...node.chat, title, titleManual: true } });
    return;
  }
  const index = node.versions.findIndex(version => version.createdAt === versionCreatedAt);
  const version = node.versions[index];
  if (!version || version.header === title) return;
  graph.updateNode(nodeId, { versions: node.versions.map((item, i) => i === index
    ? { ...item, header: title, headerParts: { subject: title },
      ...(item.chat ? { chat: { ...item.chat, title, titleManual: true } } : {}) }
    : item) });
}
