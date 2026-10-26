'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useChatRuntimeStore, chatDraftKey, EMPTY_CHAT_DRAFT, getChatDraft } from '@/store/useChatRuntimeStore';
import { chatAvailability } from '@/lib/chat/availability';
import { cancelChatEdit, stopChat, submitChat } from '@/lib/chat/actions';
import { useFollowUpFocusStore } from '@/store/useFollowUpFocusStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { chatSelectionReference } from '@/lib/chat/selectionReference';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
const ChatAttachmentOverlay = dynamic(() => import('./ChatAttachmentOverlay').then((module) => module.ChatAttachmentOverlay), { ssr: false });

export function ChatComposer({ nodeId }: { nodeId: string }) {
  const projectId = useGraphStore((state) => state.project?.id ?? '');
  const node = useGraphStore((state) => state.project?.nodes[nodeId]);
  const parent = useGraphStore((state) => node?.chat?.parentNodeId ? state.project?.nodes[node.chat.parentNodeId] : undefined);
  const draft = useChatRuntimeStore((state) => state.drafts[chatDraftKey(projectId, nodeId)] ?? EMPTY_CHAT_DRAFT);
  const selection = useNodeTextSelectionStore(state => state.selection?.nodeId === nodeId ? state.selection : null);
  const selectedReference = chatSelectionReference(node, selection);
  const selectedPassage = selectedReference?.selectedText;
  const reference = selectedReference ?? draft.reference;
  const compacting = useChatRuntimeStore((state) => !!state.views[nodeId]?.compacting);
  const error = useChatRuntimeStore((state) => state.views[nodeId]?.error);
  const focusNonce = useChatRuntimeStore((state) => state.views[nodeId]?.composerFocusNonce);
  useSettingsStore((state) => state.activeModelRef);
  useSettingsStore((state) => state.providers);
  useModelCatalogStore((state) => state.catalog);
  const enterSends = useSettingsStore((state) => state.followUpEnterSends);
  const area = useRef<HTMLTextAreaElement>(null);
  const [attaching, setAttaching] = useState(false);
  const availability = chatAvailability(parent);
  const busy = !!node?.generating || compacting;
  const setDraft = useChatRuntimeStore.getState().setDraft;
  useEffect(() => {
    if (!selectedPassage) return;
    const current = getChatDraft(projectId, nodeId);
    // A new passage replaces an earlier explicit Ask about choice. Deselecting
    // it must not unexpectedly revive that older answer scope.
    if (current.reference) setDraft(projectId, nodeId, { ...current, reference: undefined });
  }, [selectedPassage, projectId, nodeId, setDraft]);
  useEffect(() => { if (focusNonce) area.current?.focus({ preventScroll: true }); }, [focusNonce]);
  useEffect(() => {
    const runtime = useChatRuntimeStore.getState();
    const alreadyHydrated = !!runtime.drafts[chatDraftKey(projectId, nodeId)];
    runtime.hydrateDraft(projectId, nodeId);
    const current = useGraphStore.getState().project?.nodes[nodeId];
    const last = current?.chat?.turns.at(-1);
    const answer = current?.versions.find((version) => version.createdAt === last?.selectedVersionCreatedAt);
    if (!alreadyHydrated && !getChatDraft(projectId, nodeId).text && answer?.chat?.state === 'interrupted') {
      runtime.setDraft(projectId, nodeId, { text: answer.chat.question,
        reference: answer.chat.reference, attachments: answer.chat.attachments, editingTurnId: answer.chat.turnId });
    }
    return () => useFollowUpFocusStore.getState().setFocused(false);
  }, [projectId, nodeId]);
  useEffect(() => {
    const current = getChatDraft(projectId, nodeId);
    // A local draft can outlive a synced/deleted turn. Never silently apply
    // an old edit to the new last message; keep its text as an ordinary draft.
    if (current.editingTurnId && current.editingTurnId !== node?.chat?.turns.at(-1)?.id) {
      setDraft(projectId, nodeId, { text: current.text, reference: current.reference, attachments: current.attachments });
    }
  }, [projectId, nodeId, node?.chat?.turns, setDraft]);
  useEffect(() => {
    if (!node?.generating && !compacting) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented
        || document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); event.stopPropagation(); stopChat(nodeId);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [nodeId, node?.generating, compacting]);
  const editText = (text: string) => {
    const panel = useCitationPanelStore.getState();
    if (panel.nodeId === nodeId && panel.mode === 'fact-check') panel.close();
    setDraft(projectId, nodeId, { ...draft, text });
  };
  const newline = () => {
    const start = area.current?.selectionStart ?? draft.text.length;
    const end = area.current?.selectionEnd ?? start;
    editText(`${draft.text.slice(0, start)}\n${draft.text.slice(end)}`);
    requestAnimationFrame(() => area.current?.setSelectionRange(start + 1, start + 1));
  };
  return <div className="node-followup-bar chat-composer" onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}>
    {reference && <button type="button" className="chat-answer-reference"
      aria-label={`Stop asking about: ${reference.title}`} data-tip="Click to stop asking about this passage or answer"
      onClick={() => {
        if (selection?.nodeId === nodeId) {
          useNodeTextSelectionStore.getState().clear();
          window.getSelection()?.removeAllRanges();
        }
        setDraft(projectId, nodeId, { ...draft, reference: undefined });
      }}>
      <span>Asking about: {reference.title}</span>
    </button>}
    <div className="chat-composer-input-row">
    <textarea ref={area} className="node-followup-input" rows={3} value={draft.text} disabled={compacting}
      placeholder={draft.editingTurnId ? 'Edit your last question…' : 'Ask a question…'}
      aria-label="Chat message" onChange={(event) => editText(event.target.value)}
      onFocus={() => useFollowUpFocusStore.getState().setFocused(true)}
      onBlur={() => useFollowUpFocusStore.getState().setFocused(false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        const modifier = event.metaKey || event.ctrlKey;
        if (event.shiftKey || (enterSends && modifier)) { event.preventDefault(); newline(); return; }
        if (enterSends || modifier) {
          event.preventDefault();
          if (!busy && availability.available && (draft.text.trim() || draft.attachments?.length)) void submitChat(nodeId);
        }
      }} />
    <div className="node-followup-actions chat-composer-send-column">
      <button type="button" className="node-followup-btn chat-send" aria-label={busy ? 'Stop generating' : draft.editingTurnId ? 'Save and resend' : 'Send message'}
        data-tip={busy ? 'Stop generating (Esc)' : 'Send message'}
        disabled={!busy && (!availability.available || (!draft.text.trim() && !draft.attachments?.length))}
        onClick={() => busy ? stopChat(nodeId) : void submitChat(nodeId)}>
        {busy ? <Square size={14} /> : <><ArrowUp size={14} />{draft.editingTurnId ? 'Save & resend' : 'Send'}</>}
      </button>
      <button type="button" className="node-followup-btn chat-attach" aria-label="Attach files" data-tip="Attach images or files to this message"
        disabled={compacting} onClick={() => setAttaching(true)}><Paperclip size={14} />Attach</button>
    </div>
    </div>
    {!!draft.attachments?.length && <div className="chat-attachment-list" aria-label="Attached files">
      {draft.attachments.map((item) => <span className="chat-attachment-chip" key={item.id}>
        {item.kind === 'image' ? <ImageIcon size={14} /> : <FileText size={14} />}<span title={item.name}>{item.name}</span>
        <button type="button" aria-label={`Remove ${item.name}`} onClick={() => setDraft(projectId, nodeId,
          { ...draft, attachments: draft.attachments?.filter((file) => file.id !== item.id) })}><X size={14} /></button>
      </span>)}
    </div>}
    {(draft.editingTurnId || !availability.available) && <div className="node-followup-actions chat-composer-actions">
      {draft.editingTurnId && !busy && <button type="button" className="node-followup-btn" onClick={() => cancelChatEdit(nodeId)}>Cancel edit</button>}
      {!availability.available && <span className="chat-composer-hint">{availability.reason}</span>}
    </div>}
    {error && <div className="chat-composer-error" role="alert">{error}</div>}
    {attaching && <ChatAttachmentOverlay projectId={projectId} nodeId={nodeId} onClose={() => setAttaching(false)} />}
  </div>;
}
