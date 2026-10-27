'use client';
import { ChevronLeft, ChevronRight, Maximize, Play, RotateCcw, Square, Trash } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { removeNodeVersion } from '@/lib/nodeVersions';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useInteractiveRuntimeStore } from '@/store/useInteractiveRuntimeStore';
import { buildInteractiveNode, stopInteractiveBuild } from '@/lib/interactiveActions';
import { useInteractiveGenerationAvailable } from '@/hooks/useInteractiveGenerationAvailable';
import { VersionCounter } from '@/components/VersionCounter';
import { ChatPanelGroup } from '@/components/chat/ChatPanelControls';
import { AddNodeMenu } from '@/components/canvas/AddNodeMenu';
import { cancelNodeGenerationCascade } from '@/lib/generate';
import { EditHeaderButton } from './EditHeaderButton';
import { AddToProjectSourcesButton } from './AddToProjectSourcesButton';

export function InteractiveNodeActions({ node, isRoot }: { node: ScatterNode; isRoot: boolean }) {
  const available = useInteractiveGenerationAvailable();
  const version = node.versions[node.currentVersionIndex]!;
  const ready = !!version.interactive?.html;
  const busy = !!node.generating;
  const switchVersion = (delta: number) => useGraphStore.getState().updateNode(node.id, { currentVersionIndex: node.currentVersionIndex+delta });
  const remove = () => {
    const current = useGraphStore.getState().project?.nodes[node.id];
    const index = current?.versions.findIndex(candidate => candidate.createdAt === version.createdAt) ?? -1;
    if (!current || index < 0) return;
    if (current.generating && (current.generatingVersionIndex == null || current.generatingVersionIndex === index)) stopInteractiveBuild(node.id);
    if (current.versions.length > 1) {
      const latest = useGraphStore.getState().project!.nodes[node.id]!;
      const patch = removeNodeVersion(latest, version.createdAt);
      if (patch) useGraphStore.getState().updateNode(node.id, patch);
    }
    else { cancelNodeGenerationCascade(node.id); useGraphStore.getState().deleteNodeCascade(node.id); }
  };
  return <div className="side-panel-content interactive-node-actions">
    <div className="versions-row">
      <div className="versions-row-cluster">
        <button type="button" aria-label="Previous version" data-tip="Previous version" disabled={busy||node.currentVersionIndex===0} onClick={()=>switchVersion(-1)}><ChevronLeft size={14}/></button>
        <VersionCounter current={node.currentVersionIndex+1} total={node.versions.length}/>
        <button type="button" aria-label="Next version" data-tip="Next version" disabled={busy||node.currentVersionIndex===node.versions.length-1} onClick={()=>switchVersion(1)}><ChevronRight size={14}/></button>
      </div>
      <div className="versions-row-actions">
        <button type="button" aria-label="Regenerate" disabled={busy||!available||!(ready||version.interactiveBuild?.request)} data-tip="Build again from the saved request, keeping the previous version" onClick={()=>void buildInteractiveNode(node.id)}><RotateCcw size={14}/></button>
        <button type="button" aria-label="Delete" disabled={isRoot && node.versions.length===1} data-tip="Delete version or node. Undo restores it." onClick={remove}><Trash size={14}/></button>
      </div>
    </div>
    <AddNodeMenu nodeId={node.id}/>
    <ChatPanelGroup node={node}/>
    <EditHeaderButton node={node}/>
    <AddToProjectSourcesButton version={version} disabled={busy || !ready}/>
    <button type="button" className="side-action" disabled={!ready||busy} onClick={()=>useInteractiveViewerStore.getState().openViewer(node.id,node.currentVersionIndex)}>
      <span className="side-action-icon"><Maximize size={15}/></span>Open enlarged
    </button>
    <button type="button" className="side-action" disabled={!ready||busy} data-tip="Reset the program without regenerating it or using AI credits" onClick={()=>useInteractiveRuntimeStore.getState().restart(node.id)}>
      <span className="side-action-icon"><Play size={15}/></span>Restart
    </button>
    {busy && <button type="button" className="side-action" onClick={()=>stopInteractiveBuild(node.id)}><span className="side-action-icon"><Square size={15}/></span>Stop building</button>}
  </div>;
}
