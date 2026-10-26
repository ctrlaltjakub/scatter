'use client';

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RotateCcw, SquareMousePointer, TriangleAlert } from 'lucide-react';
import {
  buildInteractiveSrcDoc,
  resolveInteractiveViewport,
  interactiveDisplaySize,
  type InteractiveHostState,
  type InteractiveRuntimeError,
} from '@/lib/interactiveDocument';
import type { InteractiveExplanation } from '@/store/types';
import { GenerationMediaSkeleton } from '@/components/GenerationMediaSkeleton';
import { THEME_CHANGE_EVENT } from '@/lib/theme';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { useInteractiveRuntimeStore } from '@/store/useInteractiveRuntimeStore';
import { readInteractiveTheme } from '@/lib/interactiveTheme';
import { buildInteractiveNode } from '@/lib/interactiveActions';
import { configuredPrompt } from '@/lib/configuredPrompt';

interface Props {
  nodeId: string;
  versionIndex: number;
  interactive?: InteractiveExplanation;
  active: boolean;
  generating: boolean;
  accent?: string | null;
  presentation?: 'viewer' | 'canvas';
  canvasWidth?: number;
  unverifiedDraft?: boolean;
}

interface ArmedFrame {
  html: string;
  initialState: InteractiveHostState;
}


/** The sandbox remains painted while visible but its host-injected scheduler
 * pauses recurring work, sound, and interaction whenever focus leaves. */
export function InteractiveExplanationView({
  nodeId,
  versionIndex,
  interactive,
  active,
  generating,
  accent,
  presentation = 'canvas',
  canvasWidth,
  unverifiedDraft = false,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const reactId = useId();
  const channel = useMemo(
    () => `scatter-interactive-${nodeId}-${reactId.replace(/:/g, '')}`,
    [nodeId, reactId],
  );
  const [pageActive, setPageActive] = useState(() => (
    typeof document === 'undefined' || (document.visibilityState !== 'hidden' && document.hasFocus())
  ));
  const [inViewport, setInViewport] = useState(() => (
    typeof IntersectionObserver === 'undefined'
  ));
  const [themeRevision, setThemeRevision] = useState(0);
  const [ready, setReady] = useState(false);
  const [frame, setFrame] = useState<ArmedFrame | null>(null);
  const [runtimeError, setRuntimeError] = useState<InteractiveRuntimeError | null>(null);
  const viewerNodeId = useInteractiveViewerStore((state) => state.nodeId);
  const closeViewer = useInteractiveViewerStore((state) => state.close);
  const isViewer = presentation === 'viewer';
  const isCanvas = presentation === 'canvas';
  const overview = useLiveViewportStore(state => state.zoom < GROUP_LABEL_ZOOM_THRESHOLD);
  const restartRevision = useInteractiveRuntimeStore(state => state.revisions[nodeId] ?? 0);
  const hostTheme = useMemo(() => readInteractiveTheme(accent), [accent, themeRevision]);
  const hostState = useMemo<InteractiveHostState>(() => ({
    active: active && pageActive && (isViewer || (isCanvas && !overview && inViewport && !viewerNodeId)),
    theme: hostTheme,
  }), [active, hostTheme, isViewer, isCanvas, pageActive, overview, inViewport, viewerNodeId]);
  const sourceViewport = useMemo(
    () => resolveInteractiveViewport(interactive),
    [interactive?.viewportHeight, interactive?.viewportSize, interactive?.viewportWidth],
  );
  const { width: targetWidth, height: targetHeight } = interactiveDisplaySize(interactive, isViewer, canvasWidth);
  const viewportScale = Math.min(
    targetWidth / sourceViewport.width,
    targetHeight / sourceViewport.height,
  );
  const iframeStyle = useMemo<CSSProperties>(() => ({
    width: `${sourceViewport.width}px`,
    height: `${sourceViewport.height}px`,
    left: '50%',
    top: '50%',
    transform: `translate(-50%, -50%) scale(${viewportScale})`,
  }), [sourceViewport.height, sourceViewport.width, viewportScale]);
  const shouldMount = (isViewer ? active : inViewport && viewerNodeId !== nodeId)
    && !!interactive?.html && (!interactive.error || unverifiedDraft) && !generating;
  const srcDoc = useMemo(
    () => frame
      ? buildInteractiveSrcDoc(frame.html, channel, frame.initialState, sourceViewport)
      : '',
    [channel, frame, sourceViewport, restartRevision],
  );

  useEffect(() => {
    let pendingFocusCheck: number | undefined;
    const cancelFocusCheck = () => {
      if (pendingFocusCheck !== undefined) window.clearTimeout(pendingFocusCheck);
      pendingFocusCheck = undefined;
    };
    const synchronize = () => {
      cancelFocusCheck();
      setPageActive(document.visibilityState !== 'hidden' && document.hasFocus());
    };
    const onBlur = () => {
      cancelFocusCheck();
      // Gecko can briefly report no document focus while moving it into the
      // sandbox. Reading it inside blur disables the iframe before mouseup,
      // cancelling the click, with no parent focus event to resume it later.
      pendingFocusCheck = window.setTimeout(synchronize, 0);
    };
    document.addEventListener('visibilitychange', synchronize);
    window.addEventListener('focus', synchronize);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelFocusCheck();
      document.removeEventListener('visibilitychange', synchronize);
      window.removeEventListener('focus', synchronize);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const updateTheme = () => setThemeRevision((value) => value + 1);
    window.addEventListener(THEME_CHANGE_EVENT, updateTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, updateTheme);
  }, []);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      setInViewport(!!entry?.isIntersecting);
    }, { rootMargin: '120px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [interactive?.html, restartRevision]);

  useEffect(() => {
    setReady(false);
    setRuntimeError(null);
  }, [interactive?.html, restartRevision]);

  useEffect(() => {
    if (!shouldMount) {
      setFrame(null);
      setReady(false);
      return;
    }
    const html = interactive?.html;
    if (!html) return;
    setFrame((current) => current?.html === html ? current : { html, initialState: hostState });
  }, [hostState, interactive?.html, shouldMount]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = event.data as {
        __scatterInteractive?: string;
        type?: string;
        payload?: InteractiveRuntimeError;
      } | null;
      if (!message || message.__scatterInteractive !== channel) return;
      if (message.type === 'canvas-zoom') {
        // The expanded viewer has no canvas camera. Still cancel browser zoom
        // inside its frame, but never move the canvas behind the modal.
        if (!isCanvas || !iframeRef.current || !wrapperRef.current) return;
        const input = message.payload as unknown as Partial<WheelEvent> | null;
        if (!input || !(input.ctrlKey || input.metaKey)
          || ![input.clientX, input.clientY, input.deltaY].every(value => typeof value === 'number' && Number.isFinite(value))
          || ![0, 1, 2].includes(input.deltaMode as number)) return;
        const bounds = iframeRef.current.getBoundingClientRect();
        wrapperRef.current.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, ctrlKey: !!input.ctrlKey, metaKey: !!input.metaKey,
          deltaY: input.deltaY, deltaMode: input.deltaMode,
          clientX: bounds.left + Math.max(0, Math.min(sourceViewport.width, input.clientX!)) * bounds.width / sourceViewport.width,
          clientY: bounds.top + Math.max(0, Math.min(sourceViewport.height, input.clientY!)) * bounds.height / sourceViewport.height,
        }));
        return;
      }
      if (message.type === 'escape') {
        if (isViewer) closeViewer();
        return;
      }
      if (message.type === 'ready') {
        setReady(true);
        return;
      }
      if (message.type !== 'error' || !message.payload) return;
      const error = message.payload;
      setRuntimeError(error);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [channel, closeViewer, isViewer, isCanvas, sourceViewport]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({
      __scatterInteractive: channel,
      type: 'host-state',
      payload: hostState,
    }, '*');
  }, [channel, hostState, ready]);

  if (generating) return <GenerationMediaSkeleton kind="interactive" />;

  if (interactive?.error && !unverifiedDraft) {
    const canRepair = !!interactive.html;
    const repairError: InteractiveRuntimeError = { message: interactive.error };
    return (
      <div ref={wrapperRef} className={`sc-interactive-state sc-interactive-state--${presentation} sc-interactive-state--error`} role="alert">
        <TriangleAlert size={24} aria-hidden="true" />
        <p>{interactive.error}</p>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void buildInteractiveNode(nodeId, canRepair ? configuredPrompt('interactiveNodeRepair', { error: repairError.message }) : undefined, canRepair ? 'modify' : 'regenerate');
          }}
        >
          <RotateCcw size={15} aria-hidden="true" /> {canRepair ? 'Repair' : 'Retry'}
        </button>
      </div>
    );
  }

  if (!interactive?.html) {
    return (
      <div ref={wrapperRef} className={`sc-interactive-state sc-interactive-state--${presentation}`} aria-label="Interactive program unavailable">
        <span>Interactive program unavailable</span>
      </div>
    );
  }

  if (runtimeError && !unverifiedDraft) {
    return (
      <div ref={wrapperRef} className={`sc-interactive-state sc-interactive-state--${presentation} sc-interactive-state--error`} role="alert">
        <TriangleAlert size={24} aria-hidden="true" />
        <p>{runtimeError.message}</p>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void buildInteractiveNode(nodeId, unverifiedDraft ? runtimeError.message : configuredPrompt('interactiveNodeRepair', { error: runtimeError.message }), unverifiedDraft ? 'repair' : 'modify');
          }}
        >
          <RotateCcw size={15} aria-hidden="true" /> Repair
        </button>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={`sc-interactive-frame-wrap sc-interactive-frame-wrap--${presentation}${hostState.active ? '' : ' is-paused'}${!isViewer && !active ? ' is-unfocused' : ''}`}
      aria-label={`Interactive program${hostState.active ? '' : ' paused'}`}
      data-source-viewport={`${sourceViewport.width}x${sourceViewport.height}`}
      style={{ width: targetWidth, height: targetHeight, flexBasis: targetHeight }}
    >
      {shouldMount && (!frame || !ready) && <GenerationMediaSkeleton kind="interactive" />}
      {frame && (
        <iframe
          key={restartRevision}
          ref={iframeRef}
          className="sc-interactive-frame"
          style={iframeStyle}
          title="Interactive program"
          data-sc-capture-channel={channel}
          sandbox="allow-scripts"
          allow={isViewer ? 'autoplay' : undefined}
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={() => iframeRef.current?.contentWindow?.postMessage({
            __scatterInteractive: channel,
            type: 'host-state',
            payload: hostState,
          }, '*')}
          onPointerDown={(event) => event.stopPropagation()}
        />
      )}
      {!isViewer && frame && ready && !active && (
        <button
          type="button"
          className="sc-interactive-preview-open"
          aria-label="Focus interactive node"
          data-tip="Click to interact"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            useGraphStore.getState().setSelection([nodeId]);
          }}
        >
          <SquareMousePointer
            className="sc-interactive-preview-icon"
            size={56}
            strokeWidth={1.6}
            aria-hidden="true"
          />
          <span className="sc-interactive-activate-label">Click to interact</span>
        </button>
      )}
    </div>
  );
}
