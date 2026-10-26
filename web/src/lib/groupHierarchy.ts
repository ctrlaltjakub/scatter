import type { Project } from '@/store/types';
import { resolveColorHex } from './groupColor';
import { assignGroupColorHex, hexToHue, type AssignInput } from './groupColorAssign';

/**
 * Derive the colour-assignment inputs for a NEW group seeded at `seedNodeId`,
 * by reading the group hierarchy from the node tree (nothing is stored). The
 * root node is ungroupable, so it never appears as a group and relations never
 * cross it. Returns the {relative, siblings, familyAnchor, otherAnchors,
 * firstGenHues, used} that groupColorAssign needs.
 *
 * Vertical kinship: a group's parent is the nearest ANCESTOR node's group; its
 * children are the nearest descendant groups below it. First-generation groups
 * (no ancestor group) are mutual siblings. The re-parenting case — a new group
 * created ABOVE an existing one — colours the new group near that descendant.
 */

function parentNodeId(project: Project, nodeId: string): string | undefined {
  for (const a of Object.values(project.arrows)) {
    if (a.kind === 'auto' && a.toNodeId === nodeId) return a.fromNodeId;
  }
  return undefined;
}
function childNodeIds(project: Project, nodeId: string): string[] {
  const out: string[] = [];
  for (const a of Object.values(project.arrows)) {
    if (a.kind === 'auto' && a.fromNodeId === nodeId) out.push(a.toNodeId);
  }
  return out;
}

/** Nearest ancestor node's groupId (walking up auto-arrows), skipping `exclude`. */
function nearestAncestorGroup(project: Project, nodeId: string, exclude?: string): string | null {
  let cur = parentNodeId(project, nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const gid = project.nodes[cur]?.groupId;
    if (gid && gid !== exclude) return gid;
    cur = parentNodeId(project, cur);
  }
  return null;
}

/** Groups directly below `nodeId` (first group on each downward path). */
function descendantGroupsBelow(project: Project, nodeId: string, exclude?: string): string[] {
  const found = new Set<string>();
  const stack = [...childNodeIds(project, nodeId)];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const gid = project.nodes[id]?.groupId;
    if (gid && gid !== exclude) { found.add(gid); continue; } // stop at the first group
    stack.push(...childNodeIds(project, id));
  }
  return [...found];
}

function depthOf(project: Project, nodeId: string): number {
  let d = 0;
  let cur = parentNodeId(project, nodeId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); d++; cur = parentNodeId(project, cur); }
  return d;
}
function shallowestMember(project: Project, groupId: string): string | undefined {
  const members = Object.values(project.nodes).filter((n) => n.groupId === groupId);
  if (members.length === 0) return undefined;
  return members.reduce((best, n) => (depthOf(project, n.id) < depthOf(project, best.id) ? n : best)).id;
}
/** The vertical parent group of an existing group (or null if first-gen). */
function parentGroupOf(project: Project, groupId: string): string | null {
  const node = shallowestMember(project, groupId);
  if (!node) return null;
  return nearestAncestorGroup(project, node, groupId);
}

/** Relationship-only view of the current group tree. This deliberately does
 * not inspect colors, so a full palette rebuild can assign parents before
 * children without stale colors influencing the result. */
export function deriveGroupParentIds(
  project: Project,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const groupId of Object.keys(project.groups)) {
    const parentId = parentGroupOf(project, groupId);
    out[groupId] = parentId && parentId !== groupId && project.groups[parentId]
      ? parentId
      : null;
  }
  return out;
}

/** Climb parentGroupOf to the top of a group's chain → the first-gen anchor id. */
function familyAnchorId(project: Project, groupId: string): string {
  let cur = groupId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const p = parentGroupOf(project, cur);
    if (!p) return cur;
    cur = p;
  }
  return cur;
}

export function deriveColorInputs(project: Project, seedNodeId: string | null): AssignInput {
  const groups = Object.values(project.groups);
  const hueOf = (gid: string): number => hexToHue(resolveColorHex(project.groups[gid]!.color));
  const used = groups.map((g) => hexToHue(resolveColorHex(g.color)));

  // The project base color is off-limits to groups (blocked survives even the
  // assigner's exhaustion restart) and counts as a first-gen hue so the
  // bisection spreads new group colours away from it.
  const projectHue = project.color ? hexToHue(resolveColorHex(project.color)) : null;
  const blocked = projectHue !== null ? [projectHue] : undefined;

  // First-gen groups (no vertical parent) and their hues.
  const firstGenIds = groups.filter((g) => parentGroupOf(project, g.id) === null).map((g) => g.id);
  const firstGenHues = firstGenIds.map(hueOf);
  if (projectHue !== null) firstGenHues.push(projectHue);

  if (!seedNodeId) {
    // Blank new group with no seed → first-generation.
    return { firstGenHues, used, blocked };
  }

  const ancestorGid = nearestAncestorGroup(project, seedNodeId);
  const descendantGids = descendantGroupsBelow(project, seedNodeId);

  // Vertical relative to sit NEAR: prefer the ancestor group (the parent); else
  // the nearest descendant group (re-parenting — new group created above it).
  const relativeGid = ancestorGid ?? descendantGids[0] ?? null;
  if (!relativeGid) {
    return { firstGenHues, used, blocked }; // first-generation
  }

  // Siblings = groups sharing the new group's vertical parent (the ancestor),
  // excluding any descendant groups that will become this group's children.
  const newParent = ancestorGid; // null when the relative is a descendant (re-parent)
  const exclude = new Set(descendantGids);
  const siblings = groups
    .filter((g) => !exclude.has(g.id) && parentGroupOf(project, g.id) === newParent)
    .map((g) => hueOf(g.id));

  // In-family constraint anchors.
  const anchorId = newParent ? familyAnchorId(project, newParent) : relativeGid;
  const familyAnchor = hueOf(anchorId);
  const otherAnchors = firstGenIds
    .filter((gid) => gid !== anchorId)
    .map(hueOf);

  return {
    used,
    blocked,
    firstGenHues,
    relative: hueOf(relativeGid),
    siblings,
    familyAnchor,
    otherAnchors,
  };
}

/**
 * Lazy migration: give a color-less (pre-project-color) project a base color
 * on load. Picks a first-generation color aware of the project's existing
 * group colors (they land in `used`/`firstGenHues` via deriveColorInputs; no
 * `blocked` is injected since the project has no color yet). Projects that
 * already have a color pass through by REFERENCE — callers rely on that to
 * avoid autosave churn.
 */
export function ensureProjectColor(project: Project, rng?: () => number): Project {
  if (project.color) return project;
  return { ...project, color: assignGroupColorHex({ ...deriveColorInputs(project, null), rng }) };
}
