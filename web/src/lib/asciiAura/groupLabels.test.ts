import { describe, expect, it } from 'vitest';
import { statusGlyphIndex } from './statusText';
import {
  GROUP_LABEL_ZOOM_THRESHOLD,
  computeGroupClusters,
  computeGroupLabels,
  groupLabelMode,
  projectUngroupedClusterKey,
  sanitizeGroupLabel,
  type GroupClusterNode,
} from './groupLabels';

const node = (
  id: string,
  groupId: string,
  x: number,
  y: number,
  w = 100,
  h = 80,
): GroupClusterNode => ({ id, groupId, rect: { x, y, w, h } });

describe('computeGroupClusters', () => {
  it('joins nodes whose 200px auras touch', () => {
    const clusters = computeGroupClusters([
      node('a', 'g', 0, 0),
      node('b', 'g', 500, 0), // card gap = 400
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds).toEqual(['a', 'b']);
  });

  it('splits nodes whose auras do not touch and keeps singletons', () => {
    const clusters = computeGroupClusters([
      node('a', 'g', 0, 0),
      node('b', 'g', 501, 0),
    ]);
    expect(clusters.map((cluster) => cluster.memberIds)).toEqual([['a'], ['b']]);
  });

  it('uses transitive connectivity', () => {
    const clusters = computeGroupClusters([
      node('a', 'g', 0, 0),
      node('b', 'g', 500, 0),
      node('c', 'g', 1000, 0),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.memberIds).toEqual(['a', 'b', 'c']);
  });

  it('never joins nodes from different groups', () => {
    const clusters = computeGroupClusters([
      node('a', 'g1', 0, 0),
      node('b', 'g2', 0, 0),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.groupId).sort()).toEqual(['g1', 'g2']);
  });

  it('clusters ungrouped project-color nodes under a distinct runtime family', () => {
    const key = projectUngroupedClusterKey('project-a');
    const clusters = computeGroupClusters([
      { ...node('root', key, 0, 0), target: { kind: 'ungrouped' } },
      { ...node('loose', key, 500, 0), target: { kind: 'ungrouped' } },
      node('grouped', 'group-a', 0, 0),
    ]);
    const projectCluster = clusters.find((cluster) => cluster.groupId === key)!;
    expect(projectCluster.memberIds).toEqual(['loose', 'root']);
    expect(projectCluster.target).toEqual({ kind: 'ungrouped' });
    expect(clusters.find((cluster) => cluster.groupId === 'group-a')?.memberIds).toEqual(['grouped']);
  });

  it('uses Euclidean border distance for diagonally separated auras', () => {
    expect(computeGroupClusters([
      node('a', 'g', 0, 0),
      node('b', 'g', 400, 400), // 300×320 gap => ~438, so the auras do not touch
    ])).toHaveLength(2);
  });
});

describe('group label text and zoom mode', () => {
  it('normalizes and caps labels at 32 characters with a distinct continuation glyph', () => {
    expect(sanitizeGroupLabel('  long   group\nname ')).toBe('LONG GROUP NAME');
    const capped = sanitizeGroupLabel('abcdefghijklmnopqrstuvwxyz 123456789');
    expect(capped.length).toBeLessThanOrEqual(32);
    expect(capped).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ~');
    expect(statusGlyphIndex('~')).not.toBeNull();
  });

  it('does not leave an article or punctuation immediately before the continuation glyph', () => {
    expect(sanitizeGroupLabel('1234567890123456789012345 the remainder')).toBe(
      '1234567890123456789012345~',
    );
    expect(sanitizeGroupLabel('12345678901234567890123456789! more')).toBe(
      '12345678901234567890123456789~',
    );
    expect(sanitizeGroupLabel('12345678901234567890123456 an ending')).toBe(
      '12345678901234567890123456~',
    );
  });

  it('uses group labels only strictly below 35% zoom', () => {
    expect(groupLabelMode(GROUP_LABEL_ZOOM_THRESHOLD - 0.001)).toBe('group');
    expect(groupLabelMode(GROUP_LABEL_ZOOM_THRESHOLD)).toBe('arrow');
    expect(groupLabelMode(GROUP_LABEL_ZOOM_THRESHOLD + 0.001)).toBe('arrow');
  });
});

describe('computeGroupLabels', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const screen = { screenW: 1000, screenH: 800, cellPx: 10, leftInsetPx: 0 };
  const cluster = computeGroupClusters([node('a', 'g', 400, 300, 200, 100)])[0]!;
  const base = {
    clusters: [cluster],
    groupNameOf: () => 'A useful group',
    viewport,
    ...screen,
    reserved: [{ x: 400, y: 300, w: 200, h: 100 }],
    segments: [],
  };

  it('places one-line text above a cluster by default', () => {
    const placement = computeGroupLabels(base)[0]!;
    expect(placement.lines).toEqual(['A USEFUL GROUP']);
    expect(placement.rect.y + placement.rect.h).toBeLessThan(300);
    expect(placement.cells[0]!.glyphIndex).toBe(statusGlyphIndex('A'));
    expect(placement.colorSourceNodeId).toBe('a');
  });

  it('moves horizontally when the centered position is obstructed', () => {
    const centered = computeGroupLabels(base)[0]!;
    const shifted = computeGroupLabels({
      ...base,
      reserved: [
        ...base.reserved,
        { x: centered.rect.x + centered.rect.w / 2 - 10, y: centered.rect.y, w: 20, h: centered.rect.h },
      ],
    })[0]!;
    expect(shifted.rect.y).toBe(centered.rect.y);
    expect(shifted.rect.x).not.toBe(centered.rect.x);
  });

  it('wraps to two lines above before falling below', () => {
    const narrowCluster = computeGroupClusters([node('narrow', 'g', 65, 300, 50, 100)])[0]!;
    const placement = computeGroupLabels({
      ...base,
      clusters: [narrowCluster],
      groupNameOf: () => 'Alpha beta gamma delta',
      screenW: 180,
      reserved: [{ x: 65, y: 300, w: 50, h: 100 }],
    })[0]!;
    expect(placement.lines).toHaveLength(2);
    expect(placement.rect.y + placement.rect.h).toBeLessThanOrEqual(300);
  });

  it('falls below when every above candidate is blocked', () => {
    const placement = computeGroupLabels({
      ...base,
      reserved: [
        ...base.reserved,
        { x: 0, y: 0, w: 1000, h: 299 },
      ],
    })[0]!;
    expect(placement.rect.y).toBeGreaterThanOrEqual(400);
  });

  it('avoids arrow segments and disappears when neither side fits', () => {
    const labels = computeGroupLabels({
      ...base,
      reserved: [
        ...base.reserved,
        { x: 0, y: 0, w: 1000, h: 299 },
        { x: 0, y: 401, w: 1000, h: 399 },
      ],
      segments: [{ x1: 0, y1: 285, x2: 1000, y2: 285 }],
    });
    expect(labels).toEqual([]);
  });

  it('ignores fully off-screen clusters and respects the sidebar inset', () => {
    const offscreen = computeGroupClusters([node('off', 'g', -1000, -1000)])[0]!;
    expect(computeGroupLabels({ ...base, clusters: [offscreen] })).toEqual([]);

    const left = computeGroupClusters([node('left', 'g', 10, 300)])[0]!;
    const labels = computeGroupLabels({
      ...base,
      clusters: [left],
      leftInsetPx: 240,
      reserved: [{ x: 10, y: 300, w: 100, h: 80 }],
    });
    expect(labels).toEqual([]);
  });
});
