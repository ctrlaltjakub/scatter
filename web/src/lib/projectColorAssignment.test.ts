import { describe, expect, it } from 'vitest';
import type { Project } from '@/store/types';
import { GROUP_C, GROUP_L } from './groupColorAssign';
import { hexToOklch, oklchToHex } from './oklch';
import {
  GOLDEN_ANGLE_DEGREES,
  nextGoldenGroupColor,
  nextOppositesGroupColor,
  oppositesHueFraction,
  randomProjectColor,
  reassignProjectPalette,
} from './projectColorAssignment';

function project(): Project {
  return {
    id: 'p',
    name: 'Palette',
    createdAt: 1,
    updatedAt: 1,
    rootNodeId: 'root',
    nodes: {},
    arrows: {},
    groups: {
      newest: { id: 'newest', name: 'Newest', color: '#111111', gravitate: false },
      oldest: { id: 'oldest', name: 'Oldest', color: '#222222', gravitate: false },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
    color: '#333333',
  };
}

function circularDifference(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360 + 360) % 360);
  return raw > 180 ? 360 - raw : raw;
}

describe('project color assignment', () => {
  it('creates a random vivid project color and retains its exact source hue', () => {
    const generated = randomProjectColor(() => 0.25);
    expect(generated.hue).toBe(90);
    expect(generated.color).toBe(oklchToHex(GROUP_L, GROUP_C, 90));
  });

  it('advances from the persisted cursor rather than visible group colors', () => {
    const generated = nextGoldenGroupColor({
      ...project(),
      goldenColorCursorHue: 350,
      groups: {
        edited: { id: 'edited', name: 'Edited', color: '#ff0000', gravitate: false },
      },
    });
    expect(generated.cursorHue).toBeCloseTo(
      (350 + GOLDEN_ANGLE_DEGREES) % 360,
      10,
    );
  });

  it('slices the hue wheel into successive opposite halves', () => {
    expect(Array.from({ length: 8 }, (_, index) => oppositesHueFraction(index)))
      .toEqual([0, 0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875]);

    const generated = nextOppositesGroupColor({
      ...project(),
      oppositesColorBaseHue: 20,
      oppositesColorCursorIndex: 3,
      groups: {
        edited: { id: 'edited', name: 'Edited', color: '#000000', gravitate: false },
      },
    });
    expect(generated.cursorIndex).toBe(4);
    expect(generated.baseHue).toBe(20);
    expect(generated.color).toBe(oklchToHex(GROUP_L, GROUP_C, 65));
  });

  it('reassigns opposites as 180°, 90°, then 270° from the project', () => {
    const source = project();
    source.groups.third = {
      id: 'third',
      name: 'Third',
      color: '#333333',
      gravitate: false,
    };
    const reassigned = reassignProjectPalette(source, 'opposites', () => 0);
    expect(reassigned.color).toBe(oklchToHex(GROUP_L, GROUP_C, 0));
    expect(Object.values(reassigned.groups).map((group) => group.color))
      .toEqual([180, 90, 270].map((hue) => oklchToHex(GROUP_L, GROUP_C, hue)));
    expect(reassigned.oppositesColorCursorIndex).toBe(3);
  });

  it('reassigns the project and groups in sidebar top-to-bottom order', () => {
    const reassigned = reassignProjectPalette(project(), 'golden-angle', () => 0);
    expect(Object.keys(reassigned.groups)).toEqual(['newest', 'oldest']);
    expect(reassigned.color).toBe(oklchToHex(GROUP_L, GROUP_C, 0));
    expect(reassigned.groups.newest!.color).toBe(oklchToHex(GROUP_L, GROUP_C, GOLDEN_ANGLE_DEGREES));
    expect(reassigned.groups.oldest!.color).toBe(oklchToHex(GROUP_L, GROUP_C, GOLDEN_ANGLE_DEGREES * 2));
    expect(reassigned.goldenColorCursorHue).toBeCloseTo(
      GOLDEN_ANGLE_DEGREES * 2,
      10,
    );
  });

  it('retains every group record under hierarchy-aware reassignment', () => {
    const reassigned = reassignProjectPalette(project(), 'hierarchy-aware', () => 0.2);
    expect(Object.keys(reassigned.groups)).toEqual(['newest', 'oldest']);
    expect(reassigned.groups.newest!.name).toBe('Newest');
    expect(reassigned.groups.oldest!.name).toBe('Oldest');
    expect(reassigned.goldenColorCursorHue).toBeCloseTo(72, 10);
  });

  it('rebuilds hierarchy colors from relationships rather than stale colors', () => {
    const hierarchical: Project = {
      ...project(),
      rootNodeId: 'root',
      nodes: {
        root: node('root'),
        parent: node('parent', 'parent-group'),
        child: node('child', 'child-group'),
        other: node('other', 'other-group'),
      },
      arrows: {
        rp: arrow('rp', 'root', 'parent'),
        pc: arrow('pc', 'parent', 'child'),
        ro: arrow('ro', 'root', 'other'),
      },
      // Child deliberately precedes its parent in sidebar order.
      groups: {
        'child-group': group('child-group', '#ff0000'),
        'other-group': group('other-group', '#00ff00'),
        'parent-group': group('parent-group', '#0000ff'),
      },
    };
    const alternate = {
      ...hierarchical,
      groups: {
        'child-group': group('child-group', '#010101'),
        'other-group': group('other-group', '#020202'),
        'parent-group': group('parent-group', '#030303'),
      },
    };
    const first = reassignProjectPalette(hierarchical, 'hierarchy-aware', () => 0.25);
    const second = reassignProjectPalette(alternate, 'hierarchy-aware', () => 0.25);

    expect(first.groups).toEqual(second.groups);
    const parentHue = hexToOklch(first.groups['parent-group']!.color).h;
    const childHue = hexToOklch(first.groups['child-group']!.color).h;
    const otherHue = hexToOklch(first.groups['other-group']!.color).h;
    expect(circularDifference(childHue, parentHue))
      .toBeLessThan(circularDifference(childHue, otherHue));
  });
});

function node(id: string, groupId?: string): Project['nodes'][string] {
  return {
    id,
    type: 'manual-empty',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [],
    currentVersionIndex: 0,
    ...(groupId ? { groupId } : {}),
  };
}

function arrow(
  id: string,
  fromNodeId: string,
  toNodeId: string,
): Project['arrows'][string] {
  return { id, fromNodeId, toNodeId, kind: 'auto' };
}

function group(id: string, color: string): Project['groups'][string] {
  return { id, name: id, color, gravitate: false };
}
