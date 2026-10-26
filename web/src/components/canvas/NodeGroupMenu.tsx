'use client';

import { GitBranch, GitBranchPlus, Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { GroupNameDisplay } from '@/components/GroupNameDisplay';
import { colorToCss } from '@/lib/groupColor';
import type { Arrow, Group, ScatterNode } from '@/store/types';

export function hasGroupedAutoDescendants(
  nodeId: string,
  nodes: Record<string, ScatterNode>,
  arrows: Record<string, Arrow>,
): boolean {
  const children = new Map<string, string[]>();
  for (const arrow of Object.values(arrows)) {
    if (arrow.kind !== 'auto') continue;
    const list = children.get(arrow.fromNodeId) ?? [];
    list.push(arrow.toNodeId);
    children.set(arrow.fromNodeId, list);
  }
  const pending = [...(children.get(nodeId) ?? [])];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (nodes[id]?.groupId) return true;
    pending.push(...(children.get(id) ?? []));
  }
  return false;
}

interface NodeGroupMenuProps {
  nodeGroupId: string | null;
  branchHasGroupedDescendants: boolean;
  groups: Group[];
  onAssign: (groupId: string | null) => void;
  onAssignSubtree: (groupId: string | null) => void;
  onNewFromNode: (spread: 'self' | 'subtree') => void;
  /** Bulk selection shares the same rows, without branch-only actions. */
  multiple?: boolean;
  someGrouped?: boolean;
}

export function NodeGroupMenu({
  nodeGroupId,
  branchHasGroupedDescendants,
  groups,
  onAssign,
  onAssignSubtree,
  onNewFromNode,
  multiple = false,
  someGrouped = false,
}: NodeGroupMenuProps) {
  const branchHasGroupedNodes = !!nodeGroupId || branchHasGroupedDescendants;
  const sortedGroups = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    return [...groups].sort((a, b) => {
      if (a.id === nodeGroupId) return b.id === nodeGroupId ? 0 : -1;
      if (b.id === nodeGroupId) return 1;
      return collator.compare(a.name, b.name);
    });
  }, [groups, nodeGroupId]);

  return (
    <div className="group-popover">
      <div className="group-popover-row group-popover-action-row">
        <button
          type="button"
          className="group-popover-row-main"
          onClick={() => onNewFromNode('self')}
          data-tip={multiple ? 'Create a group for the selected nodes' : 'Create a group named after this node and add only this node'}
          aria-label="Add to new group"
        >
          <span className="group-popover-action-icon"><Plus size={13} /></span>
          <span>Add to new group</span>
        </button>
        {!multiple && <button
          type="button"
          className="group-popover-subtree-btn"
          onClick={() => onNewFromNode('subtree')}
          data-tip="Create a new group for this node and its branch"
          aria-label="Add branch to new group"
        >
          <GitBranchPlus size={13} />
        </button>}
      </div>

      <div className="group-popover-row group-popover-action-row">
        <button
          type="button"
          className="group-popover-row-main"
          disabled={!nodeGroupId && !someGrouped}
          onClick={() => onAssign(null)}
          data-tip={multiple ? 'Remove selected nodes from their groups' : nodeGroupId ? 'Remove this node from its group' : 'This node is not in a group'}
          aria-label="Remove from group"
        >
          <span className="group-popover-action-icon"><Minus size={13} /></span>
          <span>Remove from group</span>
        </button>
        {!multiple && <button
          type="button"
          className="group-popover-subtree-btn"
          disabled={!branchHasGroupedNodes}
          onClick={() => onAssignSubtree(null)}
          data-tip={branchHasGroupedNodes
            ? 'Remove this node and every grouped descendant in its branch from their groups'
            : 'No grouped nodes in this branch'}
          aria-label="Remove branch from groups"
        >
          <GitBranch size={13} />
        </button>}
      </div>

      {sortedGroups.length > 0 && <div className="group-popover-divider" />}

      <div className="group-popover-existing" data-group-list style={{ maxHeight: 120 }}>
        {sortedGroups.map((group) => (
          <ExistingGroupRow
            key={group.id}
            group={group}
            selected={nodeGroupId === group.id}
            onAssign={() => onAssign(group.id)}
            onAssignSubtree={() => onAssignSubtree(group.id)}
            multiple={multiple}
          />
        ))}
      </div>
    </div>
  );
}

function ExistingGroupRow({
  group,
  selected,
  onAssign,
  onAssignSubtree,
  multiple = false,
}: {
  group: Group;
  selected: boolean;
  onAssign: () => void;
  onAssignSubtree: () => void;
  multiple?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className={'group-popover-row has-accent' + (selected ? ' active' : '')}
      style={{ '--row-accent': colorToCss(group.color) } as React.CSSProperties}
      data-group-row
      data-tip={`Add ${multiple ? 'selected nodes' : 'this node'} to ${group.name}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="group-popover-row-main"
        onClick={onAssign}
        aria-label={`Add ${multiple ? 'selected nodes' : 'node'} to ${group.name}`}
      >
        <GroupNameDisplay name={group.name} active={hovered} titleGeneration={group.titleGeneration} />
        {selected && <span className="group-popover-check" aria-hidden="true">✓</span>}
      </button>
      {!multiple && <button
        type="button"
        className="group-popover-subtree-btn"
        onClick={onAssignSubtree}
        data-tip={`Add this node's branch to ${group.name}`}
        aria-label={`Add branch to ${group.name}`}
      >
        <GitBranchPlus size={13} />
      </button>}
    </div>
  );
}
