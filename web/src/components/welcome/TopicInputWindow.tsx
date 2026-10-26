'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, X } from 'lucide-react';

/** A larger view of the same unsent draft, not a separate edit transaction.
 * Native textarea undo applies; opening/closing is not app-level undo history. */
export function TopicInputWindow({ value, onChange, onClose, onSubmit, returnFocusRef, mode = 'topic' }: {
  mode?: 'topic' | 'chat';
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  returnFocusRef: RefObject<HTMLElement>;
}) {
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
      if (event.key === 'Tab' && dialog.current) {
        const controls = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), textarea')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      // The parent removes inert in the same commit before focus returns.
      queueMicrotask(() => { returnFocusRef.current?.focus({ preventScroll: true }); });
    };
  }, [onClose, returnFocusRef]);

  return createPortal(
    <div className="topic-editor-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className="topic-editor-window" role="dialog" aria-modal="true" aria-labelledby="topic-editor-title">
        <header className="topic-editor-header">
          <h2 id="topic-editor-title">{mode === 'chat' ? <>What’s on your <em>mind?</em></> : <>What do you want to <em>explore?</em></>}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={`Close expanded ${mode === 'chat' ? 'message' : 'topic'} editor`} title="Close (Esc)"><X size={18} /></button>
        </header>
        <textarea ref={input} className="topic-editor-input" aria-label={mode === 'chat' ? 'Message in expanded editor' : 'Topic in expanded editor'}
          value={value} onChange={(event) => onChange(event.target.value)} placeholder={mode === 'chat' ? 'Start a conversation…' : 'A topic or a question…'}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); if (value.trim()) onSubmit();
            }
          }} />
        <footer className="topic-editor-footer">
          <span>Enter for a new line · Ctrl/⌘ + Enter to {mode === 'chat' ? 'send' : 'explore'}</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Done</button>
          <button type="button" className="btn btn-primary" disabled={!value.trim()} onClick={onSubmit}>{mode === 'chat' ? 'Start conversation' : 'Explore'} <ArrowRight size={16} /></button>
        </footer>
      </section>
    </div>, document.body,
  );
}
