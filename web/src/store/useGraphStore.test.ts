import { describe, it, expect, beforeEach } from 'vitest';
import { useGraphStore, createBlankProject } from './useGraphStore';
import {
  GROUP_L, GROUP_C, HUE_MARGIN, hexToHue,
} from '@/lib/groupColorAssign';
import { oklchToHex } from '@/lib/oklch';
import { resolveColorHex } from '@/lib/groupColor';
import { GOLDEN_ANGLE_DEGREES } from '@/lib/projectColorAssignment';
import { useSettingsStore } from './useSettingsStore';

const circHue = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ groupColorAssignment: 'opposites' });
  useGraphStore.setState({
    project: createBlankProject('Test', 'root1'),
    selectedGroupId: null,
    lastInteractedGroupIds: {},
  });
});

function addNode(id: string, header: string) {
  useGraphStore.getState().addNode({
    id, type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    versions: [{ header, body: '', createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  });
}
function addArrow(id: string, from: string, to: string) {
  useGraphStore.getState().addArrow({ id, fromNodeId: from, toNodeId: to, kind: 'auto' });
}

describe('useGraphStore — undo', () => {
  it('undo restores deleted subtree', () => {
    addNode('a', 'A'); addNode('b', 'B'); addNode('c', 'C');
    addArrow('e1', 'a', 'b'); addArrow('e2', 'b', 'c');
    useGraphStore.getState().deleteNodeCascade('b');
    expect(Object.keys(useGraphStore.getState().project!.nodes).sort()).toEqual(['a']);
    useGraphStore.temporal.getState().undo();
    expect(Object.keys(useGraphStore.getState().project!.nodes).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('useGraphStore — idempotent node patches', () => {
  it('does not notify subscribers for an unchanged node patch', () => {
    addNode('a', 'A');
    const before = useGraphStore.getState().project;
    let notifications = 0;
    const unsubscribe = useGraphStore.subscribe(() => { notifications += 1; });

    useGraphStore.getState().updateNode('a', { frozen: false });

    unsubscribe();
    expect(useGraphStore.getState().project).toBe(before);
    expect(notifications).toBe(0);
  });

  it('does not notify subscribers for an unchanged current-version size', () => {
    addNode('a', 'A');
    const before = useGraphStore.getState().project;
    let notifications = 0;
    const unsubscribe = useGraphStore.subscribe(() => { notifications += 1; });

    useGraphStore.getState().setVersionSize('a', { width: undefined });

    unsubscribe();
    expect(useGraphStore.getState().project).toBe(before);
    expect(notifications).toBe(0);
  });
});

describe('useGraphStore — cascade delete', () => {
  it('deletes a leaf node and its incoming arrow', () => {
    addNode('a', 'A'); addNode('b', 'B'); addArrow('e1', 'a', 'b');
    useGraphStore.getState().deleteNodeCascade('b');
    const p = useGraphStore.getState().project!;
    expect(Object.keys(p.nodes).sort()).toEqual(['a']);
    expect(Object.keys(p.arrows)).toEqual([]);
  });

  it('cascades through descendants via auto arrows', () => {
    addNode('a', 'A'); addNode('b', 'B'); addNode('c', 'C'); addNode('d', 'D');
    addArrow('e1', 'a', 'b'); addArrow('e2', 'b', 'c'); addArrow('e3', 'b', 'd');
    useGraphStore.getState().deleteNodeCascade('b');
    const p = useGraphStore.getState().project!;
    expect(Object.keys(p.nodes).sort()).toEqual(['a']);
    expect(Object.keys(p.arrows)).toEqual([]);
  });

  it('does not cascade across dotted arrows', () => {
    addNode('a', 'A'); addNode('b', 'B');
    useGraphStore.getState().addArrow({
      id: 'd1', fromNodeId: 'a', toNodeId: 'b', kind: 'dotted',
    });
    useGraphStore.getState().deleteNodeCascade('a');
    const p = useGraphStore.getState().project!;
    // 'b' should remain because the only link to 'a' was dotted
    expect(Object.keys(p.nodes).sort()).toEqual(['b']);
    expect(Object.keys(p.arrows)).toEqual([]); // arrow 'd1' lost a side; we drop dangling arrows
  });
});

describe('useGraphStore — project base color', () => {
  it('createBlankProject seeds a hex color at the fixed automatic chroma', () => {
    const p = createBlankProject('T', 'r', () => 0.25);
    expect(p.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(p.color).toBe(oklchToHex(GROUP_L, GROUP_C, 90));
  });

  it('createBlankProject color is deterministic with an injected rng', () => {
    const a = createBlankProject('T', 'r', () => 0.5);
    const b = createBlankProject('T', 'r', () => 0.5);
    expect(a.color).toBe(b.color);
  });

  it('recolorProject sets the color, bumps updatedAt, and is undoable', () => {
    const before = useGraphStore.getState().project!;
    useGraphStore.getState().recolorProject('#aabbcc');
    const after = useGraphStore.getState().project!;
    expect(after.color).toBe('#aabbcc');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.color).toBe(before.color);
  });

  it('group auto-colors avoid the project color (blocked + spread away)', () => {
    useSettingsStore.setState({ groupColorAssignment: 'hierarchy-aware' });
    const base = createBlankProject('T', 'root1');
    const projColor = oklchToHex(GROUP_L, GROUP_C, 40);
    useGraphStore.setState({ project: { ...base, color: projColor } });
    const projHue = hexToHue(projColor);

    const id1 = useGraphStore.getState().createGroup('A');
    const id2 = useGraphStore.getState().createGroup('B');
    const p = useGraphStore.getState().project!;
    const g1 = hexToHue(resolveColorHex(p.groups[id1]!.color));
    const g2 = hexToHue(resolveColorHex(p.groups[id2]!.color));

    expect(circHue(g1, projHue)).toBeGreaterThanOrEqual(HUE_MARGIN);
    expect(circHue(g2, projHue)).toBeGreaterThanOrEqual(HUE_MARGIN);
    // Bisection treats the project color as a first-gen hue → the first
    // group lands roughly opposite it.
    expect(circHue(g1, projHue)).toBeGreaterThan(150);
  });
});

describe('useGraphStore — groups', () => {
  it('remembers group creation and grouped-node focus per project without entering project data', () => {
    const projectId = useGraphStore.getState().project!.id;
    const first = useGraphStore.getState().createGroup('First');
    expect(useGraphStore.getState().lastInteractedGroupIds[projectId]).toBe(first);

    addNode('grouped', 'Grouped');
    const second = useGraphStore.getState().createGroup('Second');
    useGraphStore.getState().assignNodeToGroup('grouped', first);
    expect(useGraphStore.getState().lastInteractedGroupIds[projectId]).toBe(first);

    useGraphStore.getState().selectGroup(second);
    useGraphStore.getState().setSelection(['grouped']);
    expect(useGraphStore.getState().lastInteractedGroupIds[projectId]).toBe(first);
    expect((useGraphStore.getState().project as unknown as Record<string, unknown>).lastInteractedGroupIds)
      .toBeUndefined();
  });

  it('falls back to the first surviving group when the remembered group is deleted', () => {
    const projectId = useGraphStore.getState().project!.id;
    const survivor = useGraphStore.getState().createGroup('Survivor');
    const removed = useGraphStore.getState().createGroup('Removed');
    expect(useGraphStore.getState().lastInteractedGroupIds[projectId]).toBe(removed);

    useGraphStore.getState().deleteGroup(removed);

    expect(useGraphStore.getState().lastInteractedGroupIds[projectId]).toBe(survivor);
  });

  it('createGroup returns an id, registers the group, defaults gravitate to false', () => {
    const id = useGraphStore.getState().createGroup('Friends');
    const g = useGraphStore.getState().project!.groups[id];
    expect(g).toBeDefined();
    expect(g!.name).toBe('Friends');
    expect(g!.gravitate).toBe(false);
    expect(g!.color).toBeDefined();
  });

  it('createGroup with no name uses fallback "Group N"', () => {
    useGraphStore.getState().createGroup();
    const groups = Object.values(useGraphStore.getState().project!.groups);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('Group 1');
    useGraphStore.getState().createGroup();
    const allNames = Object.values(useGraphStore.getState().project!.groups)
      .map((g) => g.name).sort();
    expect(allNames).toEqual(['Group 1', 'Group 2']);
  });

  it('createGroup picks distinct rotating colors for successive groups', () => {
    const id1 = useGraphStore.getState().createGroup('A');
    const id2 = useGraphStore.getState().createGroup('B');
    const g1 = useGraphStore.getState().project!.groups[id1]!;
    const g2 = useGraphStore.getState().project!.groups[id2]!;
    expect(g1.color).not.toBe(g2.color);
  });

  it('opposites assignment keeps slicing forward after recoloring and deletion', () => {
    useGraphStore.setState({
      project: {
        ...createBlankProject('Opposites', 'root1'),
        oppositesColorBaseHue: 30,
        oppositesColorCursorIndex: 0,
      },
    });
    const first = useGraphStore.getState().createGroup('First');
    expect(useGraphStore.getState().project!.oppositesColorCursorIndex).toBe(1);
    useGraphStore.getState().recolorGroup(first, '#000000');
    useGraphStore.getState().deleteGroup(first);
    useGraphStore.getState().createGroup('Second');
    expect(useGraphStore.getState().project!.oppositesColorCursorIndex).toBe(2);
  });

  it('golden assignment advances from the cursor and ignores recoloring and deletion', () => {
    useSettingsStore.setState({ groupColorAssignment: 'golden-angle' });
    useGraphStore.setState({
      project: {
        ...createBlankProject('Golden', 'root1'),
        goldenColorCursorHue: 20,
      },
    });
    const first = useGraphStore.getState().createGroup('First');
    const afterFirst = useGraphStore.getState().project!;
    expect(afterFirst.goldenColorCursorHue).toBeCloseTo(
      (20 + GOLDEN_ANGLE_DEGREES) % 360,
      10,
    );

    useGraphStore.getState().recolorGroup(first, '#000000');
    useGraphStore.getState().deleteGroup(first);
    const cursorBeforeSecond = useGraphStore.getState().project!.goldenColorCursorHue!;
    useGraphStore.getState().createGroup('Second');
    expect(useGraphStore.getState().project!.goldenColorCursorHue).toBeCloseTo(
      (cursorBeforeSecond + GOLDEN_ANGLE_DEGREES) % 360,
      10,
    );
  });

  it('explicit colors and hierarchy-aware assignment leave the golden cursor unchanged', () => {
    useSettingsStore.setState({ groupColorAssignment: 'golden-angle' });
    useGraphStore.setState({
      project: {
        ...createBlankProject('Mixed', 'root1'),
        goldenColorCursorHue: 45,
      },
    });
    useGraphStore.getState().createGroup('Explicit', '#123456');
    expect(useGraphStore.getState().project!.goldenColorCursorHue).toBe(45);

    useSettingsStore.setState({ groupColorAssignment: 'hierarchy-aware' });
    useGraphStore.getState().createGroup('Hierarchy');
    expect(useGraphStore.getState().project!.goldenColorCursorHue).toBe(45);
  });

  it('reassigns the whole palette as one undoable project change', () => {
    useGraphStore.getState().createGroup('A');
    useGraphStore.getState().createGroup('B');
    useGraphStore.temporal.getState().clear();
    const before = useGraphStore.getState().project!;

    useGraphStore.getState().reassignProjectColors('golden-angle', () => 0.5);
    const after = useGraphStore.getState().project!;
    expect(after.color).not.toBe(before.color);
    expect(Object.values(after.groups).map((group) => group.color))
      .not.toEqual(Object.values(before.groups).map((group) => group.color));

    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project).toEqual(before);
  });

  it('createGroup honors an explicit color', () => {
    const id = useGraphStore.getState().createGroup('Reds', 'red');
    expect(useGraphStore.getState().project!.groups[id]!.color).toBe('red');
  });

  it('renameGroup updates name', () => {
    const id = useGraphStore.getState().createGroup('Old');
    useGraphStore.getState().renameGroup(id, 'New');
    expect(useGraphStore.getState().project!.groups[id]!.name).toBe('New');
  });

  it('recolorGroup updates color', () => {
    const id = useGraphStore.getState().createGroup('A', 'red');
    useGraphStore.getState().recolorGroup(id, 'green');
    expect(useGraphStore.getState().project!.groups[id]!.color).toBe('green');
  });

  it('assignNodeToGroup sets groupId on the node', () => {
    addNode('a', 'A');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('a', gid);
    expect(useGraphStore.getState().project!.nodes['a']!.groupId).toBe(gid);
  });

  it('assignNodeToGroup(nodeId, null) detaches the node', () => {
    addNode('a', 'A');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('a', gid);
    useGraphStore.getState().assignNodeToGroup('a', null);
    expect(useGraphStore.getState().project!.nodes['a']!.groupId).toBeUndefined();
  });

  it('assignNodeToGroup ignores unknown groupId', () => {
    addNode('a', 'A');
    useGraphStore.getState().assignNodeToGroup('a', 'does-not-exist');
    expect(useGraphStore.getState().project!.nodes['a']!.groupId).toBeUndefined();
  });

  it('assignSubtreeToGroup spreads via auto-arrows', () => {
    addNode('a', 'A'); addNode('b', 'B'); addNode('c', 'C'); addNode('d', 'D');
    addArrow('e1', 'a', 'b'); addArrow('e2', 'b', 'c');
    // dotted edges should NOT spread
    useGraphStore.getState().addArrow({
      id: 'd1', fromNodeId: 'c', toNodeId: 'd', kind: 'dotted',
    });
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignSubtreeToGroup('a', gid);
    const ns = useGraphStore.getState().project!.nodes;
    expect(ns['a']!.groupId).toBe(gid);
    expect(ns['b']!.groupId).toBe(gid);
    expect(ns['c']!.groupId).toBe(gid);
    expect(ns['d']!.groupId).toBeUndefined();
  });

  it('assignSubtreeToGroup(root, null) detaches the whole subtree', () => {
    addNode('a', 'A'); addNode('b', 'B'); addArrow('e1', 'a', 'b');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignSubtreeToGroup('a', gid);
    useGraphStore.getState().assignSubtreeToGroup('a', null);
    const ns = useGraphStore.getState().project!.nodes;
    expect(ns['a']!.groupId).toBeUndefined();
    expect(ns['b']!.groupId).toBeUndefined();
  });

  it('createGroupFromNode("self") names the group after the node header', () => {
    addNode('a', 'My Term');
    const gid = useGraphStore.getState().createGroupFromNode('a', 'self');
    const p = useGraphStore.getState().project!;
    expect(p.groups[gid]!.name).toBe('My Term');
    expect(p.nodes['a']!.groupId).toBe(gid);
  });

  it('createGroupFromNode("subtree") assigns the whole auto subtree', () => {
    addNode('a', 'Root'); addNode('b', 'B'); addNode('c', 'C');
    addArrow('e1', 'a', 'b'); addArrow('e2', 'b', 'c');
    const gid = useGraphStore.getState().createGroupFromNode('a', 'subtree');
    const ns = useGraphStore.getState().project!.nodes;
    expect(ns['a']!.groupId).toBe(gid);
    expect(ns['b']!.groupId).toBe(gid);
    expect(ns['c']!.groupId).toBe(gid);
  });

  it('createGroupFromNode("subtree") names the group after the CLICKED node header (E.7)', () => {
    // Regression guard: when the user picks "Add branch to new group"
    // on a parent node, the new group's name must come from THAT
    // node's header (not from any descendant). Symmetric to the
    // self-branch test above.
    addNode('a', 'Strategy'); addNode('b', 'Risks'); addNode('c', 'Mitigations');
    addArrow('e1', 'a', 'b'); addArrow('e2', 'b', 'c');
    const gid = useGraphStore.getState().createGroupFromNode('a', 'subtree');
    const g = useGraphStore.getState().project!.groups[gid]!;
    expect(g.name).toBe('Strategy');
  });

  it('createGroupFromNode falls back to "Group N" when header is empty', () => {
    addNode('a', '');
    const gid = useGraphStore.getState().createGroupFromNode('a', 'self');
    expect(useGraphStore.getState().project!.groups[gid]!.name).toBe('Group 1');
  });

  it('deleteGroup removes the group and clears groupId on members', () => {
    addNode('a', 'A'); addNode('b', 'B');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('a', gid);
    useGraphStore.getState().assignNodeToGroup('b', gid);
    useGraphStore.getState().deleteGroup(gid);
    const p = useGraphStore.getState().project!;
    expect(p.groups[gid]).toBeUndefined();
    expect(p.nodes['a']!.groupId).toBeUndefined();
    expect(p.nodes['b']!.groupId).toBeUndefined();
  });

  it('deleteGroup clears selectedGroupId when that group was selected', () => {
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().selectGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBe(gid);
    useGraphStore.getState().deleteGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });

  it('setGroupFrozen freezes every member and leaves non-members alone', () => {
    addNode('a', 'A'); addNode('b', 'B'); addNode('c', 'C');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('a', gid);
    useGraphStore.getState().assignNodeToGroup('b', gid);
    useGraphStore.getState().setGroupFrozen(gid, true);
    const ns = useGraphStore.getState().project!.nodes;
    expect(ns['a']!.frozen).toBe(true);
    expect(ns['b']!.frozen).toBe(true);
    expect(ns['c']!.frozen).toBe(false);
    useGraphStore.getState().setGroupFrozen(gid, false);
    const ns2 = useGraphStore.getState().project!.nodes;
    expect(ns2['a']!.frozen).toBe(false);
    expect(ns2['b']!.frozen).toBe(false);
  });

  it('selectGroup sets the transient selectedGroupId flag', () => {
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().selectGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBe(gid);
    useGraphStore.getState().selectGroup(null);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });

  it('selectGroup replaces node selection with all of its members without an undo entry', () => {
    addNode('a', 'A');
    addNode('b', 'B'); addNode('c', 'C');
    useGraphStore.getState().setSelection(['a']);
    expect(useGraphStore.getState().project!.selection).toEqual(['a']);
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodesToGroup(['b', 'c'], gid);
    useGraphStore.temporal.getState().clear();
    useGraphStore.getState().selectGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBe(gid);
    expect(useGraphStore.getState().project!.selection).toEqual(['b', 'c']);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    useGraphStore.getState().selectGroup(null);
    expect(useGraphStore.getState().project!.selection).toEqual([]);
  });

  it('setSelection with a non-empty list clears selectedGroupId', () => {
    addNode('a', 'A');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().selectGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBe(gid);
    useGraphStore.getState().setSelection(['a']);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });

  it('setSelection with empty list also clears selectedGroupId', () => {
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().selectGroup(gid);
    useGraphStore.getState().setSelection([]);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });

  it('explicit single-node focus and manual selections replace the group origin', () => {
    addNode('a', 'A'); addNode('b', 'B');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodesToGroup(['a', 'b'], gid);
    useGraphStore.getState().selectGroup(gid);
    useGraphStore.temporal.getState().clear();
    useGraphStore.getState().setSelection(['a']);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    expect(useGraphStore.getState().project!.selection).toEqual(['a']);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);

    useGraphStore.getState().setSelection(['a']);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    for (const ids of [['b'], ['a', 'b'], ['missing']]) {
      useGraphStore.getState().selectGroup(gid);
      useGraphStore.getState().setSelection(ids);
      expect(useGraphStore.getState().selectedGroupId).toBeNull();
    }
  });

  it('does not keep a group selected across project switches or missing group IDs', () => {
    const graph = useGraphStore.getState();
    const gid = graph.createGroup('G');
    graph.selectGroup(gid);
    graph.setProject(createBlankProject('Other', 'root'));
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    graph.selectGroup(gid);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
  });

  it('a node spawned with parent.groupId inherits the parent group (B.5)', () => {
    // Documentation/regression guard for the inheritance step inside
    // spawnTermClick / spawnFollowUp. Those functions construct the new
    // node literal with `groupId: parent.groupId` before calling addNode,
    // so the store-side observable effect is just that a freshly added
    // node round-trips its groupId. We exercise that here.
    addNode('parent', 'Parent');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('parent', gid);
    const parent = useGraphStore.getState().project!.nodes['parent']!;
    useGraphStore.getState().addNode({
      id: 'child', type: 'term-click', position: { x: 1, y: 1 }, frozen: false,
      groupId: parent.groupId,
      versions: [{ header: 'C', body: '', createdAt: 0, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    });
    expect(useGraphStore.getState().project!.nodes['child']!.groupId).toBe(gid);
  });

  it('a node spawned with an ungrouped parent stays ungrouped (B.5)', () => {
    addNode('parent', 'Parent');
    const parent = useGraphStore.getState().project!.nodes['parent']!;
    useGraphStore.getState().addNode({
      id: 'child', type: 'term-click', position: { x: 1, y: 1 }, frozen: false,
      groupId: parent.groupId,
      versions: [{ header: 'C', body: '', createdAt: 0, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    });
    expect(useGraphStore.getState().project!.nodes['child']!.groupId).toBeUndefined();
  });

  it('group mutations participate in undo', () => {
    addNode('a', 'A');
    const gid = useGraphStore.getState().createGroup('G');
    useGraphStore.getState().assignNodeToGroup('a', gid);
    expect(useGraphStore.getState().project!.nodes['a']!.groupId).toBe(gid);
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.nodes['a']!.groupId).toBeUndefined();
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.getState().project!.groups[gid]).toBeUndefined();
  });
});

describe('useGraphStore — group order', () => {
  it('createGroup prepends new groups to the top', () => {
    const a = useGraphStore.getState().createGroup('A');
    const b = useGraphStore.getState().createGroup('B');
    expect(Object.keys(useGraphStore.getState().project!.groups)).toEqual([b, a]);
  });

  it('reorderGroup moves a group to the target position', () => {
    const a = useGraphStore.getState().createGroup('A');
    const b = useGraphStore.getState().createGroup('B');
    const c = useGraphStore.getState().createGroup('C');
    // prepend order is [c, b, a]; move a to b's slot
    useGraphStore.getState().reorderGroup(a, b);
    expect(Object.keys(useGraphStore.getState().project!.groups)).toEqual([c, a, b]);
  });

  it('reorderGroup stores a downward move at the displayed target index', () => {
    const a = useGraphStore.getState().createGroup('A');
    const b = useGraphStore.getState().createGroup('B');
    const c = useGraphStore.getState().createGroup('C');
    useGraphStore.getState().reorderGroup(c, a);
    expect(Object.keys(useGraphStore.getState().project!.groups)).toEqual([b, a, c]);
  });

  it('reorderGroup is a no-op for unknown ids or self', () => {
    const a = useGraphStore.getState().createGroup('A');
    const b = useGraphStore.getState().createGroup('B');
    useGraphStore.getState().reorderGroup(a, a);
    useGraphStore.getState().reorderGroup('nope', b);
    expect(Object.keys(useGraphStore.getState().project!.groups)).toEqual([b, a]);
  });
});
