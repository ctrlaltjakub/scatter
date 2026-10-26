'use client';
import { ChevronRight, Palette, Trash } from 'lucide-react';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { useSidePanelDisclosure } from '../canvas/SidePanelDisclosure';
import { useGraphStore } from '@/store/useGraphStore';
import { stopChat } from '@/lib/chat/actions';
import { NodeGroupMenu, hasGroupedAutoDescendants } from '@/components/canvas/NodeGroupMenu';
import type { ScatterNode } from '@/store/types';

export function ChatPanelTopActions({ node }: { node: ScatterNode }) {
  const label = node.chat ? 'chat' : 'answer';
  return <div className="versions-row chat-utility-row">
    {node.chat && <span className="chat-utility-label">Chat node</span>}
    <div className="versions-row-actions">
      <button type="button" aria-label={`Delete ${label} node`} data-tip={`Delete this ${label} node and its branch. Undo restores it.`}
        onClick={() => { if (node.chat) stopChat(node.id); useGraphStore.getState().deleteNodeCascade(node.id); }}><Trash size={14} /></button>
    </div>
  </div>;
}

export function ChatPanelGroup({ node }: { node: ScatterNode }) {
  const [open, setOpen] = useSidePanelDisclosure('group');
  const project = useGraphStore((state) => state.project);
  if (!project) return null;
  const root = project.rootNodeId === node.id;
  const graph = useGraphStore.getState();
  return <>
    <button type="button" className={`side-action side-disclosure-trigger${open ? ' toggled' : ''}`}
      disabled={root} aria-expanded={open && !root} aria-label="Group" aria-controls={`group-${node.id}`}
      data-tip={root ? 'Can’t group the starting node — group its children instead.' : 'Assign this node to a group, or create a new one'}
      onClick={() => setOpen(!open)}>
      <span className="side-action-icon"><Palette size={15} /></span><span className="side-action-label">Group</span>
      <span className="side-disclosure-chevron"><ChevronRight size={14} className="sc-collapse-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }} /></span>
    </button>
    <AnimatedCollapse open={open && !root} id={`group-${node.id}`}><div className="side-disclosure-content side-disclosure-content--group">
      <NodeGroupMenu nodeGroupId={node.groupId ?? null}
        branchHasGroupedDescendants={hasGroupedAutoDescendants(node.id, project.nodes, project.arrows)}
        groups={Object.values(project.groups)} onAssign={(id) => graph.assignNodeToGroup(node.id, id)}
        onAssignSubtree={(id) => graph.assignSubtreeToGroup(node.id, id)}
        onNewFromNode={(spread) => { graph.createGroupFromNode(node.id, spread); }} />
    </div></AnimatedCollapse>
  </>;
}
