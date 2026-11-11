import type { Arrow, ImageQuestionContext, NodeVersion, Project, ScatterNode } from '@/store/types';
import { imageMediaKey } from './imageAtlas';
import { currentContentType } from './nodeContentType';

type Topology = Pick<Project, 'arrows' | 'nodes' | 'rootNodeId'>;

export function parentChoices(project: Topology, nodeId: string) {
  const candidates = new Set<string>();
  const incoming = Object.values(project.arrows).filter(a => a.kind === 'auto' && a.toNodeId === nodeId);
  const arrow = incoming.length === 1 ? incoming[0] : undefined;
  if (nodeId === project.rootNodeId || !project.nodes[nodeId] || !arrow || !project.nodes[arrow.fromNodeId]) {
    return { arrow: undefined, candidates, reason: 'This node has no single parent to change.' };
  }
  const ids = Object.keys(project.nodes);
  if (ids.length <= 2) return { arrow, candidates, reason: 'Add a third node to choose a different parent.' };
  const children = new Map<string, string[]>();
  for (const a of Object.values(project.arrows)) {
    if (a.kind !== 'auto') continue;
    const list = children.get(a.fromNodeId);
    if (list) list.push(a.toNodeId); else children.set(a.fromNodeId, [a.toNodeId]);
  }
  const branch = new Set<string>();
  const pending = [nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (branch.has(id)) continue;
    branch.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  for (const id of ids) if (id !== arrow.fromNodeId && !branch.has(id)) candidates.add(id);
  return { arrow, candidates, reason: candidates.size ? null : 'No other parent is available outside this branch.' };
}

/** Recheck the live graph on commit: a deletion, undo or sync may have happened
 * since the picker opened. Keep the identity of the structural edge for sync. */
export function withChangedParent(project: Project, nodeId: string, parentId: string, expected: Pick<Arrow, 'id' | 'fromNodeId'>): Project | null {
  const { arrow, candidates } = parentChoices(project, nodeId);
  if (!arrow || arrow.id !== expected.id || arrow.fromNodeId !== expected.fromNodeId || !candidates.has(parentId)) return null;
  const parent = project.nodes[parentId]!, node = project.nodes[nodeId]!;
  const replacement: Arrow = { id: arrow.id, kind: 'auto', fromNodeId: parentId, toNodeId: nodeId, parentScope: 'node',
    ...(arrow.createdAt != null ? { createdAt: arrow.createdAt } : {}) };
  // Snapshots are the history of actual chat requests, not an instruction to
  // keep attaching the old parent's selection to the next question.
  const nodes = node.chat ? { ...project.nodes, [nodeId]: { ...node, chat: { ...node.chat,
    parentNodeId: chatContextParentId(parent), originSnapshotId: undefined,
  } } } : project.nodes;
  return { ...project, nodes, arrows: { ...project.arrows, [arrow.id]: replacement }, updatedAt: Date.now() };
}

export function chatContextParentId(parent: ScatterNode): string | undefined {
  return currentContentType(parent) !== 'media' || imageMediaKey(parent.versions[parent.currentVersionIndex]?.media) ? parent.id : undefined;
}

export function structuralParent(project: Pick<Project, 'arrows'>, childId: string): Arrow | undefined {
  return Object.values(project.arrows).find(a => a.kind === 'auto' && a.toNodeId === childId);
}

/** Versions retain their historical evidence; new requests use the live relation. */
export function parentImageForRequest(project: Topology | null | undefined, childId: string, version?: NodeVersion): ImageQuestionContext | undefined {
  const arrow = project && structuralParent(project, childId);
  if (arrow?.parentScope !== 'node') return version?.imageContext ?? arrow?.sourceImage;
  const parent = project!.nodes[arrow.fromNodeId], current = parent?.versions[parent.currentVersionIndex];
  const image = current?.media;
  return image && imageMediaKey(image) ? { sourceMedia: image, sourceVersionCreatedAt: current.createdAt, regions: [] } : undefined;
}
