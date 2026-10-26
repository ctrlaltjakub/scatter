'use client';
import { useEffect, useRef } from 'react';
import { useNodePromptDraft } from '@/hooks/useNodePromptDraft';
import { MessageSquarePlus, RefreshCw, Sparkles } from 'lucide-react';
import { generateEmptyTextNode, modifyNode, modifySelection, spawnFollowUp } from '@/lib/generate';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useFollowUpFocusStore } from '@/store/useFollowUpFocusStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useGraphStore } from '@/store/useGraphStore';
import { isEmptyTextNode } from '@/lib/emptyNodes';
import { currentContentType, isStandaloneInteractive } from '@/lib/nodeContentType';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { FOLLOW_UP_PLACEHOLDER, FOLLOW_UP_ROUTING_TOOLTIP } from '@/lib/followUpPlaceholder';

/* -------------------------------------------------------------------------
 * Follow-up bar — bottom panel docked under a selected node.
 *
 * Houses the "Modify…" and "Ask follow-up…" actions that used to
 * live as inline inputs inside the side panel. Splitting them out
 * gives the user a dedicated input surface that doesn't compete
 * with the side panel's button list, AND lets them try both intents
 * against the same prompt text without re-typing (the textarea is
 * shared between both buttons).
 *
 * Keyboard (while typing in the textarea):
 *   - Enter            → Ask follow-up   } default; the two swap when the
 *   - Ctrl/⌘+Enter     → new line        } `followUpEnterSends` setting is off.
 *   - Shift+Enter      → new line, regardless of that setting.
 * The mapping is shown live in the sidebar shortcut list while this textarea
 * is focused (via useFollowUpFocusStore).
 *
 * Visibility is gated by the parent (NodeView) on `selected` —
 * the bar only appears when this node is the single selection,
 * same rule the side panel uses.
 * ------------------------------------------------------------------------*/

interface Props {
  nodeId: string;
}

export function NodeFollowUpBar({ nodeId }: Props) {
  const interactive = useGraphStore(s => { const node = s.project?.nodes[nodeId]; return !!node && isStandaloneInteractive(node); });
  const emptyType = useGraphStore(s => {
    const node = s.project?.nodes[nodeId];
    if (node && isStandaloneInteractive(node) && !node.versions.some(v => v.interactive?.html)) return 'interactive';
    return node && isEmptyTextNode(node) ? currentContentType(node) : null;
  });
  const generating = useGraphStore(s => !!s.project?.nodes[nodeId]?.generating);
  const { text, setText } = useNodePromptDraft(nodeId);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = text.trim();
  const disabled = trimmed.length === 0 || ((!!emptyType || interactive) && generating);
  const enterSends = useSettingsStore((s) => s.followUpEnterSends);
  const setFocused = useFollowUpFocusStore((s) => s.setFocused);
  const storedSelection = useNodeTextSelectionStore((s) => s.selection);
  const exactSelection = storedSelection?.nodeId === nodeId ? storedSelection : null;
  const hasActiveRewrite = useRewriteStore((s) => (s.activeByNode[nodeId]?.length ?? 0) > 0);

  // Make sure the sidebar's typing-shortcuts hint clears if the bar unmounts
  // (e.g. the node gets deselected) while the textarea still held focus.
  useEffect(() => () => setFocused(false), [setFocused]);

  const submit = (action: 'ask' | 'modify') => {
    if (disabled) return;
    if (emptyType) {
      if (interactive) void buildInteractiveNode(nodeId, trimmed, 'create');
      else void generateEmptyTextNode(nodeId, trimmed);
      setText('');
      return;
    }
    if (action === 'modify' && exactSelection && hasActiveRewrite) return;
    // Capture before clearing: the generation call needs the immutable source
    // version/range, while the UI should return to Node scope immediately.
    const selected = exactSelection;
    useNodeTextSelectionStore.getState().clear();
    window.getSelection()?.removeAllRanges();
    if (action === 'ask') {
      if (selected) void spawnFollowUp(nodeId, trimmed, selected);
      else void spawnFollowUp(nodeId, trimmed);
    }
    else if (interactive) void buildInteractiveNode(nodeId, trimmed, 'modify');
    else if (selected) void modifySelection(selected, trimmed);
    else void modifyNode(nodeId, trimmed);
    setText('');
  };

  // Insert a newline at the caret — textareas don't do this for Ctrl/⌘+Enter,
  // so we splice it in manually and keep the caret after it.
  const insertNewline = () => {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + '\n' + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.selectionStart = taRef.current.selectionEnd = start + 1;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.shiftKey) {
      e.preventDefault();
      insertNewline();
      return;
    }
    if (enterSends) {
      e.preventDefault();
      if (mod) insertNewline();   // Ctrl/⌘+Enter → new line
      else submit('ask');         // Enter → send
    } else if (mod) {
      e.preventDefault();
      submit('ask');              // Ctrl/⌘+Enter → send
    }
    // else: plain Enter falls through to the textarea's default (new line).
  };

  const askHint = enterSends
    ? 'Spawn a follow-up child node from this question (↵)'
    : 'Spawn a follow-up child node from this question (⌘↵)';

  const scope = (
    <span className="node-followup-scope" aria-label={exactSelection ? 'Targets selected text' : 'Targets whole node'}>
      <span className={exactSelection ? undefined : 'is-active'}>whole node</span>
      <span aria-hidden="true"> / </span>
      <span className={exactSelection ? 'is-active' : undefined}>selected text</span>
    </span>
  );

  return (
    <div
      className="node-followup-bar"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <textarea
        ref={taRef}
        className="node-followup-input"
        aria-label={emptyType ? 'Node generation prompt' : 'Follow-up question or modification'}
        aria-description={emptyType ? undefined : FOLLOW_UP_ROUTING_TOOLTIP}
        data-tip={emptyType ? undefined : FOLLOW_UP_ROUTING_TOOLTIP}
        placeholder={emptyType === 'interactive' ? 'What would you like to build?'
          : interactive ? 'Ask a follow-up question or describe a change to this interactive…'
          : emptyType === 'explain' ? 'What would you like explained?'
          : emptyType ? 'What would you like to explore?' : FOLLOW_UP_PLACEHOLDER}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={3}
      />
      <div className={'node-followup-actions' + (emptyType ? ' node-followup-actions--empty' : '')}>
        <button
          type="button"
          className="node-followup-btn"
          onClick={() => submit('ask')}
          disabled={disabled}
          data-tip={emptyType ? 'Generate content in this node' : askHint}
        >
          <span className="node-followup-btn-main">{emptyType ? <Sparkles size={14} /> : <MessageSquarePlus size={14} />}<span>{emptyType ? 'Generate' : 'Ask follow-up'}</span></span>
        </button>
        {!emptyType && <button
          type="button"
          className="node-followup-btn"
          onClick={() => submit('modify')}
          disabled={disabled || (!!exactSelection && hasActiveRewrite)}
          data-tip={interactive ? 'Modify the program, preserving working parts in a new version' : exactSelection ? 'Rewrite only the selected text using the instruction above' : 'Rewrite this node using the instruction above'}
        >
          <span className="node-followup-btn-main"><RefreshCw size={14} /><span>Modify</span></span>
        </button>}
        {!emptyType && !interactive && scope}
      </div>
    </div>
  );
}
