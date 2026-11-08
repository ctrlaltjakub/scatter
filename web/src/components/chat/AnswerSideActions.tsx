'use client';
import { useMemo, useState } from 'react';
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ListRestart, SearchCheck, SpellCheck, Square, Trash } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { factCheckTaskKey, useFactCheckTaskStore } from '@/store/useFactCheckTaskStore';
import { factCheckAvailability, startFactCheck, stopFactCheck } from '@/lib/factCheck';
import { canResumeFactCheck } from '@/lib/factCheckCore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { redoTermMarking, cancelNodeGeneration, rewriteNodeWithEvidence } from '@/lib/generate';
import { AddNodeMenu } from '@/components/canvas/AddNodeMenu';
import { NodeTextEditMenu } from '@/components/canvas/NodeTextEditMenu';
import { ChatPanelGroup } from './ChatPanelControls';
import { VersionCounter } from '@/components/VersionCounter';
import { useGraphStore } from '@/store/useGraphStore';
import { removeNodeVersion } from '@/lib/nodeVersions';
import { AnswerImageActions } from './AnswerImageActions';
import { AnimatedCollapse } from '../AnimatedCollapse';
import { useSidePanelDisclosure } from '../canvas/SidePanelDisclosure';
import { answerEnrichmentError } from '@/lib/chat/sharedEnrichment';
import { redoChatTerms } from '@/lib/chat/enrichment';
import { AddToProjectSourcesButton } from '../node/AddToProjectSourcesButton';

export function AnswerSideActions({ node }: { node: ScatterNode }) {
  const [error, setError] = useState('');
  const [, setFactOpen] = useSidePanelDisclosure('fact');
  const version = node.versions[node.currentVersionIndex]!;
  const displayedGenerating = !!node.generating
    && (node.generatingVersionIndex == null || node.generatingVersionIndex === node.currentVersionIndex);
  useSettingsStore((state) => state.activeModelRef);
  useSettingsStore((state) => state.providers);
  useModelCatalogStore((state) => state.catalog);
  const showing = useCitationPanelStore((state) => state.nodeId === node.id && state.mode === 'fact-check' && state.factVersionCreatedAt === version.createdAt);
  const checking = useFactCheckTaskStore((state) => !!state.tasks[factCheckTaskKey(node.id, version.createdAt)]?.running);
  const marking = useNodeStatusStore((state) => state.processes[node.id]?.[`chat-terms-${version.createdAt}`]?.clearedAt === null);
  const runtimeTermError = useChatRuntimeStore((state) => state.views[node.id]?.termErrors?.[version.createdAt]);
  const termError = answerEnrichmentError(version) ?? runtimeTermError;
  const report = version.factCheck?.pending ?? version.factCheck?.complete;
  const canResume = useMemo(() => canResumeFactCheck(version), [version]);
  const available = factCheckAvailability(version);
  const canCheck = available.available && !displayedGenerating;
  const complete = version.factCheck?.complete;
  const canRewrite = !!complete && !checking && !version.factCheck?.pending && !node.generating && !!version.body.trim();
  const check = (mode: 'new' | 'continue' | 'again') => {
    if (!canCheck) return;
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
    <NodeTextEditMenu node={node} />
    <ChatPanelGroup node={node} />
    <AnswerImageActions node={node} />
    {report ? <button type="button" className={`side-action side-disclosure-trigger${showing ? ' toggled' : ''}`}
      aria-expanded={showing} aria-controls={`node-fact-tools-${node.id}`}
      data-tip="Show or hide the evidence for this answer"
      onClick={() => {
        setFactOpen(!showing);
        if (showing) useCitationPanelStore.getState().close();
        else useCitationPanelStore.getState().openFact(node.id, version.createdAt);
      }}>
      <span className="side-action-icon"><SearchCheck size={15} /></span>
      <span className="side-action-label">{showing ? 'Hide' : 'Show'} fact-check results</span>
      <span className="side-disclosure-chevron">{showing ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
    </button> : <button type="button" className="side-action" disabled={!canCheck}
      data-tip={available.reason ?? 'Check this answer against web sources'} onClick={() => check('new')}>
      <span className="side-action-icon"><Check size={15} /></span>Fact-check
    </button>}
    <AnimatedCollapse open={showing && !!report} id={`node-fact-tools-${node.id}`}><div className="side-disclosure-content">
      <button type="button" className="side-action" disabled={!checking && !canCheck}
        onClick={() => checking ? stopFactCheck(node.id, version.createdAt) : check(canResume ? 'continue' : 'again')}>
        <span className="side-action-icon">{checking ? <Square size={15} /> : <CheckCheck size={15} />}</span>
        {checking ? 'Stop checking' : canResume ? 'Continue check' : 'Check again'}
      </button>
      <button type="button" className="side-action" disabled={!canRewrite}
        data-tip="Create a corrected new version using this evidence without searching again"
        onClick={() => { if (canRewrite) void rewriteNodeWithEvidence(node.id, complete); }}>
        <span className="side-action-icon"><SpellCheck size={15} /></span>Rewrite with evidence
      </button>
    </div></AnimatedCollapse>
    <AddToProjectSourcesButton version={version} disabled={!!node.generating} />
    {(error || termError) && <p className="chat-composer-error" role="status">{error || termError}</p>}
  </div>;
}
