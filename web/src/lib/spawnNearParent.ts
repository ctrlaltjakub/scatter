import type { ImageQuestionContext, ScatterNode } from '@/store/types';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { DEFAULT_NODE_W, nodeWidth, estimatedNodeHeight } from './nodeSize';
import { findNodePlacement } from './nodePlacement';

/** Provisional reservation for pending cards. Canvas measures the actual card
 * before the worker chooses its final visible position against current nodes. */
export function spawnNearParent(parent: ScatterNode, allNodes: ScatterNode[], newW = DEFAULT_NODE_W, newH = 400,
  regions?: ImageQuestionContext['regions']): { x: number; y: number } {
  const positions = useLivePositionsStore.getState().positions;
  const rectOf = (node: ScatterNode) => ({ id: node.id, ...(positions[node.id] ?? node.position),
    width: nodeWidth(node), height: node.renderedHeight || estimatedNodeHeight(node) });
  const config = { ...DEFAULT_PHYSICS_CONFIG, ...useSettingsStore.getState().physicsConfig };
  return findNodePlacement(rectOf(parent), allNodes.map(rectOf), { width: newW, height: newH }, {
    gap: config.collidePadding * 2, restGap: config.linkDistance, regions,
  });
}
