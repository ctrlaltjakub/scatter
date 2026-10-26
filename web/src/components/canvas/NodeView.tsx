'use client';
import { languageInfo, languageDirection, languageLabel } from '@/lib/languages';
import { useReadingTypography } from '@/hooks/useReadingTypography';
import {
  Fragment, memo, useCallback, useEffect, useRef, useState,
} from 'react';
import {
  Pin, PinOff, ChevronUp, ChevronDown, Maximize2, Maximize,
} from 'lucide-react';
import type { HeaderParts, ScatterNode } from '@/store/types';
import { NodeHeader } from '@/components/node/NodeHeader';
import { IMAGE_TITLE_PLACEHOLDER, isImageTitlePending } from '@/lib/imageQuestionTitle';
import { NodeBody } from '@/components/node/NodeBody';
import { NodeFollowUpBar } from '@/components/node/NodeFollowUpBar';
import { isEmptyTextNode } from '@/lib/emptyNodes';
import { ImageNodeFollowUpBar } from '@/components/node/ImageFollowUpBar';
import { ImageAtlasOverlay } from '@/components/node/ImageAtlasOverlay';
import { isStillImageMedia } from '@/lib/imageEditActions';
import { useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useDragArmStore } from '@/store/useDragArmStore';
import { useDragHintStore } from '@/store/useDragHintStore';
import { createShakeDetector, type ShakeDetector } from '@/lib/shakeDetect';
import { colorToCss, mutedAccentHex } from '@/lib/groupColor';
import { useRewriteStore, useHasAnyActive, useIsWholeActive } from '@/store/useRewriteStore';
import {
  nodeWidth, nodeBodyMaxH, nodeRenderedH,
  MIN_NODE_W, MIN_BODY_MAX_H, DEFAULT_NODE_W,
} from '@/lib/nodeSize';
import {
  clampResizeAgainstChain, maxMediaWidthAgainstChain, wallLeft, wallRight,
  type RectInfo,
} from '@/physics/rectChain';
import { aspectResize, mediaHeightPerWidth } from '@/lib/mediaSizing';
import { interactiveDisplaySize } from '@/lib/interactiveDocument';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { useSettingsStore } from '@/store/useSettingsStore';
import { currentContentType, nodeTypeLabel, isStandaloneInteractive } from '@/lib/nodeContentType';
import { InteractiveNodeBody } from '@/components/node/InteractiveNodeBody';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { MediaModeToggle, type MediaChooserMode } from '@/components/node/MediaModeToggle';
import { canInlineEditNodeHeader, flattenHeaderParts, resolveNodeHeaderParts } from '@/lib/nodeHeaderText';
import { saveNodeHeader } from '@/lib/nodeHeaderActions';
import { isImageGenerationErrorVersion } from '@/lib/imageGeneration';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import {
  overviewFontSizeForZoom,
  overviewSkeletonMetricsForZoom,
  overviewTitleLayoutForZoom,
} from '@/components/canvas/NodeOverviewController';
import { tokenizeOverviewText } from '@/lib/overviewHeader';
import { ChatBody, ChatJumpToLatest } from '@/components/chat/ChatBody';
import { AnswerBody } from '@/components/chat/AnswerBody';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { ChatComposer } from '@/components/chat/ChatComposer';
import { ChatInlineTitle } from '@/components/chat/ChatInlineTitle';
import { ChatContextUsage } from '@/components/chat/ChatContextUsage';

interface Props {
  node: ScatterNode;
  selected: boolean;
  multiSelected?: boolean;
  onSelect: () => void;
  onReferenceClick: (term: string, opts: { withModifier: boolean }) => void;
  onRetry?: () => void;
  retryDisabled?: boolean;
  imageGenerationAvailable?: boolean;
  /** `kind` lets Canvas distinguish a header-drag (where edge-of-canvas
   *  follow-pan should apply) from a resize (where it shouldn't). */
  onDragStart: (canvasX: number, canvasY: number, kind: 'drag' | 'resize') => void;
  onDragMove: (
    canvasX: number,
    canvasY: number,
    gesture: { unpinnedByShake: boolean },
  ) => void;
  onDragEnd: (result?: { unpinnedByShake: boolean }) => void;
}

const DRAG_THRESHOLD_PX = 3;

const liveZoom = () => useLiveViewportStore.getState().zoom || 1;

function OverviewWords({ text }: { text: string }) {
  return tokenizeOverviewText(text).map((piece, index) => {
    if (piece.kind === 'space') return piece.text;
    return (
      <Fragment key={`${index}:${piece.text}`}>
        <span className="node-overview-word">{piece.text}</span>
        {piece.breakAfter && <wbr />}
      </Fragment>
    );
  });
}

function OverviewHeaderText({ parts }: { parts: HeaderParts }) {
  return (
    <>
      {parts.prefix && (
        <span className="node-title-addon node-title-prefix">
          {parts.prefix}:
        </span>
      )}
      {parts.prefix && parts.subject && ' '}
      {parts.subject && (
        <span className="node-title-subject">
          <OverviewWords text={parts.subject} />
        </span>
      )}
      {parts.question && (
        <>
          <span aria-hidden="true">: </span>
          <span className="node-title-question">
            <OverviewWords text={parts.question} />
          </span>
        </>
      )}
      {parts.suffix && (
        <>
          <span aria-hidden="true"> </span>
          <span className="node-title-addon node-title-suffix">
            - {parts.suffix}
          </span>
        </>
      )}
    </>
  );
}

// After a drag ends, keep the card painting on top for this long — the
// physics push-apart is still settling, and dropping the z-index at pointer-up
// would pop the card underneath a neighbor it still overlaps.
const DRAG_TOP_LINGER_MS = 400;

type ResizeMode = 'tl' | 'tr' | 'bl' | 'br';
interface ResizeState {
  mode: ResizeMode;
  startX: number;          // pointer-down clientX
  startY: number;          // pointer-down clientY
  startW: number;          // node width at down-time
  startBodyH: number;      // bodyMaxHeight at down-time (what we update)
  startRenderedH: number;  // rendered card height at down-time (collision math)
  startNodeX: number;      // node position.x at down-time
  startNodeY: number;      // node position.y at down-time
  pointerId: number;
  collapsedAtStart: boolean;
}

function NodeViewImpl(p: Props) {
  const nodeProjectId = useGraphStore((s) => s.project?.id ?? null);
  const v = p.node.versions[p.node.currentVersionIndex];
  const readingTypography = useReadingTypography(v?.language, `${v?.header ?? ''}\n${v?.body ?? ''}`);
  const { fontFamily: readingFamily, fontSizeAdjust: _readingSize, ...readingVariables } = readingTypography;
  const licensedMedia = v?.media?.freeImage ?? (v?.media?.wikimedia ? {
    landingPageUrl: v.media.wikimedia.filePageUrl,
    creditLine: v.media.wikimedia.creditLine,
    license: v.media.wikimedia.license,
    licenseUrl: v.media.wikimedia.licenseUrl,
    modified: v.media.wikimedia.modified,
  } : undefined);
  // The LIVE content type = the current version's type (not node.type, which is
  // just spawn-origin lineage). Drives the footer tag + the media/explain branches
  // so switching to an older, differently-typed version renders correctly.
  const ct = currentContentType(p.node);
  const standaloneInteractive = isStandaloneInteractive(p.node);
  const titleEditNonce = useChatRuntimeStore((state) => state.views[p.node.id]?.titleEditNonce ?? 0);
  const projectArrows = useGraphStore((s) => s.project?.arrows);
  const pendingImageTitle = isImageTitlePending(p.node);
  const headerParts = pendingImageTitle ? { subject: IMAGE_TITLE_PLACEHOLDER } : p.node.chat ? { subject: p.node.chat.title } : projectArrows
    ? resolveNodeHeaderParts(p.node, projectArrows)
    : { subject: v?.header ?? '' };
  const isRoot = p.node.type === 'root';
  const [mediaChooserMode, setMediaChooserMode] = useState<MediaChooserMode>('attach');
  // PERF R2: subscribe to THIS node's live position. The subscriber
  // returns Object.is-equal values when other nodes move, so React's
  // useSyncExternalStore bails out — only the node whose live
  // position actually changed re-renders. Fall back to project
  // position before the worker has emitted its first tick (or for
  // headless/sandbox harnesses that don't run physics).
  const livePos = useLivePositionsStore((s) => s.positions[p.node.id]);
  const posX = livePos?.x ?? p.node.position.x;
  const posY = livePos?.y ?? p.node.position.y;
  // Hoisted above the `if (!v) return null` below: must be called on
  // every render, including the (rare) ones where the current version
  // index points past the end of the versions array.
  const highlighted = useGraphStore((s) => s.highlight?.childNodeId === p.node.id);
  const attachedMedia = ct === 'media' && !!v?.media;
  const overviewEligible = !attachedMedia;
  const overviewInitialZoom = useLiveViewportStore.getState().zoom;
  const overviewInitiallyActive = overviewEligible
    && overviewInitialZoom < GROUP_LABEL_ZOOM_THRESHOLD;
  const initialOverviewSkeletonMetrics = overviewSkeletonMetricsForZoom(overviewInitialZoom);
  const initialOverviewTitleLayout = overviewTitleLayoutForZoom(overviewInitialZoom, nodeRenderedH(p.node));
  // Drag-away auto-pin "armed" indicator — true while THIS node is being dragged
  // past the threshold (a release now would pin it). Drives the one-time icon
  // swap; continuous animation strength stays outside React below.
  const arming = useDragArmStore((s) => s.armedNodeId === p.node.id);
  // B.4 — group color stripe. Reads the node's groupId from project
  // state (not from the prop) so an "assign to group" mutation flips
  // the stripe instantly. Ungrouped/root nodes (or a deleted group)
  // fall back to the PROJECT base color — full grouped-style tinting —
  // and null only on legacy color-less data (old neutral greys).
  const groupColor = useGraphStore((s) => {
    if (!s.project) return null;
    const gid = s.project.nodes[p.node.id]?.groupId;
    if (!gid) return s.project.color ?? null;
    return s.project.groups[gid]?.color ?? s.project.color ?? null;
  });
  // Hue/saturation/darkening knobs for the resize-handle accent off the group color.
  const accentHueShift = useSettingsStore((s) => s.accentHueShift);
  const accentDesaturate = useSettingsStore((s) => s.accentDesaturate);
  const accentDarken = useSettingsStore((s) => s.accentDarken);
  const resolvedTheme = useResolvedTheme();
  const dragRef = useRef<{ originX: number; originY: number; nodeX: number; nodeY: number; pointerId: number; moved: boolean; unpinnedByShake?: boolean } | null>(null);
  // Shake-to-unpin detector (lazily created, reset at each drag start).
  const shakeRef = useRef<ShakeDetector | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pinButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastReportedHeight = useRef<number>(p.node.renderedHeight ?? 0);
  const [verifiedPlaceholderHeight, setVerifiedPlaceholderHeight] = useState(false);
  const verifyPlaceholderHeightRef = useRef(false);
  verifyPlaceholderHeightRef.current = p.node.renderedHeight === 300 && !verifiedPlaceholderHeight;
  const pendingRenderedHeightRef = useRef<number | null>(null);
  const renderedHeightFrameRef = useRef<number | null>(null);
  const fitAfterHeightFrameRef = useRef(false);
  const suppressHeightReportsUntilRef = useRef<number>(0);
  const pendingSuppressedHeightRef = useRef<number | null>(null);
  const heightReportFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [resizingMode, setResizingMode] = useState<ResizeMode | null>(null);
  // While dragging, the card paints above every other node ('active' → the
  // .dragging rule, z-index 20); after release it lingers on top briefly
  // ('linger' → .drag-top, z-index only) while physics finishes making room.
  const [dragTop, setDragTop] = useState<'active' | 'linger' | null>(null);
  const dragTopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (dragTopTimer.current) clearTimeout(dragTopTimer.current); }, []);
  // Strength changes on every qualifying pointer sample. Keep those updates
  // outside React: the boolean selector above re-renders only for the icon
  // swap, while this direct subscription adjusts inherited CSS variables on
  // the stationary button for the icon-only transform animation.
  useEffect(() => {
    let applied = false;
    const clear = () => {
      if (!applied) return;
      const button = pinButtonRef.current;
      if (button) {
        button.style.removeProperty('--pin-arm-scale');
        button.style.removeProperty('--pin-arm-x');
        button.style.removeProperty('--pin-arm-y');
        button.style.removeProperty('--pin-arm-duration');
      }
      applied = false;
    };
    const apply = () => {
      const button = pinButtonRef.current;
      const state = useDragArmStore.getState();
      if (!button || state.armedNodeId !== p.node.id) {
        clear();
        return;
      }
      const strength = state.strength;
      const horizontalPx = (0.75 + strength) * 1.15;
      button.style.setProperty('--pin-arm-scale', (1 + 0.3 * strength).toFixed(3));
      button.style.setProperty('--pin-arm-x', `${horizontalPx.toFixed(2)}px`);
      button.style.setProperty('--pin-arm-y', `${(horizontalPx * 0.15).toFixed(2)}px`);
      button.style.setProperty('--pin-arm-duration', `${(400 - 140 * strength).toFixed(0)}ms`);
      applied = true;
    };
    apply();
    const unsubscribe = useDragArmStore.subscribe(apply);
    return () => {
      unsubscribe();
      clear();
    };
  }, [p.node.id]);
  // Per-node "collapse the bullets section to just the freetext".
  // Persisted on ScatterNode so the choice survives reloads — see also
  // `frozen` for the same pattern. Toggle button lives in node-footer.
  const bulletsCollapsed = !!p.node.bulletsCollapsed;
  const rewriteSnapshot = useRewriteStore((s) => s.snapshot[p.node.id]);
  const isWholeActive = useIsWholeActive(p.node.id);
  // Does the current version have any L1 bullets? Cheap regex (same L1 rule
  // as bulletParse) — no full re-parse. A version with only freetext has none.
  const hasBullets = !!v && /^[-*+]\s+/m.test(v.body);
  const visibleHasBullets = hasBullets
    || (isWholeActive && !!rewriteSnapshot?.preBurstHadBullets);
  // A node with no bullets must render collapsed (just the opening paragraph)
  // — its bullet sizes are never measured, so this avoids a stale-tall body.
  // The chevron is disabled in that state (nothing to expand) until a bullet
  // reappears. No persistent state change: `bulletsCollapsed` is untouched.
  // Media nodes are never "collapsed": their body height is owned by the
  // chooser (auto) or the attached media's aspect size, not the freetext-
  // collapse path (which would squish the controls / the media).
  const effectivelyCollapsed = ct !== 'media' && ct !== 'interactive' && ct !== 'chat' && ct !== 'answer'
    && (bulletsCollapsed || !visibleHasBullets);
  const emptyMedia = ct === 'media' && !v?.media && !p.node.generating;
  const emptyText = isEmptyTextNode(p.node);
  const initialTextFrame = emptyText || (!!v?.initialTextFrame && !!p.node.generating);
  const imageGenerating = ct === 'media' && !!p.node.generating && !!v?.imageGeneration && !v?.media;
  const viewingInteractiveGeneration = ct === 'interactive'
    && !!p.node.generating
    && (p.node.generatingVersionIndex == null
      || p.node.generatingVersionIndex === p.node.currentVersionIndex)
    && !v?.interactive;
  // Freetext height, fed back from AdaptiveBullets so we can compute
  // the body's collapsed height (= freetext + a small overhead).
  //
  // Initial value is read from the SAVED `p.node.freeTextHeight` (if
  // any) so that on reload of a node with bulletsCollapsed=true, the
  // VERY FIRST render computes bodyStyle = collapsed and writes the
  // correct inline `style.height` to the DOM on the first commit. If
  // we waited for the post-mount measurement to feed the value back,
  // the first commit would write the bodyMaxH (expanded) value, the
  // second commit would write the collapsed value, and the browser's
  // CSS transition engine would animate between the two — that's the
  // "flash" the user saw on every refresh.
  //
  // useState's function-form initializer reads p.node.freeTextHeight
  // exactly once on mount; subsequent prop changes don't reset state.
  const [freeTextH, setFreeTextH] = useState<number | null>(
    () => v?.freeTextHeight ?? null,
  );
  const [premeasureExpand, setPremeasureExpand] = useState(false);
  const fitAfterBulletRevealRef = useRef(false);
  const [deferExpandedMeasurements, setDeferExpandedMeasurements] = useState(false);
  const deferExpandedMeasurementsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startDeferredExpandedMeasurements = useCallback(() => {
    if (deferExpandedMeasurementsTimerRef.current) {
      clearTimeout(deferExpandedMeasurementsTimerRef.current);
    }
    setDeferExpandedMeasurements(true);
    deferExpandedMeasurementsTimerRef.current = setTimeout(() => {
      deferExpandedMeasurementsTimerRef.current = null;
      setDeferExpandedMeasurements(false);
    }, 280);
  }, []);
  useEffect(() => () => {
    if (deferExpandedMeasurementsTimerRef.current) {
      clearTimeout(deferExpandedMeasurementsTimerRef.current);
    }
  }, []);
  const publishRenderedHeight = useCallback((h: number) => {
    if (h <= 0) return;
    if (Math.abs(h - lastReportedHeight.current) >= 4) {
      lastReportedHeight.current = h;
      pendingRenderedHeightRef.current = h;
    }
    if (fitAfterBulletRevealRef.current) {
      fitAfterBulletRevealRef.current = false;
      fitAfterHeightFrameRef.current = true;
    }
    if (pendingRenderedHeightRef.current == null && !fitAfterHeightFrameRef.current) return;
    if (renderedHeightFrameRef.current != null) return;
    // ResizeObserver runs during the browser's pre-paint layout delivery.
    // Writing to Zustand synchronously from there can re-render the canvas,
    // produce another layout, and recursively re-enter the observer. Commit
    // only the newest sample on the following frame instead.
    renderedHeightFrameRef.current = requestAnimationFrame(() => {
      renderedHeightFrameRef.current = null;
      const nextHeight = pendingRenderedHeightRef.current;
      pendingRenderedHeightRef.current = null;
      const projectId = useGraphStore.getState().project?.id;
      if (projectId === nodeProjectId && nextHeight != null) {
        useGraphStore.temporal.getState().pause();
        try {
          useGraphStore.getState().updateNode(p.node.id, { renderedHeight: nextHeight });
        } finally {
          useGraphStore.temporal.getState().resume();
        }
      }
      if (projectId === nodeProjectId && fitAfterHeightFrameRef.current) {
        fitAfterHeightFrameRef.current = false;
        // Canvas's existing minimum-pan routine keeps the entire newly-grown
        // node in view and zooms out only when it truly cannot fit.
        useGraphStore.getState().requestPanTo(p.node.id, undefined, 'expand');
      }
    });
  }, [p.node.id, nodeProjectId]);
  useEffect(() => () => {
    if (renderedHeightFrameRef.current != null) {
      cancelAnimationFrame(renderedHeightFrameRef.current);
    }
    renderedHeightFrameRef.current = null;
    pendingRenderedHeightRef.current = null;
    fitAfterHeightFrameRef.current = false;
  }, []);
  const startHeightReportSuppression = useCallback(() => {
    suppressHeightReportsUntilRef.current = Date.now() + 280;
    pendingSuppressedHeightRef.current = null;
    if (heightReportFlushTimerRef.current) clearTimeout(heightReportFlushTimerRef.current);
    heightReportFlushTimerRef.current = setTimeout(() => {
      heightReportFlushTimerRef.current = null;
      suppressHeightReportsUntilRef.current = 0;
      const pending = pendingSuppressedHeightRef.current;
      pendingSuppressedHeightRef.current = null;
      if (pending != null) publishRenderedHeight(pending);
    }, 300);
  }, [publishRenderedHeight]);
  useEffect(() => () => {
    if (heightReportFlushTimerRef.current) clearTimeout(heightReportFlushTimerRef.current);
  }, []);
  // Stable callback identity so AdaptiveBullets' effect dep array
  // doesn't see a new function reference every parent render. The
  // callback both updates local state (for THIS session's body
  // sizing) AND persists the value on the node (so the NEXT reload
  // skips the measurement-cascade flash described above). The
  // 1-pixel epsilon on the persist suppresses churn from
  // sub-pixel ResizeObserver fluctuations.
  const nodeId = p.node.id;
  const savedFreeTextH = v?.freeTextHeight;
  const onFreeTextH = useCallback((h: number) => {
    setFreeTextH(h);
    if (savedFreeTextH == null || Math.abs(savedFreeTextH - h) > 1) {
      useGraphStore.getState().setVersionSize(nodeId, { freeTextHeight: h });
    }
  }, [nodeId, savedFreeTextH]);
  const currentCardWidth = nodeWidth(p.node);
  const expandedMeasureWidth = v?.expandedMeasureWidth;
  const expandedMeasurementsFresh = !hasBullets
    || (expandedMeasureWidth != null && Math.abs(expandedMeasureWidth - currentCardWidth) <= 1);
  useEffect(() => {
    if (!premeasureExpand) return;
    if (!bulletsCollapsed || !hasBullets) {
      setPremeasureExpand(false);
      return;
    }
    const latest = useGraphStore.getState().project?.nodes[p.node.id] ?? p.node;
    const latestVer = latest.versions[latest.currentVersionIndex];
    const latestWidth = nodeWidth(latest);
    const fresh = latestVer?.expandedMeasureWidth != null
      && Math.abs(latestVer.expandedMeasureWidth - latestWidth) <= 1;
    if (fresh && latestVer?.bodyMaxHeight != null) {
      setPremeasureExpand(false);
      setDeferExpandedMeasurements(false);
      startHeightReportSuppression();
      useGraphStore.getState().updateNode(p.node.id, { bulletsCollapsed: false });
    }
  }, [
    premeasureExpand,
    bulletsCollapsed,
    hasBullets,
    p.node,
    p.node.id,
    startHeightReportSuppression,
    v?.expandedMeasureWidth,
    v?.bodyMaxHeight,
  ]);
  // Set on the pointer-up that ENDED a drag/resize so the synthetic click
  // event that follows can be suppressed. Without this, the wrapper-level
  // onClick (which selects the node) fires after every drag.
  const justDraggedRef = useRef(false);

  // R6.A1/A2 — fonts gate. The body font (Atkinson Hyperlegible) loads
  // with display: swap, so the first paint measures text with
  // fallback-font metrics; reporting those transient heights kicked
  // the physics sim on every reload (and the post-swap correction
  // animated through the 0.25 s body-height transition). Until fonts
  // are ready we (a) don't report renderedHeight and (b) keep the
  // `booting` class on the card, which suppresses all size
  // transitions (globals.css) so the post-swap correction snaps
  // invisibly. Nodes mounted after load see fonts already loaded and
  // are unaffected.
  const [fontsSettled, setFontsSettled] = useState<boolean>(() => {
    if (typeof document === 'undefined' || !document.fonts) return true;
    return document.fonts.status === 'loaded';
  });
  useEffect(() => {
    if (fontsSettled) return;
    if (typeof document === 'undefined' || !document.fonts) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      // One extra frame so the post-swap re-layout commits BEFORE
      // transitions are re-enabled and heights get reported.
      requestAnimationFrame(() => {
        if (!cancelled) setFontsSettled(true);
      });
    });
    return () => { cancelled = true; };
  }, [fontsSettled]);

  // Body sizing for fresh nodes is owned by AdaptiveBullets — it renders
  // hidden bullet lists at MIN_NODE_W, computes max(A, B), and locks
  // bodyMaxHeight to that measured size on first paint. We don't
  // pre-set anything here.

  // Snap-down sizing after a rewrite burst commits a smaller version.
  //
  // `pendingSnapDown` is set by `finishRewrite` (lib/generate.ts) when
  // a burst commits AND the node was at its minimum body height when
  // the burst began. After commit, React re-renders this NodeView
  // with the new version; AdaptiveBullets then re-measures and writes
  // the NEW minBodyHeight; this effect fires once that lands, and
  // (if the new minBodyHeight is genuinely smaller AND the user
  // hasn't resized up in the meantime) shrinks bodyMaxHeight to the
  // new minimum. The flag is then cleared.
  //
  // Cleared unconditionally on every run — the burst is over the
  // moment the version commits, so the flag should never persist
  // across renders. If the new min isn't smaller (the new version
  // happens to need the same/more space), we still clear so a future
  // unrelated resize doesn't accidentally trigger a snap.
  const pendingSnapDown = useRewriteStore(
    (s) => s.pendingSnapDown[p.node.id],
  );
  // Header pulse signal: complete rewrites and initial spawn streams pulse
  // every node header. Partial rewrites normally pulse only their targeted
  // section, but an interactive explanation's single prose section also
  // pulses its header so the compact card and the large viewer communicate
  // the same "Expand text is still running" state.
  const hasAnyActive = useHasAnyActive(p.node.id);
  const headerGenerating = isWholeActive
    || (!!p.node.generating && (!hasAnyActive || ct === 'interactive'));
  const overviewPulseStyle = useGenerationPulseSync(headerGenerating);
  useEffect(() => {
    if (!pendingSnapDown) return;
    // AdaptiveBullets' useLayoutEffect re-measures the new version's
    // body and (if min changed) writes the new minBodyHeight via
    // updateNode. That layout effect runs in the same commit cycle
    // as this useEffect — useLayoutEffects fire BEFORE useEffects —
    // so by the time we're here, the store already holds the fresh
    // minBodyHeight even though our `p.node` prop snapshot may still
    // reflect the previous render's value. Read latest from the
    // store directly.
    const latest = useGraphStore.getState().project?.nodes[p.node.id];
    const latestVer = latest?.versions[latest.currentVersionIndex];
    if (!latestVer) return;
    const newMin = latestVer.minBodyHeight;
    const curMax = latestVer.bodyMaxHeight;
    if (newMin == null || curMax == null) {
      useRewriteStore.getState().clearPendingSnapDown(p.node.id);
      return;
    }
    // Snap only when the new version's min is genuinely smaller AND
    // the user hasn't grown the box above the new min during the
    // burst (defensive — bursts are usually too short for a manual
    // resize, but it could happen).
    if (newMin < pendingSnapDown.preBurstMinBodyHeight && curMax > newMin) {
      useGraphStore.temporal.getState().pause();
      try {
        useGraphStore.getState().setVersionSize(p.node.id, { bodyMaxHeight: newMin });
      } finally {
        useGraphStore.temporal.getState().resume();
      }
    }
    useRewriteStore.getState().clearPendingSnapDown(p.node.id);
  }, [pendingSnapDown, v?.minBodyHeight, v?.bodyMaxHeight, p.node.id]);

  // Auto-bump width for legacy nodes whose stored width is below the new
  // floor. Body height is left to AdaptiveBullets to grow when needed.
  useEffect(() => {
    if (!v) return;
    if (p.node.generating) return;
    const w = v.width ?? DEFAULT_NODE_W;
    // Media nodes own their width entirely (snug chooser / aspect-fit), both of
    // which are legitimately narrower than MIN_NODE_W — so the floor must NOT
    // apply to them (this is the v1 "stuck at 624" bug).
    if (ct === 'media') return;
    // Bump any stored width below the node's effective floor up to it
    // (legacy nodes might be smaller if MIN_NODE_W changed since they were
    // saved; aspect-capped versions carry a raised minWidth).
    const floor = v.minWidth ?? MIN_NODE_W;
    if (w < floor) {
      useGraphStore.temporal.getState().pause();
      try {
        useGraphStore.getState().setVersionSize(p.node.id, { width: floor });
      } finally {
        useGraphStore.temporal.getState().resume();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.node.id, p.node.generating, p.node.currentVersionIndex]);

  if (!v) return null;

  // Header is the drag handle. mousedown → start tracking; if mouse moves > 3 px,
  // it's a drag. Otherwise pointerup just selects.
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = {
      originX: e.clientX,
      originY: e.clientY,
      // PERF R2: anchor the drag at the LIVE position (where the node
      // is visually right now), not the saved project position.
      nodeX: posX,
      nodeY: posY,
      pointerId: e.pointerId,
      moved: false,
    };
    // Requires a deliberate shake (6 quick reversals ≈ three full back-and-forths).
    if (!shakeRef.current) shakeRef.current = createShakeDetector({ minReversals: 6 });
    shakeRef.current.reset();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* ignore synthetic events */ }
  };

  const onHeaderPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dxScreen = e.clientX - d.originX;
    const dyScreen = e.clientY - d.originY;
    if (!d.moved && Math.abs(dxScreen) < DRAG_THRESHOLD_PX && Math.abs(dyScreen) < DRAG_THRESHOLD_PX) return;
    if (!d.moved) {
      d.moved = true;
      // Drag should NOT change focus — the user just wants to move the
      // node. Selection is reserved for click-without-drag (handled in
      // onPointerUp / onClick below).
      p.onDragStart(d.nodeX, d.nodeY, 'drag');
      if (dragTopTimer.current) clearTimeout(dragTopTimer.current);
      setDragTop('active');
    }
    const z = liveZoom();
    const targetX = d.nodeX + dxScreen / z;
    const targetY = d.nodeY + dyScreen / z;
    p.onDragMove(targetX, targetY, { unpinnedByShake: !!d.unpinnedByShake });

    // Shake a pinned node to release it. Feed the raw screen pointer to the
    // detector; on a confirmed shake, unpin once (a real, undoable action) and
    // flag the gesture so Canvas's drag-away logic won't immediately re-pin it.
    if (!p.multiSelected && p.node.frozen && !d.unpinnedByShake && shakeRef.current
        && shakeRef.current.push(e.clientX, e.clientY, e.timeStamp)) {
      d.unpinnedByShake = true;
      useGraphStore.getState().updateNode(p.node.id, { frozen: false });
      useDragArmStore.getState().setArmed(null);
      useDragHintStore.getState().clear(p.node.id);
    }
  };

  const onHeaderPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.moved) {
      p.onDragEnd({ unpinnedByShake: !!d.unpinnedByShake });
      // Eat the synthetic click that follows so the wrapper's onClick
      // doesn't focus this node just because the user dragged it.
      justDraggedRef.current = true;
      setDragTop('linger');
      if (dragTopTimer.current) clearTimeout(dragTopTimer.current);
      dragTopTimer.current = setTimeout(() => setDragTop(null), DRAG_TOP_LINGER_MS);
    } else {
      p.onSelect();
    }
    dragRef.current = null;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // ─── Resize handlers ─────────────────────────────────────────────────
  // Four corners. Each corner anchors the OPPOSITE corner in place — e.g.
  // dragging tl moves position.x/y AND grows/shrinks width/height so the
  // bottom-right corner stays fixed. The node is also pinned via
  // onDragStart/Move/End so physics doesn't drift it during the resize.

  // Minimum body height the resize handle will allow. Sourced from
  // node.minBodyHeight, which AdaptiveBullets computes by measuring
  // hidden bullet lists at MIN_NODE_W and storing max(A, B) plus a
  // safety margin. Falls back to MIN_BODY_MAX_H for legacy nodes that
  // haven't been measured yet.
  const computeBodyMin = (): number => {
    return v?.minBodyHeight ?? MIN_BODY_MAX_H;
  };

  const onResizePointerDown = (mode: ResizeMode) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // First-time resize: freeze the current visible body height so further
    // width changes don't grow the card unexpectedly.
    if (ct !== 'interactive' && !effectivelyCollapsed && v?.bodyMaxHeight == null) {
      const bodyEl = wrapperRef.current?.querySelector('.node-body') as HTMLElement | null;
      if (bodyEl) {
        const measuredH = bodyEl.getBoundingClientRect().height / liveZoom();
        useGraphStore.temporal.getState().pause();
        try {
          useGraphStore.getState().setVersionSize(p.node.id, { bodyMaxHeight: Math.round(measuredH) });
        } finally {
          useGraphStore.temporal.getState().resume();
        }
      }
    }
    // Mark body as resizing so adaptive-bullet transitions don't lag.
    const bodyEl2 = wrapperRef.current?.querySelector('.node-body') as HTMLElement | null;
    if (bodyEl2) bodyEl2.classList.add('is-resizing');
    const latest = useGraphStore.getState().project?.nodes[p.node.id] ?? p.node;
    // PERF R2: read the resize anchor from the LIVE position, not the
    // saved `project.position` which may be behind by however far
    // physics has settled since the last commit.
    const liveSelf = useLivePositionsStore.getState().positions[p.node.id];
    const anchorX = liveSelf?.x ?? latest.position.x;
    const anchorY = liveSelf?.y ?? latest.position.y;
    resizeRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startW: nodeWidth(latest),
      startBodyH: nodeBodyMaxH(latest),
      startRenderedH: nodeRenderedH(latest),
      startNodeX: anchorX,
      startNodeY: anchorY,
      pointerId: e.pointerId,
      collapsedAtStart: effectivelyCollapsed,
    };
    setResizingMode(mode);
    // Pause history while dragging — release on pointer up.
    useGraphStore.temporal.getState().pause();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Pin the node via the worker-drag mechanism so physics doesn't move it
    // mid-resize. arrows that touch this rect also go invisible during the
    // pin (already wired in physicsWorker via draggingIds).
    p.onDragStart(anchorX, anchorY, 'resize');
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    const z = liveZoom();
    const dx = (e.clientX - r.startX) / z;
    const dy = (e.clientY - r.startY) / z;

    // Chrome height = rendered − body. Constant during a resize.
    const chromeH = r.startRenderedH - r.startBodyH;
    const leftCorner = r.mode === 'tl' || r.mode === 'bl';
    const topCorner = r.mode === 'tl' || r.mode === 'tr';

    // The gap the physics floor keeps between any two cards (2 × collidePadding).
    // Stopping the resize this far short of a pinned wall means the worker's
    // drag-clamp finds no overlap on the next tick, so it never shoves the
    // resized node back off the pin (read by the user as "the node moves").
    const collidePadding =
      useSettingsStore.getState().physicsConfig?.collidePadding ?? DEFAULT_PHYSICS_CONFIG.collidePadding;
    const GAP = 2 * collidePadding;

    // Every OTHER node's CURRENT rect (live positions), pinned-aware, used as
    // resize walls. PERF R2: live store, falling back to project position.
    const proj = useGraphStore.getState().project;
    const others: RectInfo[] = [];
    if (proj) {
      const livePositions = useLivePositionsStore.getState().positions;
      for (const [id, n] of Object.entries(proj.nodes)) {
        if (id === p.node.id) continue;
        const live = livePositions[id];
        others.push({
          x: live?.x ?? n.position.x,
          y: live?.y ?? n.position.y,
          w: nodeWidth(n),
          h: nodeRenderedH(n),
          pinned: !!n.frozen,
        });
      }
    }
    const startRect = { x: r.startNodeX, y: r.startNodeY, w: r.startW, h: r.startRenderedH };

    // Media and interactive programs: aspect-locked resize via the intrinsic ratio
    // (never distort/crop); a pinned wall on EITHER axis caps the width so the
    // card still stops cleanly at the gap instead of overlapping the pin.
    const mediaRef = v?.media;
    const intrinsic = ct === 'interactive' ? interactiveDisplaySize(v?.interactive, true)
      : mediaRef ? { width: 1, height: mediaHeightPerWidth(mediaRef.naturalWidth ?? 0, mediaRef.naturalHeight ?? 0) }
        : undefined;
    if (intrinsic) {
      const ratio = intrinsic.height / intrinsic.width;
      const widthDelta = leftCorner ? -dx : dx;
      const heightDeltaAsWidth = (topCorner ? -dy : dy) / ratio;
      // A vertical drag should also resize an interactive surface. Existing
      // media gestures retain their width-driven behavior.
      let proposedW = r.startW + (ct === 'interactive' && Math.abs(heightDeltaAsWidth) > Math.abs(widthDelta)
        ? heightDeltaAsWidth : widthDelta);
      if (others.length > 0) {
        const maxW = maxMediaWidthAgainstChain(startRect, r.mode, ratio, chromeH, others, GAP);
        if (proposedW > maxW) proposedW = maxW;
      }
      const fit = aspectResize(intrinsic.width, intrinsic.height, proposedW);
      const renderedH = fit.bodyMaxHeight + chromeH;
      let nx = r.startNodeX;
      let ny = r.startNodeY;
      if (leftCorner) nx = r.startNodeX + (r.startW - fit.width);
      if (topCorner) ny = r.startNodeY + (r.startRenderedH - renderedH);
      const mrx = Math.round(nx), mry = Math.round(ny);
      useGraphStore.getState().setVersionSize(p.node.id, ct === 'interactive'
        ? { interactiveCanvasWidth: fit.width }
        : { width: fit.width, bodyMaxHeight: fit.bodyMaxHeight });
      // NodeView owns the resized node's live position (Canvas skips the
      // worker's echo for it) — write it directly so position tracks size with
      // no one-frame lag. updateNode keeps project/undo in sync, same value.
      useLivePositionsStore.getState().setPosition(p.node.id, mrx, mry);
      useGraphStore.getState().updateNode(p.node.id, { position: { x: mrx, y: mry } });
      p.onDragMove(nx, ny, { unpinnedByShake: false });
      return;
    }

    // Effective minimum width — raised above the global floor for versions the
    // 3:2 aspect cap widened (their height floor was measured at this width,
    // so going narrower would overflow).
    const minW = v?.minWidth ?? MIN_NODE_W;

    if (r.collapsedAtStart) {
      let newW = leftCorner ? Math.max(minW, r.startW - dx) : Math.max(minW, r.startW + dx);
      let newX = leftCorner ? r.startNodeX + (r.startW - newW) : r.startNodeX;
      let newY = r.startNodeY;

      if (others.length > 0) {
        if (leftCorner) {
          const left = wallLeft(startRect, others) + GAP;
          if (newX < left) {
            newX = left;
            newW = (r.startNodeX + r.startW) - left;
          }
        } else {
          const right = wallRight(startRect, others) - GAP;
          if (newX + newW > right) newW = Math.max(0, right - newX);
        }
        if (newW < minW) {
          if (leftCorner) newX -= minW - newW;
          newW = minW;
        }
      }

      const roundedW = Math.round(newW);
      const rx = Math.round(newX);
      const ry = Math.round(newY);
      const sizePatch: { width: number; expandedMeasureWidth?: number } = { width: roundedW };
      if (Math.abs(roundedW - r.startW) > 1) sizePatch.expandedMeasureWidth = undefined;
      useGraphStore.getState().setVersionSize(p.node.id, sizePatch);
      useLivePositionsStore.getState().setPosition(p.node.id, rx, ry);
      useGraphStore.getState().updateNode(p.node.id, {
        position: { x: rx, y: ry },
      });
      p.onDragMove(newX, newY, { unpinnedByShake: false });
      return;
    }

    const minRenderedH = computeBodyMin() + chromeH;

    // X/Y: left/top corners move the near edge inward and keep the far edge
    // anchored; right/bottom corners only change size.
    let newW = leftCorner ? Math.max(minW, r.startW - dx) : Math.max(minW, r.startW + dx);
    let newRenderedH = topCorner
      ? Math.max(minRenderedH, r.startRenderedH - dy)
      : Math.max(minRenderedH, r.startRenderedH + dy);
    let newX = leftCorner ? r.startNodeX + (r.startW - newW) : r.startNodeX;
    let newY = topCorner ? r.startNodeY + (r.startRenderedH - newRenderedH) : r.startNodeY;

    // Clamp against pinned neighbours, reserving the physics gap so the card
    // stops at the rest margin rather than being shoved back off the pin.
    if (others.length > 0) {
      const clamped = clampResizeAgainstChain(
        { x: newX, y: newY, w: newW, h: newRenderedH },
        startRect,
        r.mode,
        others,
        GAP,
      );
      newX = clamped.x; newY = clamped.y;
      newW = clamped.w; newRenderedH = clamped.h;
      // Re-enforce minimums after clamp.
      if (newW < minW) {
        if (leftCorner) newX -= minW - newW;
        newW = minW;
      }
      if (newRenderedH < minRenderedH) {
        if (topCorner) newY -= minRenderedH - newRenderedH;
        newRenderedH = minRenderedH;
      }
    }

    const newBodyH = newRenderedH - chromeH;
    const rx = Math.round(newX), ry = Math.round(newY);
    // Size goes on the current version; position stays node-level. Both run
    // inside the paused resize gesture, so the two sets don't add undo entries.
    useGraphStore.getState().setVersionSize(p.node.id, {
      width: Math.round(newW),
      bodyMaxHeight: Math.round(newBodyH),
    });
    // NodeView owns the resized node's live position (Canvas skips the worker's
    // echo for it) — write it directly so position tracks size with no
    // one-frame lag. updateNode keeps project/undo in sync, same value.
    useLivePositionsStore.getState().setPosition(p.node.id, rx, ry);
    useGraphStore.getState().updateNode(p.node.id, {
      position: { x: rx, y: ry },
    });
    // Keep the worker's pin tracking the node's new top-left so physics sees a
    // stationary rect even though x/y are shifting (top/left corners).
    p.onDragMove(newX, newY, { unpinnedByShake: false });
  };

  const onResizePointerUp = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r || e.pointerId !== r.pointerId) return;
    // Width is no longer changed by dragging — only by the side panel —
    // so no snap-on-release is needed here.
    resizeRef.current = null;
    setResizingMode(null);
    useGraphStore.temporal.getState().resume();
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    // Drop the resize-suppress class after the last cascade tick settles
    // (180ms is plenty for the ResizeObserver to fire one more time).
    const bodyEl = wrapperRef.current?.querySelector('.node-body') as HTMLElement | null;
    if (bodyEl) setTimeout(() => bodyEl.classList.remove('is-resizing'), 180);
    // Release the pin so physics can move the node again (unless the user
    // also has it pinned via the toolbar — that's persistent).
    p.onDragEnd();
    // Suppress the wrapper-onClick that follows so finishing a resize
    // doesn't accidentally focus the node.
    justDraggedRef.current = true;
  };

  const classes = [
    'node',
    p.selected && 'selected',
    p.node.frozen && 'frozen',
    p.node.generating && 'loading',
    imageGenerating && 'image-generating',
    viewingInteractiveGeneration && 'interactive-generating',
    standaloneInteractive && 'interactive-standalone',
    (ct === 'chat' || ct === 'answer') && 'chat-node',
    ct === 'answer' && 'answer-node',
    overviewEligible && 'node-overview-eligible',
    highlighted && 'highlighted',
    dragTop === 'active' && 'dragging',
    dragTop === 'linger' && 'drag-top',
    // R6.A2 — suppress size transitions until the web font has
    // swapped in and the post-swap layout has committed.
    !fontsSettled && 'booting',
    initialTextFrame && 'node-initial-text-frame',
  ].filter(Boolean).join(' ');

  // Inline overrides — only set when user has resized (so the CSS defaults
  // continue to apply otherwise).
  const cardW = nodeWidth(p.node);
  const bodyMaxH = v.bodyMaxHeight;
  const cardStyle: React.CSSProperties = {
    transform: `translate3d(${posX}px, ${posY}px, 0)`,
  };
  if (cardW != null) cardStyle.width = `${cardW}px`;
  if (initialTextFrame) cardStyle.height = `${cardW * (ct === 'explain' ? .625 : 1.25)}px`;
  // C.8 — Group color cascades via CSS custom properties. Setting
  // --tint-1..4 + --node-tag-bg on the .node element recolors every
  // child that uses those vars (bullet hover/active, footer tag,
  // side-panel buttons-when-hovered) via the normal CSS cascade.
  // Single source of truth → many surfaces colored at once. The
  // global tint scale (`globals.css:99-125`) covers the same percent
  // tiers (10/18/22/30) with --text instead of an accent.
  // Corner resize handles tint to a muted version of this node's group color
  // (neutral grey when ungrouped) via this CSS variable.
  (cardStyle as React.CSSProperties & Record<string, string>)['--node-marker'] = mutedAccentHex(
    groupColor, accentHueShift, accentDesaturate, accentDarken, resolvedTheme,
  );
  if (groupColor) {
    const sty = cardStyle as React.CSSProperties & Record<string, string>;
    // Bullet hover (--tint-1) and bullet active (--tint-2) — held to
    // the lower end of the scale per user note "node bullet point
    // backgrounds less opaque". Colored tints read heavier than grey
    // ones at the same percent, so the group-color tier sits well
    // below where you'd extrapolate from the neutral scale
    // (--tint-1 at 2.5% / --tint-2 at 3.5% of var(--text)).
    const gc = colorToCss(groupColor);
    sty['--tint-1'] = `color-mix(in oklab, ${gc} 5%, transparent)`;
    sty['--tint-2'] = `color-mix(in oklab, ${gc} 10%, transparent)`;
    sty['--tint-3'] = `color-mix(in oklab, ${gc} 22%, transparent)`;
    sty['--tint-4'] = `color-mix(in oklab, ${gc} 30%, transparent)`;
    sty['--control-accent'] = gc;
    // Full-strength accent for the inline [n] citation markers (and the sources
    // panel's active-row bar), so citations adopt the node's identity color.
    sty['--node-accent'] = gc;
    sty['--node-tag-bg'] = `color-mix(in oklab, ${gc} 25%, transparent)`;
    // Smart-selection highlight (.node ::selection) — group color, a touch
    // stronger than the active-term tint (--tint-4 at 30%). Ungrouped nodes
    // leave --sel-bg unset and fall back to the neutral grey in globals.css.
    sty['--sel-bg'] = `color-mix(in oklab, ${gc} 40%, transparent)`;
  }

  // BODY_COLLAPSED_OVERHEAD = 11 is the precise amount that lands
  // the bullets-section divider's bottom edge AT the body's padding-
  // box bottom edge — visually merging the divider with the
  // .node-footer top border into one horizontal line.
  //
  // Decomposition (assumes box-sizing: border-box on .node-body,
  // which the * { box-sizing: border-box } global rule provides):
  //   padding-top (4) + freetext (H) + flex-gap (6) + divider (1)
  //   = H + 11.
  // With the body's outer height set inline to this value, the
  // first bullet (which would normally sit just below the divider)
  // ends up BEYOND the body's padding-box, fully clipped by the
  // body's `overflow: hidden`. That removes the "first bullet
  // highlights on hover at the bottom" symptom that the older
  // overhead value (18) caused — the larger value left ~7 px of
  // the bullet visible AND hit-testable inside the body.
  const BODY_COLLAPSED_OVERHEAD = 11;
  const bodyStyle: React.CSSProperties | undefined = (() => {
    if (ct === 'chat' || ct === 'answer') return { height: `${bodyMaxH ?? 600}px`, maxHeight: 'none' };
    // A strict-source miss can inherit the provisional version's tiny explicit
    // body height. Let this compact notice size itself naturally instead of
    // clipping it behind the node body's normal overflow guard.
    if (v.sourceLimitation?.kind === 'not-enough-information') {
      return { height: 'auto', minHeight: '68px', maxHeight: 'none' };
    }
    // The interactive surface has a fixed landscape well below prose. A legacy
    // explanation height must never clip that sandbox after conversion.
    if (ct === 'interactive') return undefined;
    const rewriteFloor = isWholeActive
      ? rewriteSnapshot?.preBurstBodyHeightFloor ?? null
      : null;
    const stableFreeTextH = isWholeActive
      ? Math.max(freeTextH ?? 0, rewriteSnapshot?.preBurstFreeTextHeight ?? 0)
      : freeTextH;
    if (effectivelyCollapsed && stableFreeTextH != null) {
      return {
        height: `${Math.max(
          stableFreeTextH + BODY_COLLAPSED_OVERHEAD,
          rewriteFloor ?? 0,
        )}px`,
        maxHeight: 'none',
      };
    }
    const expandedHeight = Math.max(bodyMaxH ?? 0, rewriteFloor ?? 0);
    if (expandedHeight > 0) {
      return { height: `${expandedHeight}px`, maxHeight: 'none' };
    }
    return undefined;
  })();
  // Off-screen content-visibility must use this card's saved footprint from
  // its FIRST render, including cards mounted after the overview controller.
  // Old files can contain the former generic 300px placeholder. Verify it
  // once, and repair any saved footprint too short to contain the known body.
  const knownBodyHeight = typeof bodyStyle?.height === 'string' ? parseFloat(bodyStyle.height) : 0;
  const needsInitialMeasurement = !p.node.renderedHeight
    || (p.node.renderedHeight === 300 && !verifiedPlaceholderHeight)
    || (Number.isFinite(knownBodyHeight) && knownBodyHeight >= p.node.renderedHeight);
  // Remains null during ordinary resizing; only invalid saved sizes need
  // to restart the observer and its reporting baseline.
  const invalidSavedHeight = needsInitialMeasurement ? (p.node.renderedHeight ?? 0) : null;
  useEffect(() => {
    if (!fontsSettled) return;
    const el = wrapperRef.current;
    if (!el) return;
    // An older cloud snapshot can replace a card's saved height without
    // changing its actual DOM size. Re-observe once and reset the reporting
    // baseline so that identical real size still repairs the incoming cache.
    if (invalidSavedHeight != null) lastReportedHeight.current = invalidSavedHeight;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.round(entry.contentRect.height);
        if (h <= 0) continue;
        // A genuinely ~300px card is safe to cache (the height reporter has
        // a 4px dead zone). Otherwise keep real layout until next frame's fix.
        if (verifyPlaceholderHeightRef.current && Math.abs(h - 300) < 4) {
          verifyPlaceholderHeightRef.current = false;
          setVerifiedPlaceholderHeight(true);
        }
        if (Date.now() < suppressHeightReportsUntilRef.current) {
          pendingSuppressedHeightRef.current = h;
          continue;
        }
        publishRenderedHeight(h);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [p.node.id, fontsSettled, publishRenderedHeight, invalidSavedHeight]);
  return (
    <div
      ref={wrapperRef}
      className={classes}
      // The floating side panel locates its anchor node by this id (it
      // lives in a sibling subtree, so it can't reach the node via refs).
      data-node-id={p.node.id}
      lang={languageInfo(v?.language).locale}
      data-language-direction={p.node.chat ? undefined : languageDirection(v?.language)}
      data-node-overview-active={overviewInitiallyActive ? '' : undefined}
      data-node-needs-measurement={needsInitialMeasurement ? '' : undefined}
      style={{ ...cardStyle, ...readingVariables }}
      // Clicking anywhere on the node (header, body text, footer, …) selects
      // it. ReferenceChip / corner buttons / resize dots all stopPropagation
      // on their click handlers, so this only fires for "empty" clicks on
      // the node body or chrome. After a drag/resize the pointer-up handler
      // sets justDraggedRef so the synthetic click that follows is eaten —
      // dragging shouldn't bring the node into focus.
      onClick={(e) => {
        if (justDraggedRef.current) {
          justDraggedRef.current = false;
          return;
        }
        // A click that ends a text-selection drag in the body shouldn't
        // (re)select the node — leave the user's selection intact. A plain
        // click has a collapsed selection by the time it fires, so it passes.
        if (!window.getSelection()?.isCollapsed) return;
        e.stopPropagation();
        // Focus (and its aura ripple) happens ONLY on a real focus change:
        // onSelect() drives the selection transition that ripples. Re-clicking
        // an already-focused node (e.g. clicking a bullet to expand it) is
        // intentionally NOT a refocus — no ripple.
        if (!p.selected || p.multiSelected) p.onSelect();
      }}
    >
      {/* Left-margin search markers — lines flagging bullets whose (possibly
          collapsed) detail matches the search. Filled imperatively by
          SearchHighlighter so the bullet cascade never re-renders on typing. */}
      <div className="sc-bullet-markers" aria-hidden="true" />
      {overviewEligible && (
        <div
          className="node-overview-surface"
          aria-hidden={overviewInitiallyActive ? undefined : true}
          style={{
            opacity: overviewInitiallyActive ? 1 : 0,
            pointerEvents: overviewInitiallyActive ? 'auto' : 'none',
          }}
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          data-tip="Drag to move the node"
        >
          <h3
            className={`node-title node-overview-title${headerGenerating ? ' is-generating' : ''}`}
            data-overview-title-compact={overviewInitiallyActive && initialOverviewTitleLayout.reserve > 0 ? '' : undefined}
            style={{
              ...overviewPulseStyle,
              fontSize: overviewInitiallyActive
                ? `${overviewFontSizeForZoom(overviewInitialZoom)}px`
                : undefined,
              '--overview-title-lines': overviewInitiallyActive ? initialOverviewTitleLayout.lines : undefined,
              '--overview-title-reserve': overviewInitiallyActive ? `${initialOverviewTitleLayout.reserve}px` : undefined,
            } as React.CSSProperties}
            aria-label={flattenHeaderParts(headerParts)}
          >
            <span className="node-overview-title-copy">
              <OverviewHeaderText parts={headerParts} />
              {pendingImageTitle && <span className="group-title-dots" aria-hidden="true">...</span>}
            </span>
          </h3>
          {!emptyText && !emptyMedia && (
            <div
              className={`node-overview-skeleton${ct === 'chat' ? ' node-overview-skeleton--chat' : standaloneInteractive ? ' node-overview-skeleton--interactive' : ''}`}
              aria-hidden="true"
              style={overviewInitiallyActive ? {
                '--overview-skeleton-gap': `${initialOverviewSkeletonMetrics.gap}px`,
                '--overview-skeleton-unit': `${initialOverviewSkeletonMetrics.unit}px`,
                '--overview-control-clearance': `${initialOverviewSkeletonMetrics.controlClearance}px`,
              } as React.CSSProperties : undefined}
            />
          )}
        </div>
      )}
      <div
        className="node-detail-surface"
        aria-hidden={overviewInitiallyActive ? true : undefined}
        style={{
          opacity: overviewInitiallyActive ? 0 : 1,
          containIntrinsicSize: `${cardW}px ${nodeRenderedH(p.node)}px`,
          contentVisibility: needsInitialMeasurement ? 'visible' : overviewInitiallyActive ? 'hidden' : 'auto',
        }}
      >
          <div
            style={{ cursor: 'var(--cur-move)' }}
            onPointerDown={onHeaderPointerDown}
            onPointerMove={onHeaderPointerMove}
            onPointerUp={onHeaderPointerUp}
            onPointerCancel={onHeaderPointerUp}
            data-tip="Drag to move the node"
          >
            {p.node.chat || ct === 'answer' || standaloneInteractive ? <div className="node-header"><ChatInlineTitle title={p.node.chat?.title ?? v.header}
              key={`${p.node.id}:${p.node.chat ? 'chat' : v.createdAt}`}
              label="Edit header" generating={headerGenerating} editNonce={titleEditNonce} showEditButton={false}
              onSave={(title) => { if (nodeProjectId) saveNodeHeader(nodeProjectId, p.node.id, v.createdAt, title); }} /></div> : <NodeHeader
              key={`${p.node.id}:${v.createdAt}`}
              parts={headerParts}
              generating={headerGenerating}
              pendingTitle={pendingImageTitle}
              editNonce={titleEditNonce}
              onSave={nodeProjectId && projectArrows && canInlineEditNodeHeader(p.node, projectArrows, headerParts)
                ? title => saveNodeHeader(nodeProjectId, p.node.id, v.createdAt, title) : undefined}
              centerControl={emptyMedia ? (
                <MediaModeToggle
                  mode={mediaChooserMode}
                  onChange={setMediaChooserMode}
                  generationAvailable={p.imageGenerationAvailable ?? true}
                />
              ) : undefined}
            />}
          </div>
          {standaloneInteractive ? <InteractiveNodeBody node={p.node} active={p.selected && !p.multiSelected}/> : ct === 'chat' ? <ChatBody node={p.node} selected={p.selected} style={bodyStyle} /> : ct === 'answer'
            ? <AnswerBody node={p.node} selected={p.selected} style={bodyStyle} /> : <NodeBody
            body={v.body}
            readingFamily={readingFamily}
            parentNodeId={p.node.id}
            selected={p.selected}
            error={p.node.generationError && (
              emptyText || v.initialTextFrame || isImageGenerationErrorVersion(p.node.id, p.node.currentVersionIndex)
              || (ct === 'interactive' && !v.interactive)
            )
              ? p.node.generationError
              : undefined}
            onRetry={p.onRetry}
            retryDisabled={p.retryDisabled}
            onReferenceClick={p.onReferenceClick}
            bodyStyle={bodyStyle}
            onFreeTextH={onFreeTextH}
            premeasureExpanded={premeasureExpand}
            deferExpandedMeasurements={deferExpandedMeasurements}
            mediaChooserMode={mediaChooserMode}
          />}
          {ct === 'media' && licensedMedia && (
            <div className="wikimedia-node-credit">
              <a href={licensedMedia.landingPageUrl} target="_blank" rel="noopener noreferrer">
                {licensedMedia.creditLine}
              </a>
              {' · '}
              {licensedMedia.licenseUrl ? (
                <a href={licensedMedia.licenseUrl} target="_blank" rel="noopener noreferrer">
                  {licensedMedia.license}
                </a>
              ) : licensedMedia.license}
              {licensedMedia.modified ? ' · modified' : ''}
            </div>
          )}
          <div className="node-footer">
            {p.node.chat && <ChatContextUsage node={p.node} />}
            <span className="node-tag">{nodeTypeLabel(p.node, isRoot)}</span>
            {!p.node.chat && <span className="node-tag node-language-tag" data-tip={languageInfo(v?.language).name}>{languageLabel(v?.language)}</span>}
            {ct === 'media' && v.media && v.imageGeneration && (
              <span
                className="node-tag node-tag--ai-generated"
                data-tip="This image was created with an AI image model"
              >
                AI generated
              </span>
            )}
            {ct !== 'chat' && v.factCheck?.complete && (
              <span
                className="node-tag node-tag--fact-checked"
                data-tip="This version has a completed evidence review"
              >
                Fact-checked
              </span>
            )}
            {v.sourceLimitation?.kind === 'limited-search' && (
              <span
                className="node-tag node-tag--locked"
                data-tip={v.sourceLimitation.reason ?? 'Semantic search was unavailable; Scatter used local keyword search.'}
              >
                Limited source search
              </span>
            )}
            {/* Chevron toggle — hides the bullets section, leaving only
                the first paragraph visible. Centered absolutely so the
                tag stays in normal flex flow on the left. */}
            {ct === 'chat' && <ChatJumpToLatest nodeId={p.node.id} />}
            {ct === 'encyclopedic' && <button
              type="button"
              className="bullets-toggle-btn"
              disabled={!hasBullets}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (!hasBullets) return;
                if (bulletsCollapsed) {
                  fitAfterBulletRevealRef.current = true;
                  if (expandedMeasurementsFresh) {
                    startHeightReportSuppression();
                    startDeferredExpandedMeasurements();
                    useGraphStore.getState().updateNode(p.node.id, {
                      bulletsCollapsed: false,
                    });
                  } else {
                    setPremeasureExpand(true);
                  }
                  return;
                }
                fitAfterBulletRevealRef.current = false;
                setPremeasureExpand(false);
                setDeferExpandedMeasurements(false);
                startHeightReportSuppression();
                useGraphStore.getState().updateNode(p.node.id, {
                  bulletsCollapsed: true,
                });
              }}
              data-tip={
                !hasBullets
                  ? 'No bullets to show'
                  : bulletsCollapsed ? 'Expand node' : 'Collapse node'
              }
              aria-label={bulletsCollapsed ? 'Expand node' : 'Collapse node'}
              aria-expanded={!effectivelyCollapsed}
            >
              {effectivelyCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </button>}
            {standaloneInteractive && <button type="button" className="node-corner-btn node-interactive-open-btn"
              disabled={!v.interactive?.html || !!p.node.generating} aria-label="Open interactive in a window" data-tip="Open interactive in a window"
              onPointerDown={event=>event.stopPropagation()}
              onClick={event=>{event.stopPropagation();useInteractiveViewerStore.getState().openViewer(p.node.id,p.node.currentVersionIndex);}}><Maximize size={18}/></button>}
          </div>

          {/* Pin toggle in the top-RIGHT. Always visible. Pins the node in
              place against physics. While armed by a drag-away gesture it shows
              the pinned glyph; only that glyph shakes and grows with distance. */}
          <button
            ref={pinButtonRef}
            type="button"
            className={'node-corner-btn right' + (p.node.frozen ? ' pinned' : '') + (arming ? ' arming' : '')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              useGraphStore.getState().updateNode(p.node.id, { frozen: !p.node.frozen });
            }}
            data-tip={p.node.frozen ? 'Unpin (let physics move)' : 'Pin in place'}
            aria-label={p.node.frozen ? 'Unpin node' : 'Pin node'}
          >
            {p.node.frozen || arming ? <Pin size={18} /> : <PinOff size={18} />}
          </button>
      </div>
      {/* Outside the hidden detail surface so overview cards keep a usable
          fit control. Focus/navigation only: leave undo history untouched. */}
      {ct === 'media' && isStillImageMedia(v.media) && <ImageAtlasOverlay nodeId={p.node.id} chromeOnly />}
      <button
        type="button"
        className="node-corner-btn right node-fit-btn"
        style={{ '--node-overview-control-scale': overviewInitiallyActive
          ? 1 / Math.max(overviewInitialZoom, 0.01) : 1 } as React.CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          useGraphStore.getState().requestFitNode(p.node.id);
        }}
        data-tip="Fit node to screen"
        aria-label="Fit node to screen"
      ><Maximize2 size={18} /></button>
          {/* Outside the paint-contained detail surface: corner arcs extend
              beyond the card and must remain visible and hit-testable.
              Chats keep a fixed reading viewport, so resizing is safe even
              while the first answer is still generating. */}
          {!emptyText && (!p.node.generating || ct === 'chat') && !(ct === 'media' && !v.media) && (['tl', 'tr', 'bl', 'br'] as const).map((mode) => (
            <div
              key={mode}
              className={'node-resize ' + mode + (resizingMode === mode ? ' resizing' : '')}
              onPointerDown={onResizePointerDown(mode)}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerUp}
              onPointerCancel={onResizePointerUp}
              data-tip="Drag to resize the node"
            />
          ))}

      {p.selected && !p.multiSelected && (ct !== 'media' || isStillImageMedia(v.media)) && (
        ct === 'media' ? <ImageNodeFollowUpBar nodeId={p.node.id} />
          : ct === 'chat' ? <ChatComposer nodeId={p.node.id} /> : <NodeFollowUpBar nodeId={p.node.id} />
      )}
    </div>
  );
}

/**
 * PERF R3: memoized so a Canvas re-render (which currently fires on
 * every physics tick — see Canvas onTick + setNodePositions) only
 * re-renders the NodeViews whose `node` reference actually changed.
 * `setNodePositions` preserves references for nodes that didn't move,
 * so during a typical drag only the dragged node's NodeView re-renders.
 *
 * The custom compare ignores callback props deliberately: every
 * callback in Canvas's per-node `.map(...)` is an inline closure and
 * thus a fresh reference on every render. The CALLBACKS' behavior is
 * still correct after the memo bails out because:
 *   - they close over `n` (the node), which is the same reference as
 *     before when this compare returns true,
 *   - they read viewport state via a ref in Canvas (vRef), so they
 *     don't capture a stale `v` in the closure.
 *
 * The compare deliberately covers ONLY the data props (node, selected).
 * Camera zoom is read live inside handlers, so changing the camera should not
 * make every NodeView commit. If any future prop is added that genuinely
 * affects render output, it must be added here too.
 */
export const NodeView = memo(NodeViewImpl, (prev, next) => {
  return (
    prev.node === next.node
    && prev.selected === next.selected
    && prev.multiSelected === next.multiSelected
  );
});
