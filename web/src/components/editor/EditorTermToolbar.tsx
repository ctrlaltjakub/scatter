'use client';
/**
 * One-button floating toolbar (reuses `.sc-sel-toolbar` from the selection
 * toolbar) that appears above a term marking once it's CLICKED/active in the
 * editor — i.e. when TermResize has activated it for resizing. Its single
 * "delete term" button removes the term mark but keeps the underlying words.
 *
 * Why a separate component instead of reusing EditorSelectionToolbar: when a
 * term is active the caret is collapsed inside it (an EMPTY selection), and the
 * selection toolbar hides on empty selections. So this one is driven by the
 * TermResize plugin's active range (read via `termResizeKey`) and positions
 * itself from `view.coordsAtPos`, not from the DOM selection rect.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { termResizeKey } from './TermResize';

export function EditorTermToolbar({ editor }: { editor: Editor | null }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const recompute = useCallback(() => {
    if (!editor || editor.isDestroyed) {
      setPos(null);
      return;
    }
    const active = termResizeKey.getState(editor.state)?.active;
    if (!active || active.from >= active.to) {
      setPos(null);
      return;
    }
    try {
      const a = editor.view.coordsAtPos(active.from);
      const b = editor.view.coordsAtPos(active.to);
      const center = (a.left + b.left) / 2;
      setPos({
        left: Math.min(Math.max(center, 80), window.innerWidth - 80),
        top: Math.max(a.top - 8, 44),
      });
    } catch {
      setPos(null);
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    // The activate/deactivate transitions carry no doc change, so 'update' /
    // 'selectionUpdate' are unreliable — 'transaction' fires on every dispatch.
    const onTx = () => recompute();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    editor.on('transaction', onTx);
    window.addEventListener('scroll', onTx, true);
    window.addEventListener('resize', onTx);
    window.addEventListener('keydown', onKey);
    return () => {
      editor.off('transaction', onTx);
      window.removeEventListener('scroll', onTx, true);
      window.removeEventListener('resize', onTx);
      window.removeEventListener('keydown', onKey);
    };
  }, [editor, recompute]);

  if (!editor || !pos) return null;

  const deleteTerm = () => {
    const active = termResizeKey.getState(editor.state)?.active;
    const termType = editor.state.schema.marks.term;
    if (!active || !termType) return;
    // Remove the mark across the stored active range (the caret is collapsed,
    // so unsetMark-over-selection wouldn't cover the whole term). The resulting
    // doc change makes the TermResize plugin auto-clear `active`.
    editor.view.dispatch(editor.state.tr.removeMark(active.from, active.to, termType));
    editor.view.focus();
    setPos(null);
  };

  return (
    <div
      className="sc-sel-toolbar"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="sc-sel-btn"
        data-tip="Remove the term marking (keeps the text)"
        onClick={deleteTerm}
      >
        delete term
      </button>
    </div>
  );
}
