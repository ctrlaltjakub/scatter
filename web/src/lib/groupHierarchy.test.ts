import { describe, it, expect } from 'vitest';
import type { Project, ScatterNode, Arrow, Group } from '@/store/types';
import {
  deriveColorInputs,
  deriveGroupParentIds,
  ensureProjectColor,
} from './groupHierarchy';
import { oklchToHex } from './oklch';
import {
  GROUP_L, GROUP_C, HUE_MARGIN, hexToHue,
} from './groupColorAssign';

// Legacy palettes remain valid inputs after changing the automatic chroma.
const hueHex = (h: number) => oklchToHex(GROUP_L, 0.125, h);
const circHue = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

function node(id: string, groupId?: string): ScatterNode {
  return {
    id, type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header: id, body: '', createdAt: 0, generatedBy: 'manual' }],
    currentVersionIndex: 0, ...(groupId ? { groupId } : {}),
  };
}
function arrow(from: string, to: string): Arrow {
  return { id: `${from}->${to}`, fromNodeId: from, toNodeId: to, kind: 'auto' };
}
function group(id: string, h: number): Group {
  return { id, name: id, color: hueHex(h), gravitate: false };
}
/** Build a project from node→group map and parent→child edges (root is 'r'). */
function proj(opts: {
  nodes: Record<string, string | undefined>;   // nodeId -> groupId
  edges: [string, string][];
  groups: Record<string, number>;               // groupId -> hue
  color?: string;                               // project base color (hex)
}): Project {
  const nodes: Record<string, ScatterNode> = { r: node('r') };
  for (const [id, gid] of Object.entries(opts.nodes)) nodes[id] = node(id, gid);
  const arrows: Record<string, Arrow> = {};
  for (const [f, t] of opts.edges) { const a = arrow(f, t); arrows[a.id] = a; }
  const groups: Record<string, Group> = {};
  for (const [gid, h] of Object.entries(opts.groups)) groups[gid] = group(gid, h);
  return {
    id: 'p', name: 'p', createdAt: 0, updatedAt: 0, rootNodeId: 'r',
    nodes, arrows, groups, viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
    ...(opts.color ? { color: opts.color } : {}),
  };
}

describe('deriveColorInputs', () => {
  it('a new group with no grouped ancestor/descendant is first-generation', () => {
    // r → a(g1), r → b(g2); new group seeded on c (also under r, ungrouped)
    const p = proj({
      nodes: { a: 'g1', b: 'g2', c: undefined },
      edges: [['r', 'a'], ['r', 'b'], ['r', 'c']],
      groups: { g1: 30, g2: 150 },
    });
    const inp = deriveColorInputs(p, 'c');
    expect(inp.relative ?? null).toBeNull();                 // first-gen
    expect((inp.firstGenHues ?? []).map(Math.round).sort((x, y) => x - y)).toEqual([30, 150]);
  });

  it('a child group sits near its ancestor group (vertical kin)', () => {
    // r → a(g1) → b(ungrouped); new group on b → relative = g1
    const p = proj({
      nodes: { a: 'g1', b: undefined },
      edges: [['r', 'a'], ['a', 'b']],
      groups: { g1: 40 },
    });
    const inp = deriveColorInputs(p, 'b');
    expect(inp.relative).toBeTruthy();
    expect(Math.round(inp.relative!)).toBe(40);
  });

  it('re-parenting: a new group created ABOVE an existing one is coloured near it', () => {
    // r → a(ungrouped) → b(g2); new group on a → relative = g2 (descendant)
    const p = proj({
      nodes: { a: undefined, b: 'g2' },
      edges: [['r', 'a'], ['a', 'b']],
      groups: { g2: 200 },
    });
    const inp = deriveColorInputs(p, 'a');
    expect(inp.relative).toBeTruthy();
    expect(Math.round(inp.relative!)).toBe(200);
    // g2 is the new group's child, so it must NOT be listed as a sibling.
    expect(inp.siblings ?? []).toHaveLength(0);
  });
});

describe('deriveGroupParentIds', () => {
  it('reconstructs group families independently from their record order', () => {
    const p = proj({
      nodes: { child: 'child-group', parent: 'parent-group', other: 'other-group' },
      edges: [['r', 'parent'], ['parent', 'child'], ['r', 'other']],
      groups: { 'child-group': 20, 'other-group': 140, 'parent-group': 260 },
    });
    expect(deriveGroupParentIds(p)).toEqual({
      'child-group': 'parent-group',
      'other-group': null,
      'parent-group': null,
    });
  });
});

describe('deriveColorInputs — project base color', () => {
  it('injects the project color as blocked + a first-gen hue (first-gen path)', () => {
    const p = proj({
      nodes: { a: 'g1', b: 'g2', c: undefined },
      edges: [['r', 'a'], ['r', 'b'], ['r', 'c']],
      groups: { g1: 30, g2: 150 },
      color: hueHex(300),
    });
    const inp = deriveColorInputs(p, 'c');
    expect(inp.blocked).toHaveLength(1);
    expect(Math.round(inp.blocked![0]!)).toBe(300);
    expect((inp.firstGenHues ?? []).map(Math.round).sort((x, y) => x - y)).toEqual([30, 150, 300]);
  });

  it('injects blocked on the null-seed path too', () => {
    const p = proj({ nodes: {}, edges: [], groups: {}, color: hueHex(300) });
    const inp = deriveColorInputs(p, null);
    expect(inp.blocked).toHaveLength(1);
    expect(Math.round(inp.blocked![0]!)).toBe(300);
    expect((inp.firstGenHues ?? []).map(Math.round)).toEqual([300]);
  });

  it('injects blocked on the later-generation path', () => {
    const p = proj({
      nodes: { a: 'g1', b: undefined },
      edges: [['r', 'a'], ['a', 'b']],
      groups: { g1: 40 },
      color: hueHex(300),
    });
    const inp = deriveColorInputs(p, 'b');
    expect(inp.relative).toBeTruthy();               // still a later-gen input
    expect(inp.blocked).toHaveLength(1);
    expect(Math.round(inp.blocked![0]!)).toBe(300);
  });

  it('no project color → no blocked', () => {
    const p = proj({
      nodes: { a: 'g1', c: undefined },
      edges: [['r', 'a'], ['r', 'c']],
      groups: { g1: 30 },
    });
    expect(deriveColorInputs(p, 'c').blocked ?? []).toHaveLength(0);
    expect(deriveColorInputs(p, null).blocked ?? []).toHaveLength(0);
  });
});

describe('ensureProjectColor', () => {
  it('returns the SAME object when a color already exists (no autosave churn)', () => {
    const p = proj({ nodes: {}, edges: [], groups: {}, color: hueHex(120) });
    expect(ensureProjectColor(p)).toBe(p);
  });

  it('assigns a color that avoids existing group colors (lazy migration)', () => {
    const p = proj({
      nodes: { a: 'g1', b: 'g2' },
      edges: [['r', 'a'], ['r', 'b']],
      groups: { g1: 30, g2: 150 },
    });
    const out = ensureProjectColor(p, () => 0);
    expect(out).not.toBe(p);
    expect(out.color).toMatch(/^#[0-9a-f]{6}$/i);
    const hue = hexToHue(out.color!);
    for (const g of Object.values(p.groups)) {
      expect(circHue(hue, hexToHue(g.color as string))).toBeGreaterThanOrEqual(HUE_MARGIN);
    }
    // First-gen bisection: hues 30/150 leave the biggest gap around 270.
    expect(Math.min(circHue(hue, 30), circHue(hue, 150))).toBeGreaterThanOrEqual(100);
  });

  it('uses the fixed automatic chroma when the project has no groups', () => {
    const p = proj({ nodes: {}, edges: [], groups: {} });
    const out = ensureProjectColor(p, () => 0);
    expect(out.color).toBe(oklchToHex(GROUP_L, GROUP_C, 0));
  });
});
