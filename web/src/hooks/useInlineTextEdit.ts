'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type PointerEvent, type MouseEvent } from 'react';
import { normalizeEditableHeader } from '@/lib/nodeHeaderText';

/** Plain-text editing with no extra controls. Keep the save callback captured
 * at entry so changing node/version while editing cannot rename the new one. */
export function useInlineTextEdit<T extends HTMLElement>(value: string, onSave?: (value: string) => void, editNonce = 0) {
  const textRef = useRef<T>(null);
  const [editing, setEditing] = useState(false);
  const session = useRef<{ value: string; save: (value: string) => void } | null>(null);
  const seenNonce = useRef(editNonce);
  const begin = useCallback(() => {
    if (!onSave || session.current) return;
    session.current = { value, save: onSave };
    setEditing(true);
  }, [onSave, value]);
  const finish = useCallback((cancel = false, unmounting = false) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    const next = normalizeEditableHeader(textRef.current?.innerText ?? textRef.current?.textContent ?? '');
    if (!cancel && next && next !== current.value) current.save(next);
    if (!unmounting) {
      if (textRef.current) textRef.current.textContent = cancel || !next ? current.value : next;
      setEditing(false);
    }
  }, []);
  useEffect(() => {
    if (editNonce === seenNonce.current) return;
    seenNonce.current = editNonce;
    if (editNonce) begin();
  }, [editNonce, begin]);
  useLayoutEffect(() => {
    if (!editing || !textRef.current) return;
    textRef.current.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(textRef.current);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);
  useEffect(() => {
    if (!editing) return;
    // Canvas clicks can prevent the native blur. Save before their handlers
    // select/delete/switch nodes, including clicks on non-focusable elements.
    const outside = (event: globalThis.PointerEvent) => {
      if (!textRef.current?.contains(event.target as Node)) finish();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [editing, finish]);
  useLayoutEffect(() => () => finish(false, true), [finish]);
  return {
    textRef, editing, begin,
    editorProps: {
      contentEditable: editing || undefined,
      suppressContentEditableWarning: true,
      role: editing ? 'textbox' : undefined,
      'aria-multiline': editing ? false : undefined,
      onBlur: () => finish(),
      onPointerDown: (event: PointerEvent) => { if (editing) event.stopPropagation(); },
      onClick: (event: MouseEvent) => { if (editing) event.stopPropagation(); },
      onPaste: (event: ClipboardEvent) => {
        if (!editing) return;
        event.preventDefault();
        const value = event.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
        const selection = window.getSelection();
        if (!selection?.rangeCount || !textRef.current?.contains(selection.anchorNode)) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const inserted = document.createTextNode(value);
        range.insertNode(inserted);
        range.setStartAfter(inserted);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!editing) return;
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          finish(event.key === 'Escape');
          textRef.current?.blur();
        }
      },
    },
  };
}
