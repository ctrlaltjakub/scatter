'use client';
/**
 * The editor's bottom bar — a text field + "Modify" button (no follow-up).
 *
 * It only collects the instruction; the actual Modify is run by the parent
 * (EditorWindow) through the SHARED generation engine, so the canvas and the
 * editor display ONE live generation (delete → stream → chips, with the pulse
 * and skeleton). Plain Enter submits; Shift+Enter inserts a newline.
 */
import { useState } from 'react';
import { shouldSubmitOnEnter } from './editorKeys';

interface Props {
  /** The node is generating — disable input + show "Modifying…". */
  busy: boolean;
  /** Hand the trimmed instruction up to the window to run the generation. */
  onSubmitModify: (instruction: string) => void;
  /** Last generation error (from the node), shown under the bar. */
  error?: string | null;
}

export function EditorBottomBar({ busy, onSubmitModify, error }: Props) {
  const [text, setText] = useState('');

  const submit = () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    onSubmitModify(instruction);
    setText('');
  };

  return (
    <div className="text-editor-bottom">
      <div className="te-modify">
        <textarea
          className="te-modify-input"
          rows={2}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitOnEnter({
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
            })) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Tell me how to change this…"
        />
        <button
          type="button"
          className="te-modify-btn"
          disabled={!text.trim() || busy}
          data-tip="Revise this node with AI (re-marks terms)"
          onClick={submit}
        >
          {busy ? 'Modifying…' : 'Modify'}
        </button>
      </div>
      {error && <div className="te-modify-err">{error}</div>}
    </div>
  );
}
