import type { Arrow } from '@/store/types';
import type { ChatAnswerRef } from '@/store/chatTypes';

/** Read-only, runtime-only lookups. Never stored in a project or undo history. */
export interface NodeRelations {
  childByTerm: ReadonlyMap<string, string>;
  termChildIds: ReadonlySet<string>;
  firstTermByChild: ReadonlyMap<string, string>;
  sourceSelections: readonly Arrow[];
  sourceSelectionById: ReadonlyMap<string, Arrow>;
  sourceSelectionChildIds: ReadonlySet<string>;
}

const EMPTY: NodeRelations = {
  childByTerm: new Map(), termChildIds: new Set(), firstTermByChild: new Map(),
  sourceSelections: [], sourceSelectionById: new Map(), sourceSelectionChildIds: new Set(),
};
interface ParentIndex {
  arrows: readonly Arrow[];
  auto?: NodeRelations;
  answers: Map<string, NodeRelations>;
}
type Index = Map<string, ParentIndex>;
const indices = new WeakMap<Record<string, Arrow>, Index>();
let recentIndex: Index = new Map();

function indexFor(arrows: Record<string, Arrow>): Index {
  const cached = indices.get(arrows);
  if (cached) return cached;
  const grouped = new Map<string, Arrow[]>();
  for (const arrow of Object.values(arrows)) {
    const list = grouped.get(arrow.fromNodeId);
    if (list) list.push(arrow);
    else grouped.set(arrow.fromNodeId, [arrow]);
  }
  const index: Index = new Map();
  for (const [id, list] of grouped) {
    const previous = recentIndex.get(id);
    // An edit to another parent's arrows must not invalidate this body's
    // cached text. Arrow identity/order also preserves duplicate-label rules.
    index.set(id, previous && list.length === previous.arrows.length
      && list.every((arrow, i) => arrow === previous.arrows[i])
      ? previous : { arrows: list, answers: new Map() });
  }
  indices.set(arrows, index);
  recentIndex = index;
  return index;
}

function build(arrows: readonly Arrow[]): NodeRelations {
  if (!arrows.length) return EMPTY;
  const childByTerm = new Map<string, string>();
  const firstTermByChild = new Map<string, string>();
  const sourceSelections: Arrow[] = [];
  for (const arrow of arrows) {
    if (arrow.label) {
      if (!childByTerm.has(arrow.label)) childByTerm.set(arrow.label, arrow.toNodeId);
      if (!firstTermByChild.has(arrow.toNodeId)) firstTermByChild.set(arrow.toNodeId, arrow.label);
    }
    if (arrow.sourceSelection) sourceSelections.push(arrow);
  }
  return {
    childByTerm, termChildIds: new Set(childByTerm.values()), firstTermByChild,
    sourceSelections,
    sourceSelectionById: new Map(sourceSelections.map(arrow => [arrow.id, arrow])),
    sourceSelectionChildIds: new Set(sourceSelections.map(arrow => arrow.toNodeId)),
  };
}

/** One project-wide scan per immutable arrows record, then constant-time
 * lookups per node/answer. Weak keys let discarded projects/history expire.
 * Non-chat bodies use auto arrows; chat answers retain their existing rule
 * of accepting any arrow kind, scoped to the exact turn AND answer version. */
export function nodeRelations(
  arrows: Record<string, Arrow> | undefined,
  parentNodeId: string,
  answer?: ChatAnswerRef,
): NodeRelations {
  if (!arrows) return EMPTY;
  const parent = indexFor(arrows).get(parentNodeId);
  if (!parent) return EMPTY;
  if (!answer) return parent.auto ??= build(parent.arrows.filter(arrow => arrow.kind === 'auto'));
  const key = JSON.stringify([answer.turnId, answer.versionCreatedAt]);
  let relations = parent.answers.get(key);
  if (!relations) {
    relations = build(parent.arrows.filter(arrow => arrow.sourceAnswer?.turnId === answer.turnId
      && arrow.sourceAnswer.versionCreatedAt === answer.versionCreatedAt));
    parent.answers.set(key, relations);
  }
  return relations;
}

export function relatedSelectedNodeId(selection: readonly string[] | undefined, children: ReadonlySet<string>): string | null {
  const id = selection?.length === 1 ? selection[0]! : null;
  return id !== null && children.has(id) ? id : null;
}
