import { describe, expect, it } from 'vitest';
import type { Arrow, Project, ScatterNode } from '@/store/types';
import {
  collectAutomaticBranchNodeIds,
  collectReferencedAssetIds,
  copyBranchIntoProject,
} from './projectBranch';

function node(
  id: string,
  x: number,
  y: number,
  options: Partial<ScatterNode> = {},
): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x, y },
    frozen: false,
    versions: [{ header: id, body: id, createdAt: 1, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
    ...options,
  };
}

function arrow(id: string, fromNodeId: string, toNodeId: string, kind: Arrow['kind']): Arrow {
  return { id, fromNodeId, toNodeId, kind };
}

function project(): Project {
  return {
    id: 'source',
    name: 'Source',
    createdAt: 1,
    updatedAt: 1,
    rootNodeId: 'outside',
    color: '#112233',
    nodes: {
      outside: node('outside', -100, 0, { type: 'root', frozen: true }),
      branch: node('branch', 100, 200, { groupId: 'g1' }),
      child: node('child', 250, 350, {
        groupId: 'g1',
        frozen: true,
        bulletsCollapsed: true,
        versions: [{
          header: 'child',
          body: 'child',
          createdAt: 2,
          generatedBy: 'term-click',
          media: { source: 'asset', kind: 'image', assetId: 'media-1' },
          imageContext: { sourceMedia: { source: 'asset', kind: 'image', assetId: 'question-image' }, regions: [] },
          imageGeneration: {
            providerId: 'p',
            model: 'm',
            prompt: 'p',
            promptSource: 'image-edit',
            sourceMedia: { source: 'asset', kind: 'image', assetId: 'source-1' },
          },
        }],
      }),
      grandchild: node('grandchild', 400, 300, { groupId: 'g2' }),
      dottedOnly: node('dottedOnly', 600, 300),
    },
    arrows: {
      incoming: arrow('incoming', 'outside', 'branch', 'auto'),
      a1: { ...arrow('a1', 'branch', 'child', 'auto'), anchors: [{ x: 100, y: 200 }, { x: 250, y: 350 }] },
      a2: arrow('a2', 'child', 'grandchild', 'auto'),
      dottedInside: arrow('dottedInside', 'branch', 'grandchild', 'dotted'),
      dottedOutside: arrow('dottedOutside', 'grandchild', 'dottedOnly', 'dotted'),
    },
    groups: {
      g1: { id: 'g1', name: 'One', color: '#445566', gravitate: true },
      g2: { id: 'g2', name: 'Two', color: '#778899', gravitate: false },
      unused: { id: 'unused', name: 'Unused', color: '#abcdef', gravitate: true },
    },
    viewport: { x: 20, y: 30, zoom: 0.5 },
    selection: ['outside'],
  };
}

function destination(): Project {
  return {
    id: 'fresh',
    name: 'Branch',
    createdAt: 5,
    updatedAt: 5,
    rootNodeId: 'branch',
    color: '#445566',
    nodes: {},
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
  };
}

describe('project branch copying', () => {
  it('collects only automatic descendants, transitively and inclusively', () => {
    expect([...collectAutomaticBranchNodeIds('branch', Object.values(project().arrows))].sort())
      .toEqual(['branch', 'child', 'grandchild']);
  });

  it('copies internal arrows, referenced groups, metadata, and relative geometry', () => {
    const copied = copyBranchIntoProject(project(), 'branch', destination());

    expect(Object.keys(copied.nodes).sort()).toEqual(['branch', 'child', 'grandchild']);
    expect(Object.keys(copied.arrows).sort()).toEqual(['a1', 'a2', 'dottedInside']);
    expect(Object.keys(copied.groups).sort()).toEqual(['g1', 'g2']);
    expect(copied.nodes.branch).toMatchObject({
      type: 'root',
      frozen: true,
      position: { x: 0, y: 0 },
    });
    expect(copied.nodes.branch?.groupId).toBeUndefined();
    expect(copied.nodes.child).toMatchObject({
      frozen: true,
      bulletsCollapsed: true,
      position: { x: 150, y: 150 },
    });
    expect(copied.arrows.a1?.anchors).toEqual([{ x: 0, y: 0 }, { x: 150, y: 150 }]);
    expect(copied.selection).toEqual(['branch']);
    expect(copied.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('collects attached media and image-generation source assets', () => {
    const copied = copyBranchIntoProject(project(), 'branch', destination());
    expect([...collectReferencedAssetIds(Object.values(copied.nodes))].sort())
      .toEqual(['media-1', 'question-image', 'source-1']);
  });

  it('does not share mutable content with the source project', () => {
    const source = project();
    const copied = copyBranchIntoProject(source, 'branch', destination());
    copied.nodes.child!.versions[0]!.body = 'changed';
    copied.groups.g1!.name = 'changed';
    expect(source.nodes.child!.versions[0]!.body).toBe('child');
    expect(source.groups.g1!.name).toBe('One');
  });
});
