'use client';
import { BookOpen, ChevronRight, CircleHelp, DollarSign, FilePenLine, ImagePlus, MessageSquarePlus, Plus, SquareMousePointer, TriangleAlert } from 'lucide-react';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { useSidePanelDisclosure } from './SidePanelDisclosure';
import { startChat } from '@/lib/chat/actions';
import { spawnMediaNode } from '@/lib/mediaActions';
import { spawnEmptyTextNode, spawnMarkdownNote } from '@/lib/emptyNodes';
import { spawnInteractiveNode } from '@/lib/interactiveActions';
import { useGraphStore } from '@/store/useGraphStore';
import { captureImageSelection, useImageSelectionStore } from '@/store/useImageSelectionStore';

export function AddNodeMenu({ nodeId }: { nodeId: string }) {
  const [open, setOpen] = useSidePanelDisclosure('add');
  const selectedPart = useImageSelectionStore(s => s.selection?.nodeId === nodeId && s.selection.regions.length > 0);
  const add = (kind: 'chat' | 'media' | 'encyclopedic' | 'explain' | 'interactive' | 'note') => {
    const sourceImage = captureImageSelection(nodeId);
    const id = kind === 'note' ? spawnMarkdownNote(nodeId, sourceImage)
      : kind === 'chat' ? startChat(nodeId, sourceImage ? { sourceImage } : {})
        : kind === 'media' ? spawnMediaNode(nodeId, sourceImage)
          : kind === 'interactive' ? (sourceImage ? spawnInteractiveNode(nodeId, false, sourceImage) : spawnInteractiveNode(nodeId))
            : spawnEmptyTextNode(nodeId, kind, sourceImage);
    if (id) useGraphStore.getState().setSelection([id]);
    setOpen(false);
  };
  return <>
    <button type="button" className={`side-action side-action-add-node side-disclosure-trigger${open ? ' toggled' : ''}`}
      aria-expanded={open} aria-controls={`add-node-${nodeId}`} onClick={() => setOpen(!open)}
      data-tip={selectedPart ? 'Create a node connected to the selected image region' : 'Create a connected node'}>
      <span className="side-action-icon"><Plus size={15} /></span><span className="side-action-label">{selectedPart ? 'Add node (selection)' : 'Add node'}</span>
      <span className="side-disclosure-chevron"><ChevronRight size={14} className="sc-collapse-chevron" style={{ transform: open ? 'rotate(90deg)' : undefined }} /></span>
    </button>
    <AnimatedCollapse open={open} id={`add-node-${nodeId}`}><div className="side-disclosure-content">
      {([
        ['chat', 'Chat', MessageSquarePlus, 'Start a connected chat using this node as context'],
        ['media', 'Image or video', ImagePlus, 'Add a connected media node to upload, link or generate an image, GIF or video'],
        ['encyclopedic', 'Encyclopedic node', BookOpen, 'Add an empty connected node for a structured topic overview'],
        ['explain', 'Explanation', CircleHelp, 'Add an empty connected node for a focused explanation'],
        ['interactive', 'Interactive node', SquareMousePointer, 'Add an empty connected node for an interactive explanation. Higher costs compared to the text or image nodes.'],
        ['note', 'Markdown text node', FilePenLine, 'Add an empty connected text node to write and format yourself'],
      ] as const).map(([kind, label, Icon, tip]) => <button key={kind} type="button" className="side-action" data-tip={tip} onClick={() => add(kind)}>
        <span className="side-action-icon"><Icon size={15} /></span>{label}
        {kind === 'interactive' && <span className="interactive-cost-icons" aria-hidden="true"><TriangleAlert size={13} /><DollarSign size={13} /></span>}
      </button>)}
    </div></AnimatedCollapse>
  </>;
}
