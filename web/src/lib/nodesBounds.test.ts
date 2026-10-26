import { describe, it, expect } from 'vitest';
import { computeNodesBBox } from './nodesBounds';
import type { Project, ScatterNode } from '@/store/types';

function node(id: string, x: number, y: number, width?: number, renderedHeight?: number): ScatterNode {
  return {
    id, type: 'manual-empty', position: { x, y }, frozen: false,
    // Width is a per-version field now (nodeWidth reads the current version).
    versions: [{ header: '', body: '', createdAt: 0, generatedBy: 'manual', ...(width !== undefined ? { width } : {}) }],
    currentVersionIndex: 0,
    ...(renderedHeight !== undefined ? { renderedHeight } : {}),
  };
}
function project(nodes: ScatterNode[]): Project {
  return {
    id: 'p', name: 'P', createdAt: 1, updatedAt: 1, rootNodeId: '',
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    arrows: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
  };
}

describe('computeNodesBBox', () => {
  it('returns null for an empty project', () => {
    expect(computeNodesBBox(project([]), {})).toBeNull();
  });

  it('spans node rects using width + renderedHeight', () => {
    const bbox = computeNodesBBox(project([
      node('a', 0, 0, 100, 50),
      node('b', 200, 100, 100, 50),
    ]), {});
    expect(bbox).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 150 });
  });

  it('prefers live positions over committed node.position', () => {
    const bbox = computeNodesBBox(
      project([node('a', 0, 0, 100, 50)]),
      { a: { x: 500, y: 500 } },
    );
    expect(bbox).toEqual({ minX: 500, minY: 500, maxX: 600, maxY: 550 });
  });
});
