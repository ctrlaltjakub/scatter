'use client';
import { Pencil } from 'lucide-react';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { useInlineTextEdit } from '@/hooks/useInlineTextEdit';

/** Plain text edited in place; one save, not one undo entry per keypress. */
export function ChatInlineTitle({ title, label, onSave, generating = false, editNonce = 0, showEditButton = true }: {
  title: string; label: string; onSave: (title: string) => void; generating?: boolean; editNonce?: number; showEditButton?: boolean;
}) {
  const pulse = useGenerationPulseSync(generating);
  const { textRef, editing, begin, editorProps } = useInlineTextEdit<HTMLSpanElement>(title, onSave, editNonce);
  return <span className={`chat-inline-title${editing ? ' is-editing' : ''}`}>
    <span ref={textRef} className={generating ? 'chat-activity is-generating' : undefined} style={generating ? pulse : undefined}
      {...editorProps} aria-label={editing ? label : undefined}>{title}</span>
    {showEditButton && !editing && <button type="button" aria-label={label} data-tip={label} className="chat-title-edit"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); begin(); }}><Pencil size={12} /></button>}
  </span>;
}
