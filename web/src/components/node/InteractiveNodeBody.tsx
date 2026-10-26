'use client';
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Check, Eye, Info, LoaderCircle, Pause, RotateCcw, RotateCw, SquareMousePointer, TriangleAlert } from 'lucide-react';
import type { ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { InteractiveExplanationView } from './InteractiveExplanationView';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { interactiveDisplaySize, preferredInteractiveViewport, validateInteractiveDocument } from '@/lib/interactiveDocument';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { modelDisplayName } from '@/lib/modelDisplay';
import { interactiveNeedsVerification } from '@/lib/interactiveRetry';

export function InteractiveNodeBody({ node, active, presentation = 'canvas' }: { node: ScatterNode; active: boolean; presentation?: 'canvas' | 'viewer' }) {
  const version = node.versions[node.currentVersionIndex]!;
  const build = version.interactiveBuild;
  const busy = !!node.generating && node.generatingVersionIndex === node.currentVersionIndex;
  const previewingDraft = useInteractiveViewerStore(state => presentation === 'viewer' && state.open
    && state.nodeId === node.id && state.draftCreatedAt === version.createdAt);
  const draft = useMemo(() => {
    if (busy || !build?.draftHtml) return {};
    // View anyway bypasses quality checks, never the document's safety rules.
    try { return { html: validateInteractiveDocument(build.draftHtml) }; }
    catch (error) { return { error: (error as Error).message }; }
  }, [busy, build?.draftHtml]);
  const interactive = version.interactive ?? (previewingDraft && draft.html && build ? {
    html: draft.html, request: build.request, providerId: build.providerId ?? '', model: build.model ?? '',
    viewportWidth: build.viewportWidth ?? preferredInteractiveViewport(draft.html).width,
    viewportHeight: build.viewportHeight ?? preferredInteractiveViewport(draft.html).height,
  } : undefined);
  const size = interactiveDisplaySize(interactive, presentation === 'viewer');
  const accent = useGraphStore(state => {
    const project = state.project;
    return (node.groupId ? project?.groups[node.groupId]?.color : undefined) ?? project?.color;
  });
  const logRef = useRef<HTMLDivElement>(null);
  const followLog = useRef(true);
  useEffect(() => { followLog.current = true; }, [node.id, version.createdAt]);
  useEffect(() => {
    if (busy && followLog.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [busy, build?.steps]);
  const viewDraft = () => {
    if (!draft.html) return;
    useInteractiveViewerStore.getState().openViewer(node.id, node.currentVersionIndex, version.createdAt);
  };
  const error = node.generationError || build?.error;
  return <div className={`node-body interactive-node-body interactive-node-body--${presentation}`} style={{
    '--interactive-width': `${size.width}px`, '--interactive-height': `${size.height}px`,
    width: size.width, height: size.height, minHeight: size.height,
  } as CSSProperties}>
    {interactive?.html && !busy ? <InteractiveExplanationView
      nodeId={node.id} versionIndex={node.currentVersionIndex} interactive={interactive}
      active={active} generating={false} accent={accent} presentation={presentation} unverifiedDraft={previewingDraft || build?.acceptedByUser} />
      : build ? <section className="interactive-build" aria-label="Interactive build progress">
        <div className="interactive-build-heading"><SquareMousePointer size={22} /><span>{busy ? `Generating an interactive node${build.model ? ` with ${modelDisplayName(build.model)}` : ''}` : build.state === 'stopped' ? 'Creation stopped' : 'Creation needs attention'}</span></div>
        <div ref={logRef} className="interactive-build-log" role="log" aria-live="polite" aria-relevant="additions text"
          onWheel={event => { if (event.deltaY < 0 && !event.ctrlKey && !event.metaKey) followLog.current = false; }}
          onScroll={event => {
            const log = event.currentTarget;
            followLog.current = log.scrollHeight - log.clientHeight - log.scrollTop <= 4;
          }}>
          {build.steps.map(step => <div key={step.id} className={`interactive-build-step is-${step.kind ?? step.state}`}>
            {step.kind==='info' ? <Info size={14} /> : step.kind==='paused' && busy ? <Pause size={14} /> : step.state==='running' && busy ? <LoaderCircle size={14} /> : step.state==='failed' ? <TriangleAlert size={14} /> : <Check size={14} />}
            <div><span>{step.label}{step.state==='running' && busy && step.kind!=='paused' ? '…' : ''}</span>{step.detail && <small>{step.detail}</small>}</div>
          </div>)}
        </div>
        {error && <p className="interactive-build-error" role="alert">{error}</p>}
        {!busy && (build.draftHtml ? <div className="interactive-build-recovery">
          <p>{build.limitReached ? 'Automatic repair stopped.' : 'Your latest draft is saved.'} <span>Choose how to continue.</span></p>
          <div className="interactive-build-recovery-actions">
            <button type="button" className="btn" disabled={!draft.html} data-tip="View the saved program without using AI credits" onClick={viewDraft}><Eye size={16} />View anyway</button>
            <button type="button" className="btn interactive-build-continue" data-tip={interactiveNeedsVerification(build) ? 'Retry browser checks and AI review before editing code; AI review uses tokens' : 'Make one targeted repair and review it; uses AI tokens'} onClick={()=>void buildInteractiveNode(node.id, undefined, 'repair')}><RotateCw size={16} />{interactiveNeedsVerification(build) ? 'Retry verification' : 'Run one more pass'}</button>
            <button type="button" className="btn" data-tip="Generate a new plan and program; uses AI tokens" onClick={()=>void buildInteractiveNode(node.id)}><RotateCcw size={16} />Start over</button>
          </div>
          <small>{draft.error ? `Preview unavailable: ${draft.error}` : 'The preview may contain errors. Viewing uses no tokens; generating uses your selected interactive model.'}</small>
        </div> : <button type="button" className="btn" onClick={()=>void buildInteractiveNode(node.id)}>Try again</button>)}
      </section> : <div className="node-empty-copy interactive-node-empty">
        <SquareMousePointer size={38} strokeWidth={1.3} aria-hidden="true" />
        <strong>Make something interactive</strong>
        <p>Describe a simulation, tool, diagram, game, or idea in the field below.</p>
        {node.generationError && <p className="interactive-build-error" role="alert">{node.generationError}</p>}
      </div>}
  </div>;
}
