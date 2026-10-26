import type {
  Group,
  GroupColorAssignment,
  Project,
} from '@/store/types';
import {
  GROUP_C,
  GROUP_L,
  assignGroupColorHex,
  hexToHue,
} from './groupColorAssign';
import { deriveGroupParentIds } from './groupHierarchy';
import { resolveColorHex } from './groupColor';
import { hexToOklch, oklchToHex } from './oklch';

/** The smaller golden-angle rotation, distributed evenly around a hue ring. */
export const GOLDEN_ANGLE_DEGREES = 137.50776405003785;

export interface GeneratedProjectColor {
  color: string;
  hue: number;
}

export interface GeneratedGoldenGroupColor {
  color: string;
  cursorHue: number;
}

export interface GeneratedOppositesGroupColor {
  color: string;
  baseHue: number;
  cursorIndex: number;
}

export interface ReassignedProjectPalette {
  color: string;
  groups: Record<string, Group>;
  goldenColorCursorHue: number;
  oppositesColorBaseHue: number;
  oppositesColorCursorIndex: number;
}

export function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

export function randomProjectColor(
  rng: () => number = Math.random,
): GeneratedProjectColor {
  const hue = normalizeHue((((rng() % 1) + 1) % 1) * 360);
  return {
    hue,
    color: oklchToHex(GROUP_L, GROUP_C, hue),
  };
}

function initialGoldenCursor(project: Project, rng: () => number): number {
  if (
    typeof project.goldenColorCursorHue === 'number'
    && Number.isFinite(project.goldenColorCursorHue)
  ) {
    return normalizeHue(project.goldenColorCursorHue);
  }
  if (project.color) {
    return normalizeHue(hexToOklch(resolveColorHex(project.color)).h);
  }
  return randomProjectColor(rng).hue;
}

/** Generate the next vivid hue without consulting visible group colors. */
export function nextGoldenGroupColor(
  project: Project,
  rng: () => number = Math.random,
): GeneratedGoldenGroupColor {
  const cursorHue = normalizeHue(
    initialGoldenCursor(project, rng) + GOLDEN_ANGLE_DEGREES,
  );
  return {
    cursorHue,
    color: oklchToHex(GROUP_L, GROUP_C, cursorHue),
  };
}

/** Base-2 radical-inverse order: 1/2, 1/4, 3/4, 1/8, 5/8, 3/8, 7/8… */
export function oppositesHueFraction(index: number): number {
  let n = Math.max(0, Math.floor(index));
  let fraction = 0;
  let place = 0.5;
  while (n > 0) {
    fraction += (n % 2) * place;
    n = Math.floor(n / 2);
    place *= 0.5;
  }
  return fraction;
}

function initialOppositesBaseHue(project: Project, rng: () => number): number {
  if (
    typeof project.oppositesColorBaseHue === 'number'
    && Number.isFinite(project.oppositesColorBaseHue)
  ) {
    return normalizeHue(project.oppositesColorBaseHue);
  }
  if (project.color) {
    return normalizeHue(hexToOklch(resolveColorHex(project.color)).h);
  }
  return randomProjectColor(rng).hue;
}

/** Emit the next binary pie slice without consulting edited/deleted colors. */
export function nextOppositesGroupColor(
  project: Project,
  rng: () => number = Math.random,
): GeneratedOppositesGroupColor {
  const baseHue = initialOppositesBaseHue(project, rng);
  const previousIndex = typeof project.oppositesColorCursorIndex === 'number'
    && Number.isFinite(project.oppositesColorCursorIndex)
    ? Math.max(0, Math.floor(project.oppositesColorCursorIndex))
    : 0;
  const cursorIndex = previousIndex + 1;
  const hue = normalizeHue(baseHue + oppositesHueFraction(cursorIndex) * 360);
  return {
    baseHue,
    cursorIndex,
    color: oklchToHex(GROUP_L, GROUP_C, hue),
  };
}

function hierarchyDepth(
  groupId: string,
  parentIds: Readonly<Record<string, string | null>>,
): number {
  let depth = 0;
  let current = parentIds[groupId] ?? null;
  const seen = new Set([groupId]);
  while (current && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = parentIds[current] ?? null;
  }
  return current ? 0 : depth;
}

function hierarchyFamilyAnchor(
  groupId: string,
  parentIds: Readonly<Record<string, string | null>>,
): string {
  let current = groupId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parentIds[current];
    if (!parent) return current;
    current = parent;
  }
  return groupId;
}

/** Rebuild hierarchy colors entirely from relationship metadata and newly
 * assigned colors. No previous group color participates. */
function reassignHierarchyGroups(
  project: Project,
  baseColor: string,
  rng: () => number,
): Record<string, Group> {
  const groupIds = Object.keys(project.groups);
  const sidebarIndex = new Map(groupIds.map((id, index) => [id, index]));
  const parentIds = deriveGroupParentIds(project);
  const generationOrder = [...groupIds].sort((a, b) => (
    hierarchyDepth(a, parentIds) - hierarchyDepth(b, parentIds)
    || sidebarIndex.get(a)! - sidebarIndex.get(b)!
  ));
  const firstGenerationIds = groupIds.filter((id) => !parentIds[id]);
  const projectHue = hexToHue(baseColor);
  const assigned = new Map<string, { color: string; hue: number }>();

  for (const groupId of generationOrder) {
    const used = [...assigned.values()].map((entry) => entry.hue);
    const firstGenHues = [
      projectHue,
      ...firstGenerationIds.flatMap((id) => {
        const entry = assigned.get(id);
        return entry ? [entry.hue] : [];
      }),
    ];
    const parentId = parentIds[groupId];
    const parent = parentId ? assigned.get(parentId) : undefined;
    let color: string;

    if (!parent || !parentId) {
      color = assignGroupColorHex({
        used,
        blocked: [projectHue],
        firstGenHues,
        rng,
      });
    } else {
      const anchorId = hierarchyFamilyAnchor(parentId, parentIds);
      const anchor = assigned.get(anchorId)?.hue ?? parent.hue;
      const siblings = [...assigned.entries()]
        .filter(([id]) => parentIds[id] === parentId)
        .map(([, entry]) => entry.hue);
      const otherAnchors = firstGenerationIds
        .filter((id) => id !== anchorId)
        .flatMap((id) => {
          const entry = assigned.get(id);
          return entry ? [entry.hue] : [];
        });
      color = assignGroupColorHex({
        used,
        blocked: [projectHue],
        firstGenHues,
        relative: parent.hue,
        siblings,
        familyAnchor: anchor,
        otherAnchors,
        rng,
      });
    }
    assigned.set(groupId, { color, hue: hexToHue(color) });
  }

  const groups: Record<string, Group> = {};
  for (const groupId of groupIds) {
    groups[groupId] = {
      ...project.groups[groupId]!,
      color: assigned.get(groupId)!.color,
    };
  }
  return groups;
}

/**
 * Rebuild the active project's palette in its current sidebar order.
 * Object key order is the sidebar order because reorderGroup reconstructs this
 * record deliberately and new groups are prepended to it.
 */
export function reassignProjectPalette(
  project: Project,
  assignment: GroupColorAssignment,
  rng: () => number = Math.random,
): ReassignedProjectPalette {
  const base = randomProjectColor(rng);
  const groupIds = Object.keys(project.groups);

  if (assignment === 'opposites') {
    const groups: Record<string, Group> = {};
    for (let index = 0; index < groupIds.length; index += 1) {
      const groupId = groupIds[index]!;
      const cursorIndex = index + 1;
      const hue = normalizeHue(
        base.hue + oppositesHueFraction(cursorIndex) * 360,
      );
      groups[groupId] = {
        ...project.groups[groupId]!,
        color: oklchToHex(GROUP_L, GROUP_C, hue),
      };
    }
    return {
      color: base.color,
      groups,
      goldenColorCursorHue: base.hue,
      oppositesColorBaseHue: base.hue,
      oppositesColorCursorIndex: groupIds.length,
    };
  }

  if (assignment === 'golden-angle') {
    let cursorHue = base.hue;
    const groups: Record<string, Group> = {};
    for (const groupId of groupIds) {
      cursorHue = normalizeHue(cursorHue + GOLDEN_ANGLE_DEGREES);
      groups[groupId] = {
        ...project.groups[groupId]!,
        color: oklchToHex(GROUP_L, GROUP_C, cursorHue),
      };
    }
    return {
      color: base.color,
      groups,
      goldenColorCursorHue: cursorHue,
      oppositesColorBaseHue: base.hue,
      oppositesColorCursorIndex: 0,
    };
  }

  return {
    color: base.color,
    groups: reassignHierarchyGroups(project, base.color, rng),
    goldenColorCursorHue: base.hue,
    oppositesColorBaseHue: base.hue,
    oppositesColorCursorIndex: 0,
  };
}
