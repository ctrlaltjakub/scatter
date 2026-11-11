'use client';
import { useMemo } from 'react';
import { DiagramFlowHorizontal } from '@/components/icons/DiagramFlowHorizontal';
import { parentChoices } from '@/lib/changeParent';
import { useGraphStore } from '@/store/useGraphStore';
import { beginParentPick, cancelParentPick, chooseParent, useParentPickStore } from '@/store/useParentPickStore';

export function ChangeParentAction({ nodeId, nodeCount }: { nodeId: string; nodeCount: number }) {
  const arrows = useGraphStore(s => s.project?.arrows);
  const pick = useParentPickStore(s => s.pick?.nodeId === nodeId ? s.pick : null);
  const reason = useMemo(() => {
    const project = useGraphStore.getState().project;
    return project && parentChoices(project, nodeId).reason;
  }, [nodeId, arrows, nodeCount]);
  return <div className="change-parent-action" data-parent-picker-control="">
    <button type="button" className={'side-action' + (reason ? ' side-action--disabled' : '') + (pick ? ' toggled' : '')}
      aria-disabled={!!reason} aria-description={reason ?? undefined} aria-pressed={!!pick} data-tip={reason ?? (pick ? 'Cancel changing the parent' : 'Choose a new parent for this node and its branch')}
      onClick={event => {
        if (reason) return;
        if (pick) { cancelParentPick(); return; }
        const rect = event.currentTarget.getBoundingClientRect(), keyboard = event.detail === 0;
        beginParentPick(nodeId, keyboard ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : { x: event.clientX, y: event.clientY }, keyboard);
      }}>
      <span className="side-action-icon"><DiagramFlowHorizontal size={15} /></span><span className="side-action-label">Change parent node</span>
    </button>
    {pick && <div className="change-parent-help">
      <span role="status">Choose a pulsing node. Pan or zoom to reach it. Esc cancels.</span>
      {pick.keyboard && <select className="input" aria-label="New parent node" autoFocus defaultValue="" onChange={event => chooseParent(event.target.value)}>
        <option value="" disabled>Choose a parent…</option>
        {[...pick.candidates].map(id => {
          const node = useGraphStore.getState().project?.nodes[id];
          return <option key={id} value={id}>{node?.chat?.title || node?.versions[node.currentVersionIndex]?.header || 'Untitled node'}</option>;
        })}
      </select>}
    </div>}
  </div>;
}
