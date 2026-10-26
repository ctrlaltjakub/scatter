import type { Arrow, Project } from '@/store/types';

/** References are visual-only and show ink, labels, and aura clearing on focus. */
export function isArrowVisible(arrow: Arrow, selection: readonly string[]): boolean {
  return arrow.kind !== 'dotted' || selection.includes(arrow.fromNodeId) || selection.includes(arrow.toNodeId);
}

/** Compute a cascade without destroying branches still owned by a surviving
 * reference. Promotion changes ancestry, never positions or content. */
export function planNodeDeletion(project: Project, rootId: string): {
  deletedIds: Set<string>;
  promotedArrowIds: Set<string>;
} {
  return planNodesDeletion(project, [rootId]);
}

/** Plan the whole selection together: a reference from another deleted branch
 * cannot rescue a descendant, and explicitly selected nodes are never rescued. */
export function planNodesDeletion(project: Project, rootIds: readonly string[]): {
  deletedIds: Set<string>;
  promotedArrowIds: Set<string>;
} {
  const roots = new Set(rootIds.filter((id) => project.nodes[id]));
  const arrows = Object.values(project.arrows);
  const children = new Map<string, string[]>();
  for (const arrow of arrows) if (arrow.kind === 'auto') {
    const list = children.get(arrow.fromNodeId) ?? [];
    list.push(arrow.toNodeId);
    children.set(arrow.fromNodeId, list);
  }
  const branch = (id: string): Set<string> => {
    const result = new Set<string>();
    const pending = [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (result.has(next)) continue;
      result.add(next);
      pending.push(...(children.get(next) ?? []));
    }
    return result;
  };
  const deletedIds = new Set([...roots].flatMap((id) => [...branch(id)]));
  const promotedArrowIds = new Set<string>();
  const references = arrows.filter((arrow) => arrow.kind === 'dotted')
    .sort((a, b) => (a.createdAt ?? a.sourceSelection?.createdAt ?? 0)
      - (b.createdAt ?? b.sourceSelection?.createdAt ?? 0) || a.id.localeCompare(b.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const reference of references) {
      if (roots.has(reference.toNodeId) || !deletedIds.has(reference.toNodeId)
        || deletedIds.has(reference.fromNodeId) || !project.nodes[reference.fromNodeId]) continue;
      const preserved = branch(reference.toNodeId);
      // A rescued ancestor must not rescue an explicitly deleted sub-branch.
      for (const root of roots) {
        if (preserved.has(root)) for (const id of branch(root)) preserved.delete(id);
      }
      // A descendant cannot be promoted into being its own ancestor.
      if (preserved.has(reference.fromNodeId)) continue;
      for (const id of preserved) deletedIds.delete(id);
      promotedArrowIds.add(reference.id);
      changed = true;
    }
  }
  for (const id of promotedArrowIds) {
    const candidate = project.arrows[id]!;
    if (arrows.some((arrow) => arrow.kind === 'auto' && arrow.toNodeId === candidate.toNodeId
      && !deletedIds.has(arrow.fromNodeId))) promotedArrowIds.delete(id);
  }
  return { deletedIds, promotedArrowIds };
}
