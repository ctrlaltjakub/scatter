'use client';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Maximize2, Search, X } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { GoogleSearchSuggestions } from '@/components/node/GoogleSearchSuggestions';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { colorToCss } from '@/lib/groupColor';
import { computePanelTargetOffset, stepPanelMotion, PANEL_MOTION, type PanelMotionState } from '@/lib/panelFollow';
import { PANEL_GAP } from '@/components/canvas/NodeSidePanel';
import type { FactCheckReport, FreeImageSourceOutcome } from '@/store/types';
import { wikimediaTaskKey, useWikimediaTaskStore } from '@/store/useWikimediaTaskStore';
import { startWikimediaDiscovery, stopWikimediaDiscovery } from '@/lib/wikimediaDiscovery';
import { useWikimediaGalleryStore } from '@/store/useWikimediaGalleryStore';
import { spawnFreeImageNode } from '@/lib/wikimediaSpawn';
import {
  displayFreeImageCredit,
  freeImageLandingPage,
  freeImageSource,
  freeImageSourceId,
  freeImageSourceLabel,
  getFreeImageRecommendationSet,
} from '@/lib/freeImageRecommendations';
import { ResilientFreeImage } from '@/components/wikimedia/ResilientFreeImage';
import { ChatOutlinePanel } from '@/components/chat/ChatOutlinePanel';
import { useChatTableStore } from '@/store/useChatTableStore';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

export const WIDE_RIGHT_PANEL_W = 372;

export function rightPanelFallbackWidth(_mode: 'fact-check' | 'wikimedia' | 'conversation' | null): number {
  return WIDE_RIGHT_PANEL_W;
}

/**
 * Evidence, free-image, and conversation panels beside the selected node.
 * Only one is open at a time (useCitationPanelStore). Lives in canvas-world space; its transform
 * is driven imperatively each frame so it stays glued to the node's right edge,
 * the same PANEL_GAP away as the left/bottom panels.
 */
export function NodeCitationsPanel() {
  const mode = useCitationPanelStore((s) => s.mode);
  const imageTarget = useCitationPanelStore((s) => `${s.nodeId}:${s.wikimediaVersionCreatedAt}`);
  const tableOpen = useChatTableStore((s) => !!s.target);
  if (tableOpen) return null;
  if (mode === 'conversation') return <ChatOutlinePanel />;
  if (mode === 'wikimedia') return <NodeWikimediaPanel key={imageTarget} />;
  if (mode === 'fact-check') return <NodeFactCheckPanel />;
  return null;
}

function NodeWikimediaPanel() {
  const nodeId = useCitationPanelStore((state) => state.nodeId);
  const versionCreatedAt = useCitationPanelStore((state) => state.wikimediaVersionCreatedAt);
  const close = useCitationPanelStore((state) => state.close);
  const selection = useGraphStore((state) => state.project?.selection);
  const node = useGraphStore((state) => nodeId ? state.project?.nodes[nodeId] : undefined);
  const version = node?.versions[node.currentVersionIndex];
  const projectColor = useGraphStore((state) => {
    if (!nodeId || !state.project) return null;
    const current = state.project.nodes[nodeId];
    return (current?.groupId ? state.project.groups[current.groupId]?.color : undefined)
      ?? state.project.color
      ?? null;
  });
  const taskKey = nodeId && versionCreatedAt != null ? wikimediaTaskKey(nodeId, versionCreatedAt) : '';
  const task = useWikimediaTaskStore((state) => taskKey ? state.tasks[taskKey] : undefined);
  const running = task?.running ?? false;
  const recommendationSet = getFreeImageRecommendationSet(version);
  const results = recommendationSet?.results ?? [];
  const sourceOutcomes = task?.sourceOutcomes ?? recommendationSet?.sourceOutcomes ?? [];
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(() => recommendationSet?.manualQuery ?? version?.header ?? '');
  const [spawningTitle, setSpawningTitle] = useState<string | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);

  const panelStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!projectColor) return undefined;
    const color = colorToCss(projectColor);
    return {
      '--tint-1': `color-mix(in oklab, ${color} 5%, transparent)`,
      '--tint-2': `color-mix(in oklab, ${color} 10%, transparent)`,
      '--tint-3': `color-mix(in oklab, ${color} 22%, transparent)`,
      '--control-accent': color,
    } as React.CSSProperties;
  }, [projectColor]);

  useLayoutEffect(() => {
    if (!nodeId) return;
    let frame = 0;
    const follow = () => {
      const element = panelRef.current;
      const project = useGraphStore.getState().project;
      const current = project?.nodes[nodeId];
      const nodeElement = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
      if (element && current && nodeElement) {
        const zoom = useLiveViewportStore.getState().zoom || 1;
        const rect = nodeElement.getBoundingClientRect();
        const live = useLivePositionsStore.getState().positions[nodeId];
        const x = live?.x ?? current.position.x;
        const y = live?.y ?? current.position.y;
        // Evidence review contains full-width
        // images followed by text and actions. A max-height alone leaves the
        // flex column's available height indefinite, so the first image can
        // consume the intrinsic layout while everything below it is merely
        // clipped. Give the panel a real viewport and let `.citations-list`
        // own the scrolling.
        const panelHeight = Math.max(320, rect.height / zoom);
        element.style.height = `${panelHeight}px`;
        element.style.maxHeight = `${panelHeight}px`;
        element.style.transform = `translate3d(${x + rect.width / zoom + PANEL_GAP}px, ${y}px, 0)`;
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [nodeId]);

  useEffect(() => {
    if (nodeId && !(selection?.length === 1 && selection[0] === nodeId)) close();
  }, [nodeId, selection, close]);
  useEffect(() => {
    if (!node || !version || version.createdAt !== versionCreatedAt) close();
  }, [node, version, versionCreatedAt, close]);

  if (!nodeId || versionCreatedAt == null || !node || !version || version.createdAt !== versionCreatedAt) return null;

  const rerun = (manualQuery: string, loadMore = false) => {
    void startWikimediaDiscovery(nodeId, versionCreatedAt, {
      rerun: true,
      manualQuery: manualQuery.trim(), loadMore,
    });
  };
  const spawn = async (result: (typeof results)[number]) => {
    setSpawningTitle(`${freeImageSource(result)}:${freeImageSourceId(result)}`);
    setSpawnError(null);
    try {
      await spawnFreeImageNode(nodeId, result);
    } catch (error) {
      setSpawnError((error as Error).message);
    } finally {
      setSpawningTitle(null);
    }
  };
  const hasExtremeAspectRatio = (result: (typeof results)[number]) => {
    if (!result.width || !result.height) return false;
    const ratio = result.width / result.height;
    return ratio < 0.45 || ratio > 3.5;
  };

  return (
    <div
      ref={panelRef}
      className="side-panel citations-panel wikimedia-panel"
      data-canvas-right-panel
      style={panelStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="citations-panel-head">
        <span>{recommendationSet?.mode === 'manual' || !recommendationSet ? 'Image search' : 'Image suggestions'}</span>
        <button className="citations-close-btn" type="button" onClick={() => close()} aria-label="Close image suggestions"><X size={13} /></button>
      </div>
      <form className="wikimedia-panel-tools" onSubmit={(event) => { event.preventDefault(); if (!running && query.trim()) rerun(query); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search image catalogs…" aria-label="Search free images" maxLength={200} autoFocus={!recommendationSet} />
        {running ? <button type="button" className="icon-btn" aria-label="Stop image search"
          onClick={() => stopWikimediaDiscovery(nodeId, versionCreatedAt)}><X size={15} /></button>
          : <button type="submit" className="icon-btn" disabled={!query.trim()} aria-label="Search images"><Search size={15} /></button>}
      </form>
      <div className="wikimedia-search-summary">
        {recommendationSet && recommendationSet.mode !== 'manual'
          ? `${results.length} AI suggestions · Search above queries catalogs directly`
          : `Direct catalog search · no AI${recommendationSet ? ` · ${results.length} results` : ''}`}
      </div>
      {sourceOutcomes.some((outcome) => outcome.status !== 'success') && (
        <CatalogAvailabilityNotice outcomes={sourceOutcomes} />
      )}
      {running && !task?.loadingMore ? (
        <div className="citations-list" aria-label="Finding free images">
          <div className="wikimedia-skeleton" /><div className="wikimedia-skeleton" /><div className="wikimedia-skeleton" />
        </div>
      ) : (
        <div className="citations-list">
          {results.map((result, index) => (
            <article className="wikimedia-result" key={`${freeImageSource(result)}:${freeImageSourceId(result)}`}>
              <button
                type="button"
                className={'wikimedia-result-preview' + (hasExtremeAspectRatio(result) ? ' is-extreme' : '')}
                onClick={() => useWikimediaGalleryStore.getState().openGallery(nodeId, versionCreatedAt, index)}
                data-tip="Enlarge image"
              >
                <ResilientFreeImage result={result} alt={result.caption} />
                <Maximize2 size={42} aria-hidden="true" />
              </button>
              {result.relevance && <div className="wikimedia-result-relevance">{result.relevance}</div>}
              <div className="wikimedia-result-caption" title={result.caption}>{result.caption}</div>
              <div className="wikimedia-result-credit">{displayFreeImageCredit(result)} · {result.license}</div>
              <div className="wikimedia-image-actions">
                <a
                  href={freeImageLandingPage(result)}
                  target="_blank"
                  rel="noreferrer"
                  data-tip={`Open on ${freeImageSourceLabel(result)}`}
                >
                  <ExternalLink size={14} /> {freeImageSourceLabel(result)}
                </a>
                <button type="button" disabled={spawningTitle != null} onClick={() => { void spawn(result); }}>
                  <ImagePlus size={14} /> {spawningTitle === `${freeImageSource(result)}:${freeImageSourceId(result)}` ? 'Adding…' : 'Spawn media node'}
                </button>
              </div>
            </article>
          ))}
          {recommendationSet?.mode === 'manual' && Object.keys(recommendationSet.next ?? {}).length > 0 && (
            <button type="button" className="btn wikimedia-load-more" disabled={running}
              onClick={() => rerun(recommendationSet.manualQuery!, true)}>{running ? 'Loading…' : 'Load more images'}</button>
          )}
          {results.length === 0 && (
            <div className="wikimedia-empty">
              {sourceOutcomes.length > 0 && sourceOutcomes.every((outcome) => outcome.status !== 'success')
                ? 'No image catalog completed this search.'
                : !recommendationSet ? 'Enter a subject, title, or name to search the image catalogs.'
                  : recommendationSet.mode === 'manual' ? 'No images found for this query.' : 'No directly relevant free images found.'}
            </div>
          )}
        </div>
      )}
      {(task?.error || spawnError) && <div className="wikimedia-panel-error" role="alert">{spawnError ?? task?.error}</div>}
    </div>
  );
}

function CatalogAvailabilityNotice({ outcomes }: { outcomes: FreeImageSourceOutcome[] }) {
  return (
    <div className="wikimedia-availability" role="status">
      {outcomes.filter((outcome) => outcome.status !== 'success').map((outcome) => {
        const source = outcome.source === 'openverse' ? 'Openverse' : 'Wikimedia';
        const status = outcome.status === 'rate-limited' ? 'rate-limited' : 'temporarily unavailable';
        const retry = outcome.retryAt && outcome.retryAt > Date.now()
          ? ` · try again after ${new Date(outcome.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : '';
        return <div key={outcome.source}>{source} {status}{retry}</div>;
      })}
    </div>
  );
}

export interface InlineReviewProps {
  nodeId?: string; versionCreatedAt?: number; inline?: boolean;
  activeUnitId?: string | null; onClose?: () => void; onUnit?: (id: string) => void;
  factUnitPrefix?: string;
}

function visibleReport(
  complete: FactCheckReport | undefined,
  pending: FactCheckReport | undefined,
): FactCheckReport | undefined {
  return pending ?? complete;
}

const FACT_LABEL: Record<string, string> = {
  supported: 'Supported',
  mixed: 'Mixed evidence',
  contradicted: 'Contradicted',
  unverified: 'Unverified',
};

export function NodeFactCheckPanel(props: InlineReviewProps = {}) {
  const storedNodeId = useCitationPanelStore((s) => s.nodeId);
  const storedVersionAt = useCitationPanelStore((s) => s.factVersionCreatedAt);
  const storedUnitId = useCitationPanelStore((s) => s.activeFactUnitId);
  const storedClose = useCitationPanelStore((s) => s.close);
  const storedSetUnit = useCitationPanelStore((s) => s.setFactUnit);
  const panelNodeId = props.nodeId ?? storedNodeId;
  const versionCreatedAt = props.versionCreatedAt ?? storedVersionAt;
  const activeUnitId = props.inline ? props.activeUnitId : storedUnitId;
  const close = props.onClose ?? storedClose;
  const setFactUnit = props.onUnit ? (_nodeId: string, unitId: string) => props.onUnit!(unitId) : storedSetUnit;
  const selection = useGraphStore((s) => s.project?.selection);
  // Keep each store snapshot referentially stable. Returning a freshly-created
  // `{ node, report, groupColor }` object from a Zustand selector makes React's
  // external-store bridge see a "new" snapshot on every read, which can cause
  // a maximum-update-depth loop as soon as Evidence review mounts.
  const panelNode = useGraphStore((s) =>
    panelNodeId ? s.project?.nodes[panelNodeId] : undefined);
  const panelVersion = props.inline || panelNode?.chat ? panelNode?.versions.find((version) => version.createdAt === versionCreatedAt)
    : panelNode?.versions[panelNode.currentVersionIndex];
  const report = panelVersion?.createdAt === versionCreatedAt
    ? visibleReport(panelVersion.factCheck?.complete, panelVersion.factCheck?.pending)
    : undefined;
  const outdatedLayout = useMemo(() => !!report && !!panelVersion
    && report.bodyFingerprint !== factCheckBodyFingerprint(panelVersion), [report, panelVersion]);
  const groupColor = useGraphStore((s) => {
    if (!panelNodeId || !s.project) return null;
    const node = s.project.nodes[panelNodeId];
    return (node?.groupId ? s.project.groups[node.groupId]?.color : undefined)
      ?? s.project.color
      ?? null;
  });
  const units = props.factUnitPrefix ? (report?.units ?? []).filter((unit) => unit.id.startsWith(props.factUnitPrefix!)) : report?.units ?? [];
  const activeIndex = Math.max(0, units.findIndex((unit) => unit.id === activeUnitId));
  const active = units[activeIndex];
  const progress = report
    ? units.filter((unit) => unit.state !== 'pending').length
    : 0;
  const panelRef = useRef<HTMLDivElement>(null);

  const panelStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!groupColor) return undefined;
    const gc = colorToCss(groupColor);
    return {
      '--tint-1': `color-mix(in oklab, ${gc} 5%, transparent)`,
      '--tint-2': `color-mix(in oklab, ${gc} 10%, transparent)`,
      '--tint-3': `color-mix(in oklab, ${gc} 22%, transparent)`,
      '--tint-4': `color-mix(in oklab, ${gc} 30%, transparent)`,
      '--control-accent': gc,
      '--node-accent': gc,
    } as React.CSSProperties;
  }, [groupColor]);

  useLayoutEffect(() => {
    if (!panelNodeId || props.inline) return;
    let raf = 0;
    const loop = () => {
      const el = panelRef.current;
      const nid = useCitationPanelStore.getState().nodeId;
      if (el && nid) {
        const project = useGraphStore.getState().project;
        const node = project?.nodes[nid];
        const nodeEl = document.querySelector<HTMLElement>(`[data-node-id="${nid}"]`);
        if (node && nodeEl) {
          const zoom = useLiveViewportStore.getState().zoom || 1;
          const rect = nodeEl.getBoundingClientRect();
          const live = useLivePositionsStore.getState().positions[nid];
          const x = live?.x ?? node.position.x;
          const y = live?.y ?? node.position.y;
          el.style.maxHeight = `${Math.max(280, rect.height / zoom)}px`;
          el.style.transform = `translate3d(${x + rect.width / zoom + PANEL_GAP}px, ${y}px, 0)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [panelNodeId, props.inline]);

  useEffect(() => {
    if (!props.inline && panelNodeId && !(selection?.length === 1 && selection[0] === panelNodeId)) storedClose('navigation');
  }, [panelNodeId, selection, storedClose, props.inline]);

  useEffect(() => {
    if (!props.inline && (!panelNode || !panelVersion || (!panelNode.chat && (panelVersion.createdAt !== versionCreatedAt || !report || units.length === 0)))) {
      close();
    }
  }, [panelNode, panelVersion?.createdAt, versionCreatedAt, report, units.length, close, props.inline]);

  useEffect(() => {
    if (activeUnitId || !active || !panelNodeId) return;
    setFactUnit(panelNodeId, active.id);
  }, [active, activeUnitId, panelNodeId, setFactUnit]);

  const navigate = (nextIndex: number) => {
    if (!panelNodeId) return;
    const unit = units[nextIndex];
    if (!unit) return;
    setFactUnit(panelNodeId, unit.id);
    if (outdatedLayout) return;
    if (unit.bulletIndex != null) {
      if (panelNode?.bulletsCollapsed) {
        useGraphStore.getState().updateNode(panelNodeId, { bulletsCollapsed: false });
      }
      useActiveIdxStore.getState().set(panelNodeId, unit.bulletIndex);
    } else {
      useActiveIdxStore.getState().set(panelNodeId, null);
    }
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        `${props.inline ? '[data-chat-table-viewer]' : `[data-node-id="${panelNodeId}"]`} [data-fact-unit="${unit.id}"]`,
      )?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  if (!panelNodeId || !panelNode || (!panelNode.chat && (!report || !active))) return null;
  const finding = active?.finding;
  const stateLabel = active?.state === 'pending'
    ? (active.order === 0 || progress > active.order ? 'Checking…' : 'Waiting…')
    : active?.state === 'failed'
      ? 'Check failed'
      : FACT_LABEL[finding?.verdict ?? 'unverified'];

  return (
    <div
      ref={panelRef}
      className="side-panel citations-panel fact-review-panel"
      data-canvas-right-panel={props.inline ? undefined : true}
      style={panelStyle}
      aria-label="Evidence review"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="citations-panel-head">
        <span className="fact-review-heading">
          <span>Evidence review</span>
          {!outdatedLayout && <small>(click passages)</small>}
        </span>
        <button
          className="citations-close-btn"
          data-tip="Hide evidence review"
          aria-label="Hide evidence review"
          onClick={() => close()}
        >
          <X size={13} />
        </button>
      </div>
      <div className="fact-review-scroll">
        {panelVersion?.chat && <div className="chat-review-title">{panelVersion.chat.title}</div>}
        {outdatedLayout && <p className="fact-review-explanation" role="status">This saved check no longer matches the current text layout. Run a new check to highlight passages.</p>}
        {!active && <p className="chat-review-empty">Not fact-checked</p>}
        {active && <>
        <div className="fact-review-progress">{progress} / {units.length} checked</div>
        <blockquote>“{active.text}”</blockquote>
        <div
          className={`fact-review-verdict fact-${finding?.verdict ?? 'pending'}`}
          aria-label={`Evidence status: ${stateLabel}`}
        >
          {stateLabel}
        </div>
        {finding?.explanation && <p className="fact-review-explanation">{finding.explanation}</p>}
        <GoogleSearchSuggestions snippets={finding?.googleSearchSuggestions} />
        {active.error && <p className="fact-review-error">{active.error}</p>}
        {finding?.evidence.map((evidence, index) => (
          <a
            className="fact-evidence-card"
            data-link-control
            key={`${evidence.url}:${index}`}
            href={evidence.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className={`fact-evidence-stance stance-${evidence.stance}`}>
              {evidence.stance === 'supports'
                ? 'Supports'
                : evidence.stance === 'contradicts'
                  ? 'Contradicts'
                  : 'Context'}
            </span>
            <strong className="app-link-label">{evidence.title ?? evidence.domain ?? 'Source'}</strong>
            {evidence.domain && <small>{evidence.domain}</small>}
            {evidence.excerpt && <q>{evidence.excerpt}</q>}
            {evidence.excerptOrigin && (
              <small>
                {evidence.excerptOrigin === 'source'
                  ? 'Source excerpt'
                  : 'AI-extracted excerpt — verify in source'}
              </small>
            )}
          </a>
        ))}
        </>}
      </div>
      <div className="fact-review-footer">
        <button
          type="button"
          onClick={() => navigate(activeIndex - 1)}
          disabled={!active || activeIndex === 0}
          data-tip="Previous passage"
          aria-label="Previous passage"
        >
          <ChevronLeft size={16} />
        </button>
        <span>{active ? activeIndex + 1 : 0} / {units.length}</span>
        <button
          type="button"
          onClick={() => navigate(activeIndex + 1)}
          disabled={!active || activeIndex >= units.length - 1}
          data-tip="Next passage"
          aria-label="Next passage"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
