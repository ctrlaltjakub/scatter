'use client';
import { FOLLOW_UP_PLACEHOLDER, FOLLOW_UP_ROUTING_TOOLTIP } from '@/lib/followUpPlaceholder';
import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, RefreshCw } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useFollowUpFocusStore } from '@/store/useFollowUpFocusStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useImageSelectionStore } from '@/store/useImageSelectionStore';
import { useImageEditingCapability } from '@/hooks/useImageEditingCapability';
import { EMPTY_IMAGE_REGIONS } from '@/lib/imageRegions';
import { modifyImageInMediaNode } from '@/lib/imageGeneration';
import { askImageFollowUp } from '@/lib/imageFollowUp';
import { useNodePromptDraft } from '@/hooks/useNodePromptDraft';

export interface ImageFollowUpBarProps {
  nodeId: string;
  capable: boolean;
  checking: boolean;
  editable: boolean;
  busy: boolean;
  selectedPart?: boolean;
  onAsk: (instruction: string) => Promise<unknown>;
  onModify: (instruction: string) => Promise<unknown>;
}

/** Exactly the same panel on the canvas and in the full-window editor. */
export function ImageFollowUpBar({ nodeId, capable, checking, editable, busy, selectedPart = false, onAsk, onModify }: ImageFollowUpBarProps) {
  const { text, setText, getText } = useNodePromptDraft(nodeId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const enterSends = useSettingsStore((s) => s.followUpEnterSends);
  const setFocused = useFollowUpFocusStore((s) => s.setFocused);
  useEffect(() => () => setFocused(false), [setFocused]);
  const blocked = busy || pending || !editable;
  const modifyTip = checking ? 'Checking whether the selected image model supports editing…'
    : !capable ? 'The selected image model cannot edit an existing image. Choose an editing-capable image model in Settings.'
      : selectedPart ? 'Ask AI to modify the selected part while keeping the rest unchanged; save a new version' : 'Modify the whole image and save a new version';
  const submit = async (action: 'ask' | 'modify') => {
    if (blocked || submitting.current || !text.trim() || (action === 'modify' && (checking || !capable))) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    const submittedText = text;
    // The promise covers routing and generation, not just accepting the click.
    // Clear now; a late completion must never erase a newer draft after refocus.
    setText('');
    try {
      await (action === 'ask' ? onAsk(submittedText.trim()) : onModify(submittedText.trim()));
    } catch (cause) {
      if (!getText()) setText(submittedText);
      setError(cause instanceof Error ? cause.message : 'Could not start this image action.');
    } finally { submitting.current = false; setPending(false); }
  };
  const newline = () => {
    const start = taRef.current?.selectionStart ?? text.length;
    const end = taRef.current?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + '\n' + text.slice(end));
    requestAnimationFrame(() => { if (taRef.current) taRef.current.selectionStart = taRef.current.selectionEnd = start + 1; });
  };
  return (
    <div className="node-followup-bar image-followup-bar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <textarea ref={taRef} className="node-followup-input" rows={3}
        aria-label="Image follow-up question or modification"
        aria-description={FOLLOW_UP_ROUTING_TOOLTIP} data-tip={FOLLOW_UP_ROUTING_TOOLTIP}
        placeholder={FOLLOW_UP_PLACEHOLDER} value={text} disabled={blocked}
        onChange={(e) => setText(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
          const mod = e.ctrlKey || e.metaKey;
          if (e.shiftKey || (enterSends && mod)) { e.preventDefault(); newline(); }
          else if (enterSends || mod) { e.preventDefault(); void submit('ask'); }
        }} />
      <div className="node-followup-actions">
        <button type="button" className="node-followup-btn" disabled={blocked || !text.trim()}
          data-tip={`Ask about ${selectedPart ? 'the selected part' : 'the whole image'} (${enterSends ? '↵' : 'Ctrl/⌘+↵'})`}
          onClick={() => void submit('ask')}>
          <span className="node-followup-btn-main"><MessageSquarePlus size={14} /><span>Ask follow-up</span></span>
        </button>
        <button type="button" className="node-followup-btn" disabled={blocked || !text.trim() || checking || !capable}
          data-tip={modifyTip} onClick={() => void submit('modify')}>
          <span className="node-followup-btn-main"><RefreshCw size={14} /><span>Modify</span></span>
        </button>
        <span className="node-followup-scope" aria-label={selectedPart ? 'Targets selected part' : 'Targets whole image'}>
          <span className={selectedPart ? undefined : 'is-active'}>whole image</span><span aria-hidden="true"> / </span>
          <span className={selectedPart ? 'is-active' : undefined}>selected part</span>
        </span>
      </div>
      {error && <div role="alert" className="image-followup-error">{error}</div>}
    </div>
  );
}

export function ImageNodeFollowUpBar({ nodeId }: { nodeId: string }) {
  const capability = useImageEditingCapability();
  const busy = useGraphStore((s) => !!s.project?.nodes[nodeId]?.generating);
  const regions = useImageSelectionStore((s) => s.selection?.nodeId === nodeId ? s.selection.regions : EMPTY_IMAGE_REGIONS);
  return <ImageFollowUpBar nodeId={nodeId} capable={capability.available} checking={capability.checking} editable busy={busy}
    selectedPart={regions.length > 0}
    onAsk={(question) => askImageFollowUp(nodeId, question, regions)}
    onModify={(instruction) => modifyImageInMediaNode(nodeId, instruction, regions)} />;
}
