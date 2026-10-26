'use client';
import { Pencil } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { canInlineEditNodeHeader } from '@/lib/nodeHeaderText';
import { requestNodeHeaderEdit } from '@/lib/nodeHeaderActions';

export function EditHeaderButton({ node }: { node: ScatterNode }) {
  const arrows = useGraphStore(state => state.project?.arrows);
  if (!arrows || !canInlineEditNodeHeader(node, arrows)) return null;
  return <button type="button" className="side-action" disabled={!!node.generating}
    onClick={() => requestNodeHeaderEdit(node.id)}>
    <span className="side-action-icon"><Pencil size={15} /></span>Edit header
  </button>;
}
