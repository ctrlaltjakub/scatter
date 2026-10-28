import type { Arrow, Project, ScatterNode } from '@/store/types';
import { sourceAssetIds } from './projectSources';

/** Inclusive descendants reachable through automatic arrows. Dotted arrows do
 * not define branch membership, but are copied later when both endpoints land
 * inside the resulting set. */
export function collectAutomaticBranchNodeIds(
  rootNodeId: string,
  arrows: Iterable<Arrow>,
): Set<string> {
  const ids = new Set<string>([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const arrow of arrows) {
      if (
        arrow.kind === 'auto'
        && ids.has(arrow.fromNodeId)
        && !ids.has(arrow.toNodeId)
      ) {
        ids.add(arrow.toNodeId);
        changed = true;
      }
    }
  }
  return ids;
}

/** Asset IDs needed to make a set of copied nodes fully self-contained. */
export function collectReferencedAssetIds(
  nodes: Iterable<ScatterNode>,
): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    for (const snapshot of Object.values(node.chat?.parentSnapshots ?? {})) {
      if (snapshot.media?.assetId) ids.add(snapshot.media.assetId);
      if (snapshot.imageContext?.sourceMedia.assetId) ids.add(snapshot.imageContext.sourceMedia.assetId);
    }
    for (const version of node.versions) {
      for (const attachment of version.chat?.attachments ?? []) {
        if (attachment.media?.assetId) ids.add(attachment.media.assetId);
      }
      if (version.media?.assetId) ids.add(version.media.assetId);
      if (version.imageContext?.sourceMedia.assetId) ids.add(version.imageContext.sourceMedia.assetId);
      if (version.imageGeneration?.sourceMedia?.assetId) {
        ids.add(version.imageGeneration.sourceMedia.assetId);
      }
    }
  }
  return ids;
}

export interface ReferencedProjectAssets {
  media: Set<string>;
  sourceEager: Set<string>;
  sourceLazy: Set<string>;
}

/** Complete persisted asset manifest. Source originals are separated because
 * synced devices need text/index data immediately but may fetch originals only
 * when the source viewer opens. */
export function collectReferencedProjectAssets(project: Project): ReferencedProjectAssets {
  const source = sourceAssetIds(project.sourceLibrary ?? { mode: 'ignore', order: [], sources: {} });
  return {
    media: collectReferencedAssetIds(Object.values(project.nodes)),
    sourceEager: source.eager,
    sourceLazy: source.lazy,
  };
}

/** Copy a live branch into an otherwise blank destination project. */
export function copyBranchIntoProject(
  source: Project,
  rootNodeId: string,
  destination: Project,
): Project {
  const sourceRoot = source.nodes[rootNodeId];
  if (!sourceRoot) throw new Error('The selected branch root no longer exists.');

  const included = collectAutomaticBranchNodeIds(
    rootNodeId,
    Object.values(source.arrows),
  );
  const origin = sourceRoot.position;
  const nodes: Record<string, ScatterNode> = {};

  for (const nodeId of included) {
    const sourceNode = source.nodes[nodeId];
    if (!sourceNode) continue;
    const copied = structuredClone(sourceNode);
    copied.position = {
      x: sourceNode.position.x - origin.x,
      y: sourceNode.position.y - origin.y,
    };
    delete copied.generating;
    delete copied.generatingVersionIndex;
    delete copied.streamingText;
    delete copied.generationError;
    if (nodeId === rootNodeId) {
      copied.type = 'root';
      copied.frozen = true;
      delete copied.groupId;
    }
    nodes[nodeId] = copied;
  }

  const arrows: Project['arrows'] = {};
  for (const [arrowId, sourceArrow] of Object.entries(source.arrows)) {
    if (!nodes[sourceArrow.fromNodeId] || !nodes[sourceArrow.toNodeId]) continue;
    const copied = structuredClone(sourceArrow);
    if (copied.anchors) {
      copied.anchors = copied.anchors.map((point) => ({
        x: point.x - origin.x,
        y: point.y - origin.y,
      }));
    }
    arrows[arrowId] = copied;
  }

  const referencedGroups = new Set(
    Object.values(nodes)
      .map((node) => node.groupId)
      .filter((groupId): groupId is string => !!groupId),
  );
  const groups: Project['groups'] = {};
  for (const groupId of referencedGroups) {
    const group = source.groups[groupId];
    if (group) groups[groupId] = structuredClone(group);
  }

  return {
    ...destination,
    rootNodeId,
    nodes,
    arrows,
    groups,
    ...(source.sourceLibrary ? { sourceLibrary: structuredClone(source.sourceLibrary) } : {}),
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [rootNodeId],
  };
}
