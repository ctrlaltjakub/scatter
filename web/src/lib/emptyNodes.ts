import type { ImageQuestionContext, ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { currentContentType } from './nodeContentType';
import { MIN_NODE_W, APPROX_HEADER_CHROME } from './nodeSize';
import { newId } from './ids';
import { spawnNearParent } from './generate';
import { useSettingsStore } from '@/store/useSettingsStore';
import { normalizeLanguage } from './languages';

export function isEmptyTextNode(node: ScatterNode): boolean {
  const version = node.versions[node.currentVersionIndex];
  const type = currentContentType(node);
  return (type === 'encyclopedic' || type === 'explain') && !!version?.emptyText && !version.body.trim();
}

/** Creating a connected blank card is a structural edit: one node+arrow undo step. */
export function spawnEmptyTextNode(parentId: string, contentType: 'encyclopedic' | 'explain', sourceImage?: ImageQuestionContext): string | null {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) return null;
  const id = newId();
  const node: ScatterNode = {
    id, type: 'manual-empty', position: spawnNearParent(parent, Object.values(project.nodes), undefined, undefined, sourceImage?.regions),
    frozen: false, groupId: parent.groupId, currentVersionIndex: 0,
    versions: [{ header: contentType === 'explain' ? 'New explanation' : 'New topic', body: '',
      contentType, generatedBy: 'manual', createdAt: Date.now(), emptyText: true, initialTextFrame: true,
      language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
      ...(sourceImage ? { imageContext: structuredClone(sourceImage) } : {}),
      width: MIN_NODE_W, minWidth: MIN_NODE_W, bodyMaxHeight: MIN_NODE_W * (contentType === 'explain' ? .625 : 1.25) - APPROX_HEADER_CHROME }],
  };
  const sourceVersion = parent.versions[parent.currentVersionIndex];
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto',
    ...(sourceImage ? { sourceImage } : {}),
    sourceAnswer: sourceVersion?.chat ? { turnId: sourceVersion.chat.turnId, versionCreatedAt: sourceVersion.createdAt } : undefined });
  graph.setSelection([id]);
  graph.requestPanTo(id, parentId, 'newNodes');
  return id;
}

/** Notes share the detached answer format without a conversation or an AI call.
 * Creation is undoable; opening its editor is navigation. */
export function spawnMarkdownNote(parentId: string, sourceImage?: ImageQuestionContext): string | null {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) return null;
  const id = newId();
  const node: ScatterNode = {
    id, type: 'manual-empty', position: spawnNearParent(parent, Object.values(project.nodes), undefined, undefined, sourceImage?.regions),
    groupId: parent.groupId, frozen: false, currentVersionIndex: 0,
    versions: [{ header: 'Markdown text', body: '', contentType: 'answer', markdownNote: true,
      language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
      generatedBy: 'manual', createdAt: Date.now(), width: MIN_NODE_W, minWidth: 320,
      bodyMaxHeight: 400, minBodyHeight: 120,
      chat: { turnId: id, title: 'Markdown text', question: '', state: 'complete', informationChunking: false, contextPath: [] } }],
  };
  const source = parent.versions[parent.currentVersionIndex];
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto',
    ...(sourceImage ? { sourceImage } : {}),
    sourceAnswer: source?.chat ? { turnId: source.chat.turnId, versionCreatedAt: source.createdAt } : undefined });
  graph.setSelection([id]);
  graph.requestPanTo(id, parentId, 'newNodes');
  return id;
}
