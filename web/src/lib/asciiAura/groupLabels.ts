import { SpatialHash } from '@/physics/spatialHash';
import {
  buildLabelCells,
  labelWrapCandidates,
  sanitizeHeader,
  segIntersectsRect,
  type LabelCell,
  type Segment,
} from './arrowLabels';
import { AURA_RADIUS_UNFOCUSED, type Rect } from './sceneState';

export const GROUP_LABEL_ZOOM_THRESHOLD = 0.35;
export const GROUP_LABEL_MAX_CHARS = 32;
export const GROUP_LABEL_MAX_LINES = 2;
export const GROUP_LABEL_CONTINUATION = '~';

export type GroupLabelTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' };

/** Runtime-only family key; cannot collide with persisted group UUIDs. */
export function projectUngroupedClusterKey(projectId: string): string {
  return `\u0000project:${projectId}:ungrouped`;
}

export interface GroupClusterNode {
  id: string;
  groupId: string;
  target?: GroupLabelTarget;
  rect: Rect;
}

export interface GroupCluster {
  id: string;
  groupId: string;
  target: GroupLabelTarget;
  memberIds: string[];
  members: GroupClusterNode[];
  rect: Rect;
}

export interface GroupLabelPlacement {
  clusterId: string;
  groupId: string;
  target: GroupLabelTarget;
  text: string;
  lines: string[];
  colorSourceNodeId: string;
  memberNodeIds: string[];
  rect: Rect;
  cells: LabelCell[];
}

export function groupLabelMode(zoom: number): 'group' | 'arrow' {
  return zoom < GROUP_LABEL_ZOOM_THRESHOLD ? 'group' : 'arrow';
}

export function sanitizeGroupLabel(raw: string): string {
  const text = sanitizeHeader(raw);
  if (text.length <= GROUP_LABEL_MAX_CHARS) return text;
  const contentBudget = GROUP_LABEL_MAX_CHARS - GROUP_LABEL_CONTINUATION.length;
  let prefix = text.slice(0, contentBudget);
  const next = text[contentBudget];
  const last = prefix[prefix.length - 1];
  // If the cap cuts through a word, retreat to the preceding complete word.
  if (next && last && !/\s/.test(next) && !/\s/.test(last)) {
    const boundary = prefix.lastIndexOf(' ');
    if (boundary > 0) prefix = prefix.slice(0, boundary);
  }

  const cleanTail = (value: string): string => {
    let cleaned = value.trimEnd().replace(/[\p{P}\p{S}]+$/u, '').trimEnd();
    while (/\s(?:A|AN|THE)$/.test(cleaned)) {
      cleaned = cleaned.replace(/\s(?:A|AN|THE)$/, '').trimEnd();
      cleaned = cleaned.replace(/[\p{P}\p{S}]+$/u, '').trimEnd();
    }
    return cleaned;
  };
  prefix = cleanTail(prefix);
  // A single unusually long word has no boundary to retreat to. Keep a hard
  // cap rather than returning an empty label.
  if (!prefix) prefix = text.slice(0, contentBudget).trimEnd();
  return prefix + GROUP_LABEL_CONTINUATION;
}

function rectGap(a: Rect, b: Rect): number {
  const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
  const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
  return Math.hypot(gapX, gapY);
}

function unionRects(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Connected components of same-group cards whose 200px aura regions touch. */
export function computeGroupClusters(
  nodes: readonly GroupClusterNode[],
  auraRadius = AURA_RADIUS_UNFOCUSED,
): GroupCluster[] {
  const byGroup = new Map<string, GroupClusterNode[]>();
  for (const node of nodes) {
    if (!node.groupId) continue;
    const list = byGroup.get(node.groupId);
    if (list) list.push(node);
    else byGroup.set(node.groupId, [node]);
  }

  const joinDistance = auraRadius * 2;
  const clusters: GroupCluster[] = [];
  const sortedGroups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [groupId, unsorted] of sortedGroups) {
    const groupNodes = [...unsorted].sort((a, b) => a.id.localeCompare(b.id));
    const parent = groupNodes.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root]!;
      while (parent[i] !== i) {
        const next = parent[i]!;
        parent[i] = root;
        i = next;
      }
      return root;
    };
    const unite = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const index = new SpatialHash<number>(Math.max(1, joinDistance));
    for (let i = 0; i < groupNodes.length; i++) {
      const rect = groupNodes[i]!.rect;
      index.insert(i, rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    }
    const candidates: number[] = [];
    const seen = new Int32Array(groupNodes.length);
    let queryId = 0;
    for (let i = 0; i < groupNodes.length; i++) {
      queryId++;
      candidates.length = 0;
      const rect = groupNodes[i]!.rect;
      index.query(
        rect.x - joinDistance,
        rect.y - joinDistance,
        rect.x + rect.w + joinDistance,
        rect.y + rect.h + joinDistance,
        candidates,
      );
      for (const j of candidates) {
        if (j <= i || seen[j] === queryId) continue;
        seen[j] = queryId;
        if (rectGap(rect, groupNodes[j]!.rect) <= joinDistance) unite(i, j);
      }
    }

    const components = new Map<number, GroupClusterNode[]>();
    for (let i = 0; i < groupNodes.length; i++) {
      const root = find(i);
      const component = components.get(root);
      if (component) component.push(groupNodes[i]!);
      else components.set(root, [groupNodes[i]!]);
    }
    for (const members of components.values()) {
      const memberIds = members.map((member) => member.id).sort();
      clusters.push({
        id: `${groupId}:${memberIds.join('|')}`,
        groupId,
        target: groupNodes[0]?.target ?? { kind: 'group', groupId },
        memberIds,
        members: [...members].sort((a, b) => a.id.localeCompare(b.id)),
        rect: unionRects(members.map((member) => member.rect)),
      });
    }
  }
  return clusters.sort((a, b) => a.id.localeCompare(b.id));
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

function gridCandidates(min: number, max: number, preferred: number, cellPx: number): number[] {
  if (min > max) return [];
  const values: number[] = [];
  for (let value = Math.ceil(min / cellPx) * cellPx; value <= max + 0.001; value += cellPx) {
    values.push(value);
  }
  values.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);
  return values;
}

export interface GroupLabelInput {
  clusters: readonly GroupCluster[];
  groupNameOf: (groupId: string) => string;
  viewport: { x: number; y: number; zoom: number };
  screenW: number;
  screenH: number;
  cellPx: number;
  leftInsetPx: number;
  reserved: readonly Rect[];
  segments: readonly Segment[];
  gapPx?: number;
  marginPx?: number;
  segClearancePx?: number;
}

/** Place visible group-cluster labels in screen space, largest clusters first. */
export function computeGroupLabels(input: GroupLabelInput): GroupLabelPlacement[] {
  const {
    viewport, screenW, screenH, cellPx,
    leftInsetPx, groupNameOf,
  } = input;
  const gap = input.gapPx ?? cellPx * 1.5;
  const margin = input.marginPx ?? 4;
  const segClearance = input.segClearancePx ?? cellPx * 0.5;
  const drawable: Rect = {
    x: leftInsetPx,
    y: 0,
    w: Math.max(0, screenW - leftInsetPx),
    h: screenH,
  };
  const reserved = [...input.reserved];

  type VisibleCluster = { cluster: GroupCluster; visibleBounds: Rect; visibleMembers: number };
  const visibleClusters: VisibleCluster[] = [];
  for (const cluster of input.clusters) {
    const visibleRects: Rect[] = [];
    for (const member of cluster.members) {
      const screenRect: Rect = {
        x: member.rect.x * viewport.zoom + viewport.x,
        y: member.rect.y * viewport.zoom + viewport.y,
        w: member.rect.w * viewport.zoom,
        h: member.rect.h * viewport.zoom,
      };
      const visible = intersect(screenRect, drawable);
      if (visible) visibleRects.push(visible);
    }
    if (visibleRects.length === 0) continue;
    visibleClusters.push({
      cluster,
      visibleBounds: unionRects(visibleRects),
      visibleMembers: visibleRects.length,
    });
  }
  visibleClusters.sort((a, b) =>
    b.visibleMembers - a.visibleMembers
    || b.cluster.memberIds.length - a.cluster.memberIds.length
    || a.cluster.id.localeCompare(b.cluster.id));

  const out: GroupLabelPlacement[] = [];
  for (const { cluster, visibleBounds } of visibleClusters) {
    const text = sanitizeGroupLabel(groupNameOf(cluster.groupId));
    if (!text) continue;
    const wraps = labelWrapCandidates(text, GROUP_LABEL_MAX_CHARS, GROUP_LABEL_MAX_LINES);
    if (wraps.length === 0) continue;

    let chosen: { lines: string[]; rect: Rect } | null = null;
    for (const side of ['above', 'below'] as const) {
      for (const lines of wraps) {
        const widthCols = Math.max(...lines.map((line) => line.length));
        const boxW = widthCols * cellPx;
        const boxH = lines.length * cellPx;
        const preferredX = visibleBounds.x + visibleBounds.w / 2 - boxW / 2;
        // Keep the label's centre over the visible cluster while permitting its
        // edges to extend sideways, then clamp the whole box to the viewport.
        const minX = Math.max(leftInsetPx + margin, visibleBounds.x - boxW / 2);
        const maxX = Math.min(screenW - margin - boxW, visibleBounds.x + visibleBounds.w - boxW / 2);
        const yRaw = side === 'above'
          ? visibleBounds.y - gap - boxH
          : visibleBounds.y + visibleBounds.h + gap;
        const y = side === 'above'
          ? Math.floor(yRaw / cellPx) * cellPx
          : Math.ceil(yRaw / cellPx) * cellPx;
        for (const x of gridCandidates(minX, maxX, preferredX, cellPx)) {
          const rect = { x, y, w: boxW, h: boxH };
          if (
            rect.x < leftInsetPx + margin
            || rect.y < margin
            || rect.x + rect.w > screenW - margin
            || rect.y + rect.h > screenH - margin
          ) continue;
          if (reserved.some((blocked) => overlap(rect, blocked))) continue;
          if (input.segments.some((segment) => segIntersectsRect(segment, rect, segClearance))) continue;
          chosen = { lines, rect };
          break;
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;

    const cells = buildLabelCells({
      lines: chosen.lines,
      boxX: chosen.rect.x,
      boxY: chosen.rect.y,
      cellPx,
      viewport,
    });
    reserved.push(chosen.rect);
    out.push({
      clusterId: cluster.id,
      groupId: cluster.groupId,
      target: cluster.target,
      text,
      lines: chosen.lines,
      colorSourceNodeId: cluster.memberIds[0]!,
      memberNodeIds: cluster.memberIds,
      rect: chosen.rect,
      cells,
    });
  }
  return out;
}
