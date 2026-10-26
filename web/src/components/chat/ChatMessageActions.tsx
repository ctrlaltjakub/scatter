'use client';
import { memo, useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, ChevronDown, ChevronRight, Copy, GitFork, MessageSquareQuote,
  ListRestart, Pencil, RotateCcw, SearchCheck, SpellCheck, Square, SquareArrowOutUpRight, Trash } from 'lucide-react';
import type { NodeVersion } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { factCheckTaskKey, useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import { factCheckAvailability, startFactCheck, stopFactCheck } from '@/lib/factCheck';
import { activateChatAnswer, askAboutChatAnswer, deleteLastChatTurn, editLastChatQuestion,
  forkChat, spawnChatAnswer, submitChat } from '@/lib/chat/actions';
import { stripChips } from '@/lib/bulletParse';
import { useGraphStore } from '@/store/useGraphStore';
import { chatDraftKey, useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { redoChatTerms } from '@/lib/chat/enrichment';
import { answerEnrichmentError } from '@/lib/chat/sharedEnrichment';
import { AddToProjectSourcesButton } from '../node/AddToProjectSourcesButton';

export function CopyMessage({ text, panel = false }: { text: string; panel?: boolean }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className={panel ? 'side-action' : undefined} data-tip={status === 'failed' ? 'Could not copy. Select the text and copy it manually.' : 'Copy this message'}
    onClick={() => {
      void (async () => {
        try { await navigator.clipboard.writeText(text); setStatus('copied'); }
        catch { setStatus('failed'); }
        clearTimeout(timer.current); timer.current = setTimeout(() => setStatus('idle'), 2000);
      })();
    }}><span className={panel ? 'side-action-icon' : undefined}>{status === 'copied' ? <Check size={panel ? 15 : 14} /> : <Copy size={panel ? 15 : 14} />}</span><span aria-live="polite">{status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy text'}</span></button>;
}

export const ChatUserActions = memo(function ChatUserActions({ nodeId, question, latest, busy }:
  { nodeId: string; question: string; latest: boolean; busy: boolean }) {
  return <div className="chat-message-actions chat-user-actions" data-reading-exclude="true" role="group" aria-label="Question actions">
    <CopyMessage text={question} />
    {latest && <>
      <button type="button" disabled={busy} data-tip="Generate another answer to the latest question"
        onClick={() => void submitChat(nodeId, { regenerate: true })}><RotateCcw size={14} />Regenerate</button>
      <button type="button" disabled={busy} data-tip="Edit the latest question"
        onClick={() => editLastChatQuestion(nodeId)}><Pencil size={14} />Edit</button>
      <button type="button" disabled={busy} data-tip="Delete this question and its answer versions. Undo restores the turn."
        onClick={() => deleteLastChatTurn(nodeId)}><Trash size={14} />Delete turn</button>
    </>}
  </div>;
});

export const ChatAssistantActions = memo(function ChatAssistantActions({ nodeId, version, latest, busy }:
  { nodeId: string; version: NodeVersion; latest: boolean; busy: boolean }) {
  const [error, setError] = useState('');
  const projectId = useGraphStore((state) => state.project?.id ?? '');
  const markingTerms = useNodeStatusStore((state) => state.processes[nodeId]?.[`chat-terms-${version.createdAt}`]?.clearedAt === null);
  const runtimeTermError = useChatRuntimeStore((state) => state.views[nodeId]?.termErrors?.[version.createdAt]);
  const termError = answerEnrichmentError(version) ?? runtimeTermError;
  const askingAbout = useChatRuntimeStore((state) => {
    const reference = state.drafts[chatDraftKey(projectId, nodeId)]?.reference;
    return reference?.turnId === version.chat?.turnId && reference?.versionCreatedAt === version.createdAt;
  });
  useSettingsStore((state) => state.activeModelRef);
  useSettingsStore((state) => state.providers);
  useModelCatalogStore((state) => state.catalog);
  const showingFacts = useCitationPanelStore((state) => state.nodeId === nodeId && state.mode === 'fact-check'
    && state.factVersionCreatedAt === version.createdAt);
  const factRunning = useFactCheckTaskStore((state) => !!state.tasks[factCheckTaskKey(nodeId, version.createdAt)]?.running);
  const meta = version.chat!;
  const ref = { turnId: meta.turnId, versionCreatedAt: version.createdAt };
  const generating = meta.state === 'generating';
  const report = version.factCheck?.pending ?? version.factCheck?.complete;
  const complete = version.factCheck?.complete;
  const available = factCheckAvailability();
  const canCheck = !generating && !!version.body.trim() && available.available;
  const check = (mode: 'new' | 'again' | 'continue') => {
    if (!canCheck) return;
    activateChatAnswer(nodeId, ref); setError('');
    void startFactCheck(nodeId, mode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Fact check could not start.'));
  };
  return <div className="chat-answer-controls" data-reading-exclude="true">
    <div className="chat-message-actions" role="group" aria-label="Answer actions">
      <CopyMessage text={stripChips(version.body)} />
      <AddToProjectSourcesButton version={version} disabled={generating} panel={false} />
      <button type="button" disabled={generating || !version.body.trim()} data-tip="Show this answer in a separate text node, not a chat, preserving its formatting, terms and sources"
        onClick={(event) => { event.stopPropagation(); spawnChatAnswer(nodeId, ref); }}><SquareArrowOutUpRight size={14} />Copy to node</button>
      <button type="button" disabled={generating || busy} data-tip="Fork a new chat through this answer, preserving the conversation so far"
        onClick={() => forkChat(nodeId, ref)}><GitFork size={14} />Fork</button>
      <button type="button" disabled={generating} aria-pressed={askingAbout}
        data-tip={askingAbout ? 'Stop asking about this answer' : 'Ask a follow-up about this exact answer'}
        onClick={() => askAboutChatAnswer(nodeId, ref)}><MessageSquareQuote size={14} />Ask about</button>
      <button type="button" disabled={generating || markingTerms || !version.body.trim()}
        data-tip={termError ?? (markingTerms ? 'Terms are being marked' : 'Redo clickable term marking for this answer. Undo restores the previous markings.')}
        onClick={() => void redoChatTerms(nodeId, ref)}><ListRestart size={14} />{markingTerms ? 'Marking terms…' : 'Redo terms'}</button>
      <button type="button" disabled={!report && !canCheck} aria-expanded={!!report && showingFacts} aria-pressed={showingFacts}
        data-tip={report ? 'Show or hide the evidence for this answer' : available.reason ?? 'Check only this answer against web sources'}
        onClick={() => {
          if (!report) check('new');
          else if (showingFacts) useCitationPanelStore.getState().close();
          else { activateChatAnswer(nodeId, ref); useCitationPanelStore.getState().openFact(nodeId, version.createdAt); }
        }}>
        {report ? <SearchCheck size={14} /> : <Check size={14} />}{report ? (showingFacts ? 'Hide fact-check' : 'Show fact-check') : 'Fact-check'}
        {report && (showingFacts ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
    </div>
    {report && showingFacts && <div className="chat-message-actions chat-fact-actions" role="group" aria-label="Fact-check actions">
      <button type="button" disabled={!factRunning && !canCheck} onClick={() => factRunning ? stopFactCheck(nodeId, version.createdAt)
        : check(version.factCheck?.pending ? 'continue' : 'again')}>
        {factRunning ? <Square size={14} /> : <CheckCheck size={14} />}{factRunning ? 'Stop checking' : version.factCheck?.pending ? 'Continue check' : 'Check again'}
      </button>
      <button type="button" disabled={busy || factRunning || !!version.factCheck?.pending || !complete}
        onClick={() => {
          if (!complete) return;
          activateChatAnswer(nodeId, ref);
          const target = latest ? nodeId : forkChat(nodeId, ref);
          if (target) void submitChat(target, { regenerate: true, evidence: complete });
        }}><SpellCheck size={14} />{latest ? 'Rewrite with evidence' : 'Fork and rewrite with evidence'}</button>
    </div>}
    {error && <p className="chat-composer-error" role="alert">{error}</p>}
    {termError && <p className="chat-composer-error" role="status">{termError}</p>}
  </div>;
});
