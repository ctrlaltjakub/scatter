'use client';

import { ChevronUp, FolderPlus, Pin, PinOff, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { planNodesDeletion } from '@/lib/arrowPolicy';
import { cancelNodeGeneration } from '@/lib/generate';
import { NodeGroupMenu } from './NodeGroupMenu';
import { createGroupFromSelection } from '@/lib/selectionGroupName';
import { isBatchNodeSelection } from '@/lib/nodeSelection';

export function NodeSelectionToolbar() {
  const project = useGraphStore((s) => s.project);
  const batchSelected = useGraphStore((s) => isBatchNodeSelection(s.project?.selection, s.selectedGroupId));
  const [groupsOpen, setGroupsOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const groupButtonRef = useRef<HTMLButtonElement>(null);
  const selectionKey = project ? `${project.id}:${project.selection.join(',')}` : '';
  useEffect(() => {
    setGroupsOpen(false);
  }, [selectionKey]);
  useEffect(() => {
    if (!groupsOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) setGroupsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setGroupsOpen(false);
      groupButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [groupsOpen]);
  const nodes = project?.selection.flatMap((id) => project.nodes[id] ? [project.nodes[id]!] : []) ?? [];
  if (!project || !batchSelected || !nodes.length) return null;
  const ids = nodes.map((node) => node.id);
  const allPinned = nodes.every((node) => node.frozen);
  const groupable = nodes.filter((node) => node.id !== project.rootNodeId);
  const commonGroup = groupable[0]?.groupId;
  const groupId = commonGroup && groupable.every((node) => node.groupId === commonGroup) ? commonGroup : null;
  const assign = (id: string | null) => {
    useGraphStore.getState().assignNodesToGroup(ids, id);
    setGroupsOpen(false);
    groupButtonRef.current?.focus();
  };
  const createGroup = () => {
    createGroupFromSelection(ids);
    setGroupsOpen(false);
    groupButtonRef.current?.focus();
  };
  const onDelete = () => {
    const graph = useGraphStore.getState();
    if (!graph.project) return;
    const { deletedIds } = planNodesDeletion(graph.project, ids);
    // Match the existing branch-deletion policy, including shared children.
    // Stop runtime work first; only the final graph removal is undoable.
    const history = useGraphStore.temporal.getState();
    const tracking = history.isTracking;
    history.pause();
    try { for (const id of deletedIds) cancelNodeGeneration(id); }
    finally { if (tracking) history.resume(); }
    useGraphStore.getState().deleteNodesCascade(ids);
  };

  return <div ref={toolbarRef} className="node-selection-toolbar" role="toolbar" aria-label="Selected nodes"
    onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <div className="node-selection-group">
      <button ref={groupButtonRef} type="button" className={`side-action${groupsOpen ? ' toggled' : ''}`}
        aria-expanded={groupsOpen} aria-controls="selection-group-menu" disabled={!groupable.length}
        onClick={() => setGroupsOpen((open) => !open)}>
        <span className="side-action-icon"><FolderPlus size={16} /></span>
        Add to group <ChevronUp size={14} aria-hidden="true" />
      </button>
      {groupsOpen && <div id="selection-group-menu" className="node-selection-dropup" role="region" aria-label="Groups">
        {nodes.length !== groupable.length && <p className="node-selection-group-note">The project root stays ungrouped.</p>}
        <NodeGroupMenu multiple someGrouped={groupable.some((node) => !!node.groupId)}
          nodeGroupId={groupId} branchHasGroupedDescendants={false} groups={Object.values(project.groups)}
          onAssign={assign} onAssignSubtree={assign}
          onNewFromNode={() => { void createGroup(); }} />
      </div>}
    </div>
    <span className="node-selection-divider" aria-hidden="true" />
    <button type="button" className={`side-action node-selection-icon${allPinned ? ' toggled' : ''}`}
      aria-label={allPinned ? 'Unpin selected nodes' : 'Pin selected nodes'} aria-pressed={allPinned}
      data-tip={allPinned ? 'Unpin selected nodes' : 'Pin selected nodes in place'}
      onClick={() => useGraphStore.getState().setNodesFrozen(ids, !allPinned)}>
      {allPinned ? <Pin size={18} /> : <PinOff size={18} />}
    </button>
    <button type="button" className="side-action node-selection-icon" aria-label="Delete selected nodes"
      data-tip="Delete selected nodes and their unshared branches · Undo available" onClick={onDelete}><Trash size={18} /></button>
  </div>;
}
