'use client';
/**
 * A node-style floating toolbar (reuses `.sc-sel-toolbar` from SelectionToolbar)
 * that appears above a non-empty text selection in the editor, with Bold / Mark
 * term / Copy / Web search. Positioned from the live selection rect; not camera-tracked (the
 * editor is fixed, unlike canvas nodes).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { SelectionWebSearchLink } from '../SelectionWebSearchLink';
import { positionSelectionToolbar } from '@/lib/positionSelectionToolbar';

function selectionInTypes(editor: Editor, names: string[]): boolean {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 0; d--) {
    if (names.includes($from.node(d).type.name)) return true;
  }
  return false;
}

export function EditorSelectionToolbar({ editor }: { editor: Editor | null }) {
  const [pos, setPos] = useState<DOMRect | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const recompute = useCallback(() => {
    if (!editor || editor.isDestroyed || editor.state.selection.empty || !editor.isFocused) {
      setPos(null);
      return;
    }
    const dom = window.getSelection();
    if (!dom || dom.rangeCount === 0 || !dom.toString().trim()) {
      setPos(null);
      return;
    }
    const rect = dom.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setPos(null);
      return;
    }
    setPos(rect);
  }, [editor]);

  useLayoutEffect(() => {
    if (barRef.current && pos) positionSelectionToolbar(barRef.current, pos);
  });

  useEffect(() => {
    if (!editor) return;
    const onSel = () => recompute();
    const onBlur = () => setPos(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null);
    };
    editor.on('selectionUpdate', onSel);
    editor.on('blur', onBlur);
    window.addEventListener('scroll', onSel, true);
    window.addEventListener('resize', onSel);
    window.addEventListener('keydown', onKey);
    return () => {
      editor.off('selectionUpdate', onSel);
      editor.off('blur', onBlur);
      window.removeEventListener('scroll', onSel, true);
      window.removeEventListener('resize', onSel);
      window.removeEventListener('keydown', onKey);
    };
  }, [editor, recompute]);

  if (!editor || !pos) return null;

  const inBullets = selectionInTypes(editor, ['bulletSection']);
  const inPlain = selectionInTypes(editor, ['title', 'l1Title']);

  const copy = () => {
    const { from, to } = editor.state.selection;
    void navigator.clipboard?.writeText(editor.state.doc.textBetween(from, to, ' '));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 600);
  };

  return (
    <div
      ref={barRef}
      className="sc-sel-toolbar"
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="sc-sel-btn"
        disabled={inBullets}
        data-tip="Bold (⌘/Ctrl+B) — opening text only"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        Bold
      </button>
      <span className="sc-sel-div" />
      <button
        type="button"
        className="sc-sel-btn"
        disabled={inPlain}
        data-tip="Mark the selection as a term"
        onClick={() => {
          editor.chain().focus().markTermAtSelection().run();
          setPos(null);
        }}
      >
        Mark term
      </button>
      <span className="sc-sel-div" />
      <button type="button" className="sc-sel-btn" data-tip="Copy selection" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="sc-sel-div" aria-hidden="true" />
      <SelectionWebSearchLink text={editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ')} />
    </div>
  );
}
