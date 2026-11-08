'use client';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useEditorStore } from '@/store/useEditorStore';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { EditHeaderButton } from '../node/EditHeaderButton';
import { useSidePanelDisclosure } from './SidePanelDisclosure';

export function NodeTextEditMenu({ node, editorDisabled = false, children }: {
  node: ScatterNode;
  editorDisabled?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useSidePanelDisclosure('text');
  const id = `node-text-tools-${node.id}`;
  return <>
    <button type="button" className={`side-action side-disclosure-trigger${open ? ' toggled' : ''}`}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      data-tip={children ? "Edit or expand this node's text" : "Edit the header, or edit and export this node's text"}>
      <span className="side-action-icon"><FileText size={15} /></span>
      <span className="side-action-label">Edit</span>
      <span className="side-disclosure-chevron">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
    </button>
    <AnimatedCollapse open={open} id={id}>
      <div className="side-disclosure-content">
        <EditHeaderButton node={node} />
        <button type="button" className="side-action" disabled={editorDisabled}
          onClick={() => useEditorStore.getState().openEditor(node.id)}>
          <span className="side-action-icon"><FileText size={15} /></span>Edit or export text
        </button>
        {children}
      </div>
    </AnimatedCollapse>
  </>;
}
