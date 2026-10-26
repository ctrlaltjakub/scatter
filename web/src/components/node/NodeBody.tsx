'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdaptiveBullets } from '@/components/node/AdaptiveBullets';
import { NodeScrollbar } from '@/components/node/NodeScrollbar';
import { MediaChooser } from '@/components/node/MediaChooser';
import { MediaView } from '@/components/node/MediaView';
import { useGraphStore } from '@/store/useGraphStore';
import { useMediaReloadStore } from '@/store/useMediaReloadStore';
import { useScrollableHoverStore } from '@/store/useScrollableHoverStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import {
  useDisplayBody,
  useHasAnyActive,
  useIsWholeActive,
  useRewriteStore,
} from '@/store/useRewriteStore';
import { parseBody } from '@/lib/bulletParse';
import { currentContentType } from '@/lib/nodeContentType';
import { exitReading } from '@/lib/readingController';
import { useReadingStore } from '@/store/useReadingStore';
import {
  NODE_SMOOTH_THRESHOLD,
  SectionWheelController,
} from './sectionWheelController';
import type { MediaChooserMode } from './MediaModeToggle';
import { GenerationMediaSkeleton } from '@/components/GenerationMediaSkeleton';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { NodeGenerationError } from './NodeGenerationError';
import { isEmptyTextNode } from '@/lib/emptyNodes';
import { mediaInstructionsForDisplay } from '@/lib/mediaInstructions';

/** Multi-line pulsing placeholder shown while a whole node is generating and
 *  no text has streamed in yet. Once the first content arrives the real
 *  AdaptiveBullets (with its live streaming reveal) takes over. */
export function NodeBodySkeleton() {
  const pulseStyle = useGenerationPulseSync(true);
  return (
    <div className="sc-node-skeleton" aria-hidden="true" style={pulseStyle}>
      <div className="sc-skel-bar sc-skel-title" />
      <div className="sc-skel-bar sc-skel-w95" />
      <div className="sc-skel-bar sc-skel-w88" />
      <div className="sc-skel-bar sc-skel-w72" />
      <div className="sc-skel-bar sc-skel-w90" />
      <div className="sc-skel-bar sc-skel-w60" />
    </div>
  );
}

interface Props {
  body: string;
  parentNodeId: string;
  /** True when this node is the single selection. Drives the
   *  scrollbar visibility and the wheel-event preventDefault gate —
   *  scrolling on an unfocused node should pass through to the page
   *  scroll, not hijack to advance the cascade. */
  selected: boolean;
  error?: string;
  onRetry?: () => void;
  retryDisabled?: boolean;
  onReferenceClick: (term: string, opts: { withModifier: boolean }) => void;
  /** Optional inline style overrides for the .node-body div (e.g. height when user resizes). */
  bodyStyle?: React.CSSProperties;
  readingFamily?: string;
  /** Reports the measured freetext height (CSS pixels) up to NodeView so it
   *  can compute the collapsed body height for the chevron toggle. */
  onFreeTextH?: (h: number) => void;
  /** Temporarily render expanded bullet internals while the outer body stays collapsed. */
  premeasureExpanded?: boolean;
  /** Show cached expanded content before remounting hidden measurement labs. */
  deferExpandedMeasurements?: boolean;
  /** Runtime-only view selected by the empty media node's header switch. */
  mediaChooserMode?: MediaChooserMode;
}

export function NodeBody({
  body,
  parentNodeId,
  selected,
  error,
  onRetry,
  retryDisabled = false,
  onReferenceClick,
  bodyStyle,
  readingFamily,
  onFreeTextH,
  premeasureExpanded = false,
  deferExpandedMeasurements = false,
  mediaChooserMode = 'attach',
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const emptyType = useGraphStore(s => {
    const node = s.project?.nodes[parentNodeId];
    return node && isEmptyTextNode(node) ? currentContentType(node) : null;
  });
  const refClickRef = useRef(onReferenceClick);
  refClickRef.current = onReferenceClick;
  const stableOnReferenceClick = useCallback(
    (term: string, opts: { withModifier: boolean }) => refClickRef.current(term, opts),
    [],
  );
  // Size fields live on the current version (per-version sizing).
  const minBodyHeight = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return n ? n.versions[n.currentVersionIndex]?.minBodyHeight : undefined;
  });
  const bulletsCollapsed = useGraphStore(
    (s) => !!s.project?.nodes[parentNodeId]?.bulletsCollapsed,
  );
  const [parkCollapsedList, setParkCollapsedList] = useState(false);
  const previousBulletsCollapsedRef = useRef(bulletsCollapsed);
  useEffect(() => {
    const wasCollapsed = previousBulletsCollapsedRef.current;
    if (!bulletsCollapsed || (!wasCollapsed && bulletsCollapsed)) {
      setParkCollapsedList(true);
    }
    previousBulletsCollapsedRef.current = bulletsCollapsed;
  }, [bulletsCollapsed]);
  // Media nodes branch the body content: the chooser (explainer + controls)
  // while empty, or the media itself once attached. Everything else (text
  // nodes) is unchanged.
  const isMediaNode = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return n ? currentContentType(n) === 'media' : false;
  });
  const isSoleSelectedNode = useGraphStore((s) => (
    s.project?.selection.length === 1 && s.project.selection[0] === parentNodeId
  ));
  const hasMedia = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return !!(n && n.versions[n.currentVersionIndex]?.media);
  });
  const hasImageGeneration = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return !!n?.versions[n.currentVersionIndex]?.imageGeneration;
  });
  // Remount key for attached non-generated media: changes on version switch
  // and on a reload bump, forcing MediaView to re-load fresh.
  const currentVersionIndex = useGraphStore((s) => s.project?.nodes[parentNodeId]?.currentVersionIndex ?? 0);
  const sourceLimitation = useGraphStore(
    (s) => s.project?.nodes[parentNodeId]?.versions[currentVersionIndex]?.sourceLimitation,
  );
  const reloadNonce = useMediaReloadStore((s) => s.byNodeId[parentNodeId] ?? 0);
  // Display body: prefer the in-flight working body (markers stripped)
  // when a rewrite burst is running on this node, otherwise fall back
  // to the persisted version body. The working-body subscription means
  // every chunk that the rewrite writes triggers exactly one re-render
  // of this node, just like the previous version-body-write path did.
  const displayBody = useDisplayBody(parentNodeId, currentVersionIndex, body);
  // Show a full-body pulsing skeleton while the node is generating as a WHOLE
  // (a fresh spawn, or a regenerate / modify / elaborate) AND nothing has
  // streamed in yet. Mirrors NodeView's `headerGenerating` so per-section
  // (partial) expands — which keep most of the body on screen — are excluded;
  // those get the inline one-line skeleton inside AdaptiveBullets instead. The
  // skeleton hands off to the live streaming reveal the moment text arrives.
  const generating = useGraphStore((s) => {
    const n = s.project?.nodes[parentNodeId];
    return !!n?.generating;
  });
  const generatingVersionIndex = useGraphStore(
    (s) => s.project?.nodes[parentNodeId]?.generatingVersionIndex,
  );
  const viewingGeneratingVersion = generating
    && (generatingVersionIndex == null || generatingVersionIndex === currentVersionIndex);
  const wholeActive = useIsWholeActive(parentNodeId);
  const wholeRewriteBodyFloor = useRewriteStore(
    (s) => s.snapshot[parentNodeId]?.preBurstBodyHeightFloor ?? null,
  );
  const anyActive = useHasAnyActive(parentNodeId);
  const showFullSkeleton = viewingGeneratingVersion
    && (wholeActive || (generating && !anyActive))
    && displayBody.trim() === '';
  // activeIdx for the scrollbar + wheel handler. AdaptiveBullets
  // owns the writer (click on a bullet sets it); the scrollbar's
  // tick + the wheel handler here are the other writers/readers.
  const activeIdx = useActiveIdxStore(
    (s) => s.byNodeId[parentNodeId] ?? null,
  );
  const setActiveIdx = useCallback((next: number | null) => {
    useActiveIdxStore.getState().set(parentNodeId, next);
  }, [parentNodeId]);

  // Parse the body to derive scrollbar inputs:
  //   - bullet count → number of scrollbar stops (stop 0 = freetext,
  //     stops 1..N = each L1 bullet)
  //   - anchorSelectors → CSS selectors the scrollbar uses to read
  //     each stop's y position from the rendered DOM
  // parseBody is cheap (regex over body lines) and memoized on body.
  const bulletCount = useMemo(() => {
    const parsed = parseBody(displayBody);
    return parsed?.bullets.length ?? 0;
  }, [displayBody]);
  const anchorSelectors = useMemo(() => {
    const sels = ['[data-sc-anchor="ft"]'];
    for (let i = 0; i < bulletCount; i++) {
      sels.push(`[data-sc-anchor="b-${i}"]`);
    }
    return sels;
  }, [bulletCount]);

  // Stop index: 0 = freetext, 1..N = bullet (i-1). activeIdx is
  // null when freetext is the implicit focus (cascade's default
  // uniform-first seed); 0..N-1 when an L1 bullet is forced active.
  const activeStop = activeIdx === null ? 0 : activeIdx + 1;
  // A bullet click may focus this node and change its active section together.
  // Retain the last visible stop so a newly mounted scrollbar can animate from
  // that section instead of appearing directly at the clicked section.
  const lastVisibleStopRef = useRef(activeStop);
  useEffect(() => {
    if (selected) lastVisibleStopRef.current = activeStop;
  }, [selected, activeStop]);
  const setStop = useCallback((stop: number) => {
    const bounded = Math.max(0, Math.min(bulletCount, stop));
    const currentIdx = useActiveIdxStore.getState().byNodeId[parentNodeId] ?? null;
    const currentStop = currentIdx === null ? 0 : currentIdx + 1;
    if (bounded === currentStop) return;
    if (useReadingStore.getState().nodeId === parentNodeId) exitReading();
    if (bounded <= 0) setActiveIdx(null);
    else setActiveIdx(bounded - 1);
  }, [setActiveIdx, bulletCount, parentNodeId]);

  // Raw wheel input is normalized by a small controller: traditional chunky
  // wheel steps keep their 200-unit threshold. Smooth trackpad input keeps its
  // immediate first/direction-change step and then uses a 200-unit threshold
  // on every platform, with the guarded slow-movement time fallback.
  const wheelControllerRef = useRef<SectionWheelController | null>(null);
  if (wheelControllerRef.current === null) {
    wheelControllerRef.current = new SectionWheelController({
      smoothThreshold: NODE_SMOOTH_THRESHOLD,
    });
  }
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const activeStopRef = useRef(activeStop);
  activeStopRef.current = activeStop;
  const bulletCountRef = useRef(bulletCount);
  bulletCountRef.current = bulletCount;
  const bulletsCollapsedRef = useRef(bulletsCollapsed);
  bulletsCollapsedRef.current = bulletsCollapsed;

  // "Force scroll" hint: this node is a stepping target (selected, has bullets,
  // not collapsed, not media) AND the pointer is over its body. Publish that to
  // the global hover store so the sidebar can surface the Ctrl/⌘+scroll hint.
  const isStepper = !isMediaNode && selected && !bulletsCollapsed && bulletCount > 0;
  const overRef = useRef(false);
  useEffect(() => {
    const store = useScrollableHoverStore.getState();
    if (isStepper && overRef.current) store.setHover(parentNodeId);
    else if (store.nodeId === parentNodeId) store.setHover(null);
  }, [isStepper, parentNodeId]);
  useEffect(() => () => {
    // Drop our hover claim on unmount.
    const store = useScrollableHoverStore.getState();
    if (store.nodeId === parentNodeId) store.setHover(null);
  }, [parentNodeId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Ctrl/⌘+wheel = "force scroll": let it bubble to the canvas zoom
      // (a native listener there owns it) instead of stepping sections.
      if (e.ctrlKey || e.metaKey) return;
      if (!selectedRef.current) return;
      if (bulletsCollapsedRef.current) return; // no sections to step through
      if (bulletCountRef.current === 0) return;
      // Predominantly vertical scroll only — horizontal wheel
      // passes through to the canvas pan.
      if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
      e.preventDefault();

      const lastStop = bulletCountRef.current; // stop indices 0..N
      const cur = activeStopRef.current;
      const direction = wheelControllerRef.current!.consume({
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        timeStamp: e.timeStamp,
      }, cur, lastStop);
      if (direction !== 0) {
        const next = Math.max(0, Math.min(lastStop, cur + direction));
        if (next !== cur) {
          // Keep the event listener's position current even when several wheel
          // samples arrive before React has painted the store update.
          activeStopRef.current = next;
          setStop(next);
        }
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [setStop]);

  // Defocus → clear in-progress scroll state so it doesn't carry across focus
  // changes. Collapse/content changes get the same reset: their section model
  // is no longer the one the gesture started against.
  useEffect(() => {
    if (!selected) wheelControllerRef.current?.reset();
  }, [selected]);
  useEffect(() => {
    wheelControllerRef.current?.reset();
  }, [bulletsCollapsed, displayBody, currentVersionIndex, isMediaNode]);
  useEffect(() => () => wheelControllerRef.current?.reset(), []);

  return (
    <>
    {/* Errors belong to the card, not the clipped/scrolling body viewport. */}
    <NodeGenerationError error={error} onRetry={onRetry} retryDisabled={retryDisabled} />
    <div
      ref={bodyRef}
      className="node-body"
      style={bodyStyle}
      data-sc-mode="adaptive"
      data-sc-min-body={minBodyHeight ?? ''}
      onMouseEnter={() => { overRef.current = true; if (isStepper) useScrollableHoverStore.getState().setHover(parentNodeId); }}
      onMouseLeave={() => { overRef.current = false; if (useScrollableHoverStore.getState().nodeId === parentNodeId) useScrollableHoverStore.getState().setHover(null); }}
    >
      {sourceLimitation?.kind === 'not-enough-information' ? (
        <div className="source-only-empty" role="status">
          <strong>Sources only</strong>
          <span>{sourceLimitation.message.replace(/^Sources only:\s*/i, '')}</span>
          {sourceLimitation.reason && <small>{sourceLimitation.reason}</small>}
        </div>
      ) : isMediaNode ? (
        viewingGeneratingVersion && hasImageGeneration && !hasMedia ? (
          <GenerationMediaSkeleton kind="image" />
        ) : hasMedia ? (
          <MediaView key={`${currentVersionIndex}-${reloadNonce}`} nodeId={parentNodeId} />
        ) : (
          <>
            <AdaptiveBullets
              body={mediaInstructionsForDisplay(displayBody)}
              readingFamily={readingFamily}
              parentNodeId={parentNodeId}
              onReferenceClick={stableOnReferenceClick}
              onFreeTextH={onFreeTextH}
              collapsed={false}
            />
            <MediaChooser nodeId={parentNodeId} mode={mediaChooserMode} />
          </>
        )
      ) : emptyType ? (
        <div className="node-empty-copy">
          <strong>Nothing here yet</strong>
          <p>{emptyType === 'explain' ? 'Write what you’d like explained in the field below.' : 'Write what you’d like to explore in the field below.'}</p>
        </div>
      ) : showFullSkeleton ? (
        <NodeBodySkeleton />
      ) : (
        <AdaptiveBullets
          body={displayBody}
          readingFamily={readingFamily}
          parentNodeId={parentNodeId}
          onReferenceClick={stableOnReferenceClick}
          onFreeTextH={onFreeTextH}
          collapsed={bulletsCollapsed && !premeasureExpanded}
          parkCollapsedList={parkCollapsedList && !premeasureExpanded}
          deferHiddenLabs={deferExpandedMeasurements && !premeasureExpanded}
        />
      )}
      {/* Scrollbar — visible whenever this node is selected, the bullets
          section is shown, and there's at least one bullet. Stays visible even
          when every bullet fits (it marks the active section). Sits inside the
          body so its tick positions naturally use the body's coordinate system. */}
      {!isMediaNode && selected && !bulletsCollapsed && bulletCount > 0 && (
        <NodeScrollbar
          activeStop={activeStop}
          initialStop={lastVisibleStopRef.current}
          onChangeStop={setStop}
          bodyRef={bodyRef}
          anchorSelectors={anchorSelectors}
        />
      )}
    </div>
    </>
  );
}
