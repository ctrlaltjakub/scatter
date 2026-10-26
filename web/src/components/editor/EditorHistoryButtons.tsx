'use client';

import { Redo2, Undo2 } from 'lucide-react';

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  noun?: string;
}

/** Compact editor-local history controls used when the app sidebar is hidden. */
export function EditorHistoryButtons({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  noun = 'edit',
}: Props) {
  return (
    <div className="editor-history-actions" role="group" aria-label="Editor history">
      <button
        type="button"
        className="icon-btn"
        disabled={!canUndo}
        onClick={onUndo}
        data-tip={`Undo ${noun} (Ctrl/⌘+Z)`}
        aria-label={`Undo ${noun}`}
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        disabled={!canRedo}
        onClick={onRedo}
        data-tip={`Redo ${noun} (Ctrl/⌘+Shift+Z)`}
        aria-label={`Redo ${noun}`}
      >
        <Redo2 size={16} />
      </button>
    </div>
  );
}
