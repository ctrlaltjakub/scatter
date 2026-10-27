'use client';
import { useMemo, useState } from 'react';
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, FileText, ListRestart, SearchCheck, Square, Trash } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { factCheckTaskKey, useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import { factCheckAvailability, startFactCheck, stopFactCheck } from '@/lib/factCheck';
import { canResumeFactCheck } from '@/lib/factCheckCore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { redoTermMarking, cancelNodeGeneration } from '@/lib/generate';
import { AddNodeMenu } from '@/components/canvas/AddNodeMenu';
import { ChatPanelGroup } from './ChatPanelControls';
import { VersionCounter } from '@/components/VersionCounter';
import { useGraphStore } from '@/store/useGraphStore';
import { removeNodeVersion } from '@/lib/nodeVersions';
import { useEditorStore } from '@/store/useEditorStore';
import { AnswerImageActions } from './AnswerImageActions';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { useSidePanelDisclosure } from '../canvas/SidePanelDisclosure';
import { EditHeaderButton } from '../node/EditHeaderButton';
import { answerEnrichmentError } from '@/lib/chat/sharedEnrichment';
import { redoChatTerms } from '@/lib/chat/enrichment';
import { AddToProjectSourcesButton } from '../node/AddToProjectSourcesButton';

export function AnswerSideActions({ node }: { node: ScatterNode }) {
  const [error, setError] = useState('');
  const [editOpen, setEditOpen] = useSidePanelDisclosure('text');
  const [, setFactOpen] = useSidePanelDisclosure('fact');
  const version = node.versions[node.currentVersionIndex]!;
  const displayedGenerating = !!node.generating
    && (node.generatingVersionIndex == null || node.generatingVersionIndex === node.currentVersionIndex);
  useSettingsStore((state) => state.activeModelRef);
  useSettingsStore((state) => state.providers);
  useModelCatalogStore((state) => state.catalog);
  const showing = useCitationPanelStore((state) => state.nodeId === node.id && state.mode === 'fact-check');
  const checking = useFactCheckTaskStore((state) => !!state.tasks[factCheckTaskKey(node.id, version.createdAt)]?.running);
  const marking = useNodeStatusStore((state) => state.processes[node.id]?.[`chat-terms-${version.createdAt}`]?.clearedAt === null);
  const runtimeTermError = useChatRuntimeStore((state) => state.views[node.id]?.termErrors?.[version.createdAt]);
  const termError = answerEnrichmentError(version) ?? runtimeTermError;
  const report = version.factCheck?.pending ?? version.factCheck?.complete;
  const canResume = useMemo(() => canResumeFactCheck(version), [version]);
  const available = factCheckAvailability();
  const check = (mode: 'new' | 'continue' | 'again') => {
    setError('');
    void startFactCheck(node.id, mode).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Fact check could not start.'));
  };
  const switchVersion = (delta: number) => useGraphStore.getState().updateNode(node.id, {
    currentVersionIndex: Math.max(0, Math.min(node.versions.length - 1, node.currentVersionIndex + delta)),
  });
  const remove = () => {
    const current = useGraphStore.getState().project?.nodes[node.id];
    const index = current?.versions.findIndex(candidate => candidate.createdAt === version.createdAt) ?? -1;
    if (!current || index < 0) return;
    if (current.generating && (current.generatingVersionIndex == null || current.generatingVersionIndex === index)) {
      cancelNodeGeneration(node.id, { discardCurrentWork: true }); return;
    }
    if (current.versions.length === 1) useGraphStore.getState().deleteNodeCascade(node.id);
    else {
      const patch = removeNodeVersion(current, version.createdAt);
      if (patch) useGraphStore.getState().updateNode(node.id, patch);
    }
  };
  const editTextAction = <button type="button" className="side-action" onClick={() => useEditorStore.getState().openEditor(node.id)}>
    <span className="side-action-icon"><FileText size={15} /></span>Edit or export text
  </button>;
  return <div className="side-panel-content answer-side-actions">
    <div className="versions-row">
      <div className="versions-row-cluster">
        <button type="button" disabled={node.currentVersionIndex === 0 || !!node.generating} onClick={() => switchVersion(-1)} aria-label="Previous version" data-tip="Previous version"><ChevronLeft size={14} /></button>
        <VersionCounter current={node.currentVersionIndex + 1} total={node.versions.length} />
        <button type="button" disabled={node.currentVersionIndex === node.versions.length - 1 || !!node.generating} onClick={() => switchVersion(1)} aria-label="Next version" data-tip="Next version"><ChevronRight size={14} /></button>
      </div>
      <div className="versions-row-actions">
        <button type="button" disabled={!!node.generating || marking || !version.body.trim()} aria-label="Redo term marking"
          data-tip="Re-mark clickable terms and retry missing previews. Undo restores the previous markings."
          onClick={() => void (version.chat && !version.markdownNote
            ? redoChatTerms(node.id, { turnId: version.chat.turnId, versionCreatedAt: version.createdAt })
            : redoTermMarking(node.id))}><ListRestart size={14} /></button>
        <button type="button" aria-label="Delete" data-tip={displayedGenerating ? 'Stop generation and delete current work' : 'Delete version (or whole node)'} onClick={remove}><Trash size={14} /></button>
      </div>
    </div>
    <AddNodeMenu key={node.id} nodeId={node.id} />
    {version.markdownNote ? <>
      <button type="button" className={`side-action side-disclosure-trigger${editOpen ? ' toggled' : ''}`}
        aria-expanded={editOpen} aria-controls={`node-text-tools-${node.id}`}
        data-tip="Edit the header, or edit and export this node's text" onClick={() => setEditOpen(!editOpen)}>
        <span className="side-action-icon"><FileText size={15} /></span>
        <span className="side-action-label">Edit</span>
        <span className="side-disclosure-chevron"><ChevronRight size={14} className="sc-collapse-chevron"
          style={{ transform: editOpen ? 'rotate(90deg)' : undefined }} /></span>
      </button>
      <AnimatedCollapse open={editOpen} id={`node-text-tools-${node.id}`}>
        <div className="side-disclosure-content">
          <EditHeaderButton node={node} />
          {editTextAction}
        </div>
      </AnimatedCollapse>
    </> : <EditHeaderButton node={node} />}
    <AddToProjectSourcesButton version={version} disabled={!!node.generating} />
    <ChatPanelGroup node={node} />
    {report && <button type="button" className={`side-action side-disclosure-trigger${showing ? ' toggled' : ''}`}
      disabled={!report && !available.available} aria-expanded={!!report && showing}
      data-tip={report ? 'Show or hide the evidence for this answer' : available.reason ?? 'Check this answer against web sources'}
      onClick={() => {
        setFactOpen(!showing);
        if (!report) check('new');
        else if (showing) useCitationPanelStore.getState().close();
        else useCitationPanelStore.getState().openFact(node.id, version.createdAt);
      }}>
      <span className="side-action-icon">{report ? <SearchCheck size={15} /> : <Check size={15} />}</span>
      <span className="side-action-label">{report ? `${showing ? 'Hide' : 'Show'} fact-check results` : 'Fact-check'}</span>
      {report && <span className="side-disclosure-chevron">{showing ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>}
    </button>}
    <AnimatedCollapse open={!!showing && !!report}><div className="side-disclosure-content">
      <button type="button" className="side-action" disabled={!checking && !available.available}
        onClick={() => checking ? stopFactCheck(node.id, version.createdAt) : check(canResume ? 'continue' : 'again')}>
        <span className="side-action-icon">{checking ? <Square size={15} /> : <CheckCheck size={15} />}</span>
        {checking ? 'Stop checking' : canResume ? 'Continue check' : 'Check again'}
      </button>
    </div></AnimatedCollapse>
    <AnswerImageActions node={node} />
    {!report && <button type="button" className="side-action" disabled={!available.available}
      data-tip={available.reason ?? 'Check this answer against web sources'} onClick={() => check('new')}>
      <span className="side-action-icon"><Check size={15} /></span>Fact-check
    </button>}
    {!version.markdownNote && editTextAction}
    {(error || termError) && <p className="chat-composer-error" role="status">{error || termError}</p>}
  </div>;
}
