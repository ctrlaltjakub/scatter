'use client';
import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, X } from 'lucide-react';
import { LocalModelGuideBody } from './LocalModelGuideBody';

function isBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

/** Native top-layer dialog keeps nested settings/onboarding focus and Escape
 * handling separate. Guide navigation is transient, outside canvas undo/redo. */
export function LocalModelGuide() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <>
    <button type="button" className="settings-text-action local-guide-link" onClick={() => setOpen(true)}><BookOpen size={15} /> Local providers: connection guide</button>
    {open && createPortal(<dialog ref={dialog} className="modal local-model-guide" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); setOpen(false); }}
      onPointerDown={event => {
        event.stopPropagation();
        pressedBackdrop.current = event.button === 0 && isBackdrop(event);
      }}
      onPointerUp={event => event.stopPropagation()}
      onPointerCancel={() => { pressedBackdrop.current = false; }}
      onClick={event => {
        event.stopPropagation();
        const dismiss = pressedBackdrop.current && isBackdrop(event);
        pressedBackdrop.current = false;
        if (dismiss) setOpen(false);
      }}
      onKeyDown={event => event.stopPropagation()} onClose={() => setOpen(false)}>
      <header className="modal-header"><h2 id={titleId} className="modal-title">Local provider connections</h2>
        <button type="button" className="icon-btn" aria-label="Close connection guide" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <LocalModelGuideBody />
    </dialog>, document.body)}
  </>;
}
