import type {
  Arrow,
  Group,
  NodeVersion,
  Project,
  ScatterNode,
} from '@/store/types';
import { recoverChatNode } from './chat/model';
import { recoverInteractiveNode } from './interactiveRecovery';

export type HistoryActionKind =
  | 'node-create'
  | 'node-delete'
  | 'version-create'
  | 'version-delete'
  | 'node-content'
  | 'group-create'
  | 'group-delete'
  | 'group-membership'
  | 'group-edit'
  | 'pin'
  | 'relation'
  | 'project-style'
  | 'project-edit';

export interface HistoryActionDescriptor {
  kind: HistoryActionKind;
  label: string;
  nodeIds: string[];
}

export interface GraphHistorySlice {
  project: Project | null;
}

const VERSION_PRESENTATION_KEYS = [
  'width',
  'interactiveCanvasWidth',
  'minWidth',
  'bodyMaxHeight',
  'minBodyHeight',
  'fullBodyHeight',
  'freeTextHeight',
  'expandedMeasureWidth',
] as const satisfies readonly (keyof NodeVersion)[];

type VersionPresentationKey = (typeof VERSION_PRESENTATION_KEYS)[number];

const VERSION_NON_SEMANTIC_KEYS = new Set<string>([
  ...VERSION_PRESENTATION_KEYS,
  'factCheck',
  'interactiveBuild',
  'answerEnrichmentId',
]);
const NODE_PRESENTATION_KEYS = new Set<string>([
  'position',
  'currentVersionIndex',
  'generating',
  'generatingVersionIndex',
  'streamingText',
  'generationError',
  'renderedHeight',
  'bulletsCollapsed',
  'activeBulletIdx',
  'chunkIntro',
]);
const NODE_NON_SEMANTIC_KEYS = new Set<string>([
  ...NODE_PRESENTATION_KEYS,
  'versions',
]);
const ARROW_NON_SEMANTIC_KEYS = new Set<string>(['anchors']);

/**
 * Exact structural equality with an identity fast path.
 *
 * Scatter updates its persisted graph immutably, so almost every nested value
 * is shared by reference between two adjacent states. JSON.stringify used to
 * throw that information away and repeatedly copy large bodies/interactive
 * documents merely to decide whether an undo step was needed.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    a === null
    || b === null
    || typeof a !== 'object'
    || typeof b !== 'object'
  ) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameValue(a[index], b[index])) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right) || !sameValue(left[key], right[key])) return false;
  }
  return true;
}

function equalRecordExcept(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  omitted: ReadonlySet<string>,
): boolean {
  if (a === b) return true;
  const leftKeys = Object.keys(a).filter((key) => !omitted.has(key));
  const rightKeys = Object.keys(b).filter((key) => !omitted.has(key));
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in b) || !sameValue(a[key], b[key])) return false;
  }
  return true;
}

function semanticVersionEqual(a: NodeVersion, b: NodeVersion): boolean {
  return equalRecordExcept(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    VERSION_NON_SEMANTIC_KEYS,
  );
}

function semanticNodeEqual(a: ScatterNode, b: ScatterNode): boolean {
  if (a === b) return true;
  if (!equalRecordExcept(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    NODE_NON_SEMANTIC_KEYS,
  )) return false;
  if (a.versions === b.versions) return true;
  if (a.versions.length !== b.versions.length) return false;
  for (let index = 0; index < a.versions.length; index += 1) {
    const left = a.versions[index];
    const right = b.versions[index];
    if (!left || !right || !semanticVersionEqual(left, right)) return false;
  }
  return true;
}

function semanticArrowEqual(a: Arrow, b: Arrow): boolean {
  return equalRecordExcept(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    ARROW_NON_SEMANTIC_KEYS,
  );
}

function recordValuesEqual<T>(
  a: Record<string, T>,
  b: Record<string, T>,
  equal: (left: T, right: T) => boolean,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (!left || !right || !equal(left, right)) return false;
  }
  return true;
}

function semanticProjectEqual(a: Project | null, b: Project | null): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  const {
    viewport: _aViewport,
    viewportUpdatedAt: _aViewportUpdatedAt,
    selection: _aSelection,
    updatedAt: _aUpdatedAt,
    nodes: aNodes,
    arrows: aArrows,
    groups: aGroups,
    ...aSemantic
  } = a;
  const {
    viewport: _bViewport,
    viewportUpdatedAt: _bViewportUpdatedAt,
    selection: _bSelection,
    updatedAt: _bUpdatedAt,
    nodes: bNodes,
    arrows: bArrows,
    groups: bGroups,
    ...bSemantic
  } = b;
  if (!sameValue(aSemantic, bSemantic)) return false;
  if (aNodes !== bNodes && !recordValuesEqual(aNodes, bNodes, (left, right) => (
    left === right || semanticNodeEqual(left, right)
  ))) return false;
  if (aArrows !== bArrows && !recordValuesEqual(aArrows, bArrows, (left, right) => (
    left === right || semanticArrowEqual(left, right)
  ))) return false;
  // Object-key order is the sidebar order, but reordering is presentation,
  // not semantic history. Compare the groups by identity and value instead.
  return aGroups === bGroups || recordValuesEqual(aGroups, bGroups, (left, right) => (
    left === right || sameValue(left, right)
  ));
}

/** zundo equality: true means the update must not consume an undo step. */
export function graphHistorySlicesEqual(
  past: GraphHistorySlice,
  current: GraphHistorySlice,
): boolean {
  return semanticProjectEqual(past.project, current.project);
}

function matchingVersion(
  versions: readonly NodeVersion[],
  target: NodeVersion,
): NodeVersion | undefined {
  return versions.find((candidate) => (
    candidate.createdAt === target.createdAt
    && candidate.generatedBy === target.generatedBy
  ));
}

function mergeVersionPresentation(
  current: NodeVersion,
  target: NodeVersion,
): NodeVersion {
  const merged: NodeVersion = { ...target };
  for (const key of VERSION_PRESENTATION_KEYS) {
    const value = current[key];
    if (value !== undefined) {
      (merged as NodeVersion & Record<VersionPresentationKey, unknown>)[key] = value;
    } else {
      delete merged[key];
    }
  }
  // Evidence review is auxiliary analysis, not an edit. Let an in-flight or
  // newly completed report survive an unrelated content undo.
  if (current.factCheck !== undefined) merged.factCheck = current.factCheck;
  else delete merged.factCheck;
  return merged;
}

function clampVersionIndex(node: ScatterNode, index: number): number {
  return Math.max(0, Math.min(node.versions.length - 1, index));
}

function mergeNodePresentation(current: ScatterNode, target: ScatterNode): ScatterNode {
  let versions = target.versions.map((targetVersion) => {
    const currentVersion = matchingVersion(current.versions, targetVersion);
    return currentVersion
      ? mergeVersionPresentation(currentVersion, targetVersion)
      : targetVersion;
  });

  // Streaming writes intentionally bypass history. If another action is
  // undone while this node is still generating, retain the latest draft
  // rather than rewinding it to whatever chunk existed at snapshot time.
  const liveDraft = current.generatingVersionIndex == null
    ? undefined
    : current.versions[current.generatingVersionIndex];
  const targetDraftIndex = liveDraft
    ? versions.findIndex((version) => (
        version.createdAt === liveDraft.createdAt
        && version.generatedBy === liveDraft.generatedBy
      ))
    : -1;
  const preserveGeneration = Boolean(current.generating && liveDraft && targetDraftIndex >= 0);
  if (preserveGeneration && liveDraft) {
    versions = versions.slice();
    versions[targetDraftIndex] = liveDraft;
  }

  const versionCountChanged = current.versions.length !== target.versions.length;
  const merged: ScatterNode = {
    ...target,
    position: current.position,
    renderedHeight: current.renderedHeight,
    bulletsCollapsed: current.bulletsCollapsed,
    activeBulletIdx: current.activeBulletIdx,
    chunkIntro: current.chunkIntro,
    versions,
    currentVersionIndex: clampVersionIndex(
      { ...target, versions },
      versionCountChanged ? target.currentVersionIndex : current.currentVersionIndex,
    ),
  };

  if (preserveGeneration) {
    merged.generating = current.generating;
    merged.generatingVersionIndex = targetDraftIndex;
    merged.streamingText = current.streamingText;
    merged.generationError = current.generationError;
  }
  return preserveGeneration ? merged : recoverInteractiveNode(recoverChatNode(merged));
}

/**
 * Preserve the relative order of existing rows, inserting restored records
 * beside their nearest historical neighbour. That lets undo restore a deleted
 * group without undoing a later drag-reorder of the surviving groups.
 */
function mergeRecordOrder<T>(
  current: Record<string, T>,
  target: Record<string, T>,
): Record<string, T> {
  const targetKeys = Object.keys(target);
  const ordered = Object.keys(current).filter((key) => key in target);
  for (const key of targetKeys) {
    if (ordered.includes(key)) continue;
    const targetIndex = targetKeys.indexOf(key);
    let insertion = ordered.length;
    for (let i = targetIndex + 1; i < targetKeys.length; i += 1) {
      const nextIndex = ordered.indexOf(targetKeys[i]!);
      if (nextIndex >= 0) {
        insertion = nextIndex;
        break;
      }
    }
    if (insertion === ordered.length) {
      for (let i = targetIndex - 1; i >= 0; i -= 1) {
        const previousIndex = ordered.indexOf(targetKeys[i]!);
        if (previousIndex >= 0) {
          insertion = previousIndex + 1;
          break;
        }
      }
    }
    ordered.splice(insertion, 0, key);
  }
  return Object.fromEntries(ordered.map((key) => [key, target[key]!]));
}

/**
 * Apply a semantic snapshot while carrying the user's current view/layout
 * forward. Records that are restored from deletion naturally keep the layout
 * stored in their historical snapshot because no current counterpart exists.
 */
export function preserveProjectPresentation(
  current: Project | null,
  target: Project | null,
): Project | null {
  if (!current || !target || current.id !== target.id) return target;

  const targetNodes: Record<string, ScatterNode> = {};
  for (const [id, targetNode] of Object.entries(target.nodes)) {
    const currentNode = current.nodes[id];
    targetNodes[id] = currentNode
      ? mergeNodePresentation(currentNode, targetNode)
      : recoverInteractiveNode(recoverChatNode(targetNode));
  }
  const nodes = mergeRecordOrder(current.nodes, targetNodes);

  const targetArrows: Record<string, Arrow> = {};
  for (const [id, targetArrow] of Object.entries(target.arrows)) {
    const anchors = current.arrows[id]?.anchors;
    targetArrows[id] = anchors ? { ...targetArrow, anchors } : targetArrow;
  }

  return {
    ...target,
    nodes,
    arrows: mergeRecordOrder(current.arrows, targetArrows),
    groups: mergeRecordOrder(current.groups, target.groups),
    viewport: current.viewport,
    viewportUpdatedAt: current.viewportUpdatedAt,
    selection: current.selection.filter((id) => id in nodes),
    updatedAt: target.updatedAt,
  };
}

function changedNodeIds(before: Project, after: Project): string[] {
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  return [...ids].filter((id) => {
    const left = before.nodes[id];
    const right = after.nodes[id];
    if (!left || !right) return true;
    return !semanticNodeEqual(left, right);
  });
}

function describeCreatedNode(node: ScatterNode | undefined): string {
  if (!node) return 'Create node';
  if (node.type === 'term-click') return 'Explore term';
  if (node.type === 'follow-up') return 'Ask follow-up';
  if (node.type === 'explain') return 'Create explanation';
  if (node.type === 'media') return 'Create media node';
  if (node.type === 'interactive') return 'Create interactive node';
  return 'Create node';
}

/** Human-readable metadata shown by toolbar tooltips and shortcut hints. */
export function describeHistoryChange(
  before: Project | null,
  after: Project | null,
): HistoryActionDescriptor {
  if (!before || !after) {
    return { kind: 'project-edit', label: 'Edit project', nodeIds: [] };
  }
  // Starting from chat/image assigns the initial name and root atomically.
  // Describe that as content creation, not a standalone rename.
  if (before.name !== after.name && Object.keys(before.nodes).length === Object.keys(after.nodes).length) {
    return { kind: 'project-edit', label: 'Rename project', nodeIds: [] };
  }
  const beforeNodeIds = Object.keys(before.nodes);
  const afterNodeIds = Object.keys(after.nodes);
  const addedNodes = afterNodeIds.filter((id) => !before.nodes[id]);
  const removedNodes = beforeNodeIds.filter((id) => !after.nodes[id]);
  const nodeIds = changedNodeIds(before, after);

  if (addedNodes.length > 0) {
    return {
      kind: 'node-create',
      label: addedNodes.length === 1
        ? describeCreatedNode(after.nodes[addedNodes[0]!])
        : 'Create nodes',
      nodeIds,
    };
  }
  if (removedNodes.length > 0) {
    return {
      kind: 'node-delete',
      label: removedNodes.length === 1 ? 'Delete node' : 'Delete branch',
      nodeIds,
    };
  }

  const beforeGroupIds = Object.keys(before.groups);
  const afterGroupIds = Object.keys(after.groups);
  if (afterGroupIds.some((id) => !before.groups[id])) {
    return { kind: 'group-create', label: 'Create group', nodeIds };
  }
  if (beforeGroupIds.some((id) => !after.groups[id])) {
    return { kind: 'group-delete', label: 'Delete group', nodeIds };
  }

  for (const id of new Set([...beforeNodeIds, ...afterNodeIds])) {
    const left = before.nodes[id];
    const right = after.nodes[id];
    if (!left || !right) continue;
    if (left.versions.length < right.versions.length) {
      const created = right.versions.find((version) => (
        !left.versions.some((old) => (
          old.createdAt === version.createdAt
          && old.generatedBy === version.generatedBy
        ))
      ));
      const label = created?.generatedBy === 'manual'
        ? 'Save text edit'
        : created?.contentType === 'media'
          ? 'Create image version'
          : created?.contentType === 'interactive'
            ? 'Create interactive version'
            : 'Generate version';
      return { kind: 'version-create', label, nodeIds };
    }
    if (left.versions.length > right.versions.length) {
      return { kind: 'version-delete', label: 'Delete version', nodeIds };
    }
  }

  const membershipChanged = nodeIds.some((id) => (
    before.nodes[id]?.groupId !== after.nodes[id]?.groupId
  ));
  if (membershipChanged) {
    return { kind: 'group-membership', label: 'Change group membership', nodeIds };
  }

  const pinChanges = nodeIds
    .map((id) => ({ before: before.nodes[id], after: after.nodes[id] }))
    .filter(({ before: left, after: right }) => left && right && left.frozen !== right.frozen);
  if (pinChanges.length > 0) {
    const pinned = pinChanges.every(({ after: right }) => right?.frozen);
    return {
      kind: 'pin',
      label: `${pinned ? 'Pin' : 'Unpin'} ${pinChanges.length === 1 ? 'node' : 'nodes'}`,
      nodeIds,
    };
  }

  if (before.color !== after.color) {
    return { kind: 'project-style', label: 'Change project colors', nodeIds };
  }

  const changedGroups = afterGroupIds.filter((id) => (
    before.groups[id] && !sameValue(before.groups[id], after.groups[id])
  ));
  if (changedGroups.length > 0) {
    const id = changedGroups[0]!;
    const left = before.groups[id]!;
    const right = after.groups[id]!;
    const label = left.name !== right.name
      ? 'Rename group'
      : left.color !== right.color
        ? 'Change group color'
        : left.gravitate !== right.gravitate
          ? `${right.gravitate ? 'Pin' : 'Unpin'} group`
          : 'Edit group';
    return { kind: 'group-edit', label, nodeIds };
  }

  const arrowCountChanged = Object.keys(before.arrows).length !== Object.keys(after.arrows).length;
  if (arrowCountChanged) {
    return {
      kind: 'relation',
      label: Object.keys(after.arrows).length > Object.keys(before.arrows).length
        ? 'Create relation'
        : 'Delete relation',
      nodeIds,
    };
  }

  if (!sameValue(before.groups, after.groups)) {
    return { kind: 'project-style', label: 'Change project colors', nodeIds };
  }

  if (nodeIds.length > 0) {
    return { kind: 'node-content', label: 'Edit node content', nodeIds };
  }
  return { kind: 'project-edit', label: 'Edit project', nodeIds };
}
