import type { Project } from '@/store/types';
import type { LivePosition } from '@/store/useLivePositionsStore';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';

export interface NodesBBox { minX: number; minY: number; maxX: number; maxY: number; }

/**
 * World-space bounding box of all nodes, preferring live (physics) positions
 * over the committed snapshot so it frames what the user currently sees.
 * Returns null when there are no nodes. Shared by the minimap (extent + scale).
 */
export function computeNodesBBox(
  project: Project,
  livePositions: Record<string, LivePosition>,
): NodesBBox | null {
  const nodes = Object.values(project.nodes);
  if (nodes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const lp = livePositions[n.id];
    const x = lp?.x ?? n.position.x;
    const y = lp?.y ?? n.position.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + nodeWidth(n));
    maxY = Math.max(maxY, y + nodeRenderedH(n));
  }
  return { minX, minY, maxX, maxY };
}
