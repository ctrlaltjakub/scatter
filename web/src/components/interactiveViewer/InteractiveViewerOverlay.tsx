'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { SquareArrowRight, Play, Check } from 'lucide-react';
import { acceptInteractiveDraft } from '@/lib/interactiveActions';
import { InteractiveNodeBody } from '@/components/node/InteractiveNodeBody';
import { useInteractiveRuntimeStore } from '@/store/useInteractiveRuntimeStore';
import { useInteractiveViewerStore } from '@/store/useInteractiveViewerStore';
import { useGraphStore } from '@/store/useGraphStore';
import { currentContentType } from '@/lib/nodeContentType';
import { colorToCss } from '@/lib/groupColor';
import { interactiveDisplaySize, preferredInteractiveViewport } from '@/lib/interactiveDocument';
import { exitReading } from '@/lib/readingController';

function groupVars(color: string): CSSProperties {
  return {
    '--tint-1': `color-mix(in oklab, ${color} 5%, transparent)`,
    '--tint-2': `color-mix(in oklab, ${color} 10%, transparent)`,
    '--tint-3': `color-mix(in oklab, ${color} 22%, transparent)`,
    '--tint-4': `color-mix(in oklab, ${color} 30%, transparent)`,
    '--control-accent': color,
    '--node-accent': color,
    '--sel-bg': `color-mix(in oklab, ${color} 40%, transparent)`,
  } as CSSProperties;
}

function useProgramScale(
  stageRef: RefObject<HTMLDivElement | null>,
  cardRef: RefObject<HTMLElement | null>,
  toolbarRef: RefObject<HTMLDivElement | null>,
  width: number,
  height: number,
): number {
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const card = cardRef.current;
    const toolbar = toolbarRef.current;
    if (!stage || !card || !toolbar) return;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const stageStyle = getComputedStyle(stage);
      const cardStyle = getComputedStyle(card);
      const px = (value: string) => Number.parseFloat(value) || 0;
      const availableWidth = rect.width - px(stageStyle.paddingLeft) - px(stageStyle.paddingRight)
        - px(cardStyle.paddingLeft) - px(cardStyle.paddingRight);
      const availableHeight = rect.height - px(stageStyle.paddingTop) - px(stageStyle.paddingBottom)
        - px(cardStyle.paddingTop) - px(cardStyle.paddingBottom)
        - toolbar.getBoundingClientRect().height - px(cardStyle.rowGap);
      // Fit the card around the scaled program, including wrapped titles.
      setScale(Math.max(0.01, Math.min(
        availableWidth / width,
        availableHeight / height,
      )));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(update);
    observer?.observe(stage);
    observer?.observe(toolbar);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [stageRef, cardRef, toolbarRef, width, height]);

  return scale;
}

function InteractiveViewerWindow({
  nodeId,
}: {
  nodeId: string;
}) {
  const project = useGraphStore((state) => state.project);
  const close = useInteractiveViewerStore((state) => state.close);
  const node = project?.nodes[nodeId];
  const version = node?.versions[node.currentVersionIndex];
  const previewingDraft = useInteractiveViewerStore(state => !version?.interactive && state.nodeId === nodeId && state.draftCreatedAt === version?.createdAt);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const preferred = preferredInteractiveViewport(version?.interactiveBuild?.draftHtml ?? '');
  const dimensions = interactiveDisplaySize(version?.interactive ?? (previewingDraft ? {
    viewportWidth: version?.interactiveBuild?.viewportWidth ?? preferred.width,
    viewportHeight: version?.interactiveBuild?.viewportHeight ?? preferred.height,
  } : undefined), true);
  const programScale = useProgramScale(stageRef, cardRef, toolbarRef, dimensions.width, dimensions.height);

  const accent = node && project
    ? (node.groupId ? project.groups[node.groupId]?.color : undefined) ?? project.color
    : undefined;
  const accentCss = accent ? colorToCss(accent) : undefined;
  const style = accentCss ? groupVars(accentCss) : undefined;

  const dismiss = useCallback(() => {
    exitReading();
    close();
  }, [close]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dismiss]);

  useEffect(() => () => { exitReading(); }, []);

  useEffect(() => {
    if (!node || !version || currentContentType(node) !== 'interactive') close();
  }, [close, node, version]);

  if (!node || !version || currentContentType(node) !== 'interactive') return null;

  return (
    <>
      <div className="text-editor-backdrop interactive-viewer-backdrop" />
      <div
        ref={stageRef}
        className="interactive-viewer-stage"
        style={style}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) dismiss();
        }}
      >
        <article
          ref={cardRef}
          className="interactive-viewer-card"
          style={{ '--interactive-viewer-scale': programScale, '--interactive-viewer-width': `${dimensions.width}px`,
            '--interactive-viewer-height': `${dimensions.height}px` } as CSSProperties}
          role="dialog"
          aria-modal="true"
          aria-label={`Interactive: ${version.header}`}
          data-node-id={nodeId}
          data-sc-reading-node-id={nodeId}
          data-sc-reading-scale="1"
        >
          <div ref={toolbarRef} className="interactive-viewer-toolbar">
            <h2 className="interactive-viewer-app-title">{version.header}</h2>
            {!!version.interactiveBuild?.warnings?.length && <details className="interactive-viewer-notes">
              <summary data-tip="Non-blocking observations from the visual review">Review notes ({version.interactiveBuild.warnings.length})</summary>
              <ul>{version.interactiveBuild.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            </details>}
            {previewingDraft && <button type="button" className="text-editor-exit interactive-viewer-accept" disabled={!!node.generating}
              data-tip="Keep this version without further AI review or token use; can be undone"
              onClick={() => acceptInteractiveDraft(nodeId, version.createdAt)}><Check size={15} />Accept this version</button>}
            <button type="button" className="text-editor-exit interactive-viewer-exit" disabled={(!version.interactive && !previewingDraft) || !!node.generating}
              data-tip="Reset the program without regenerating it or using AI credits"
              onClick={()=>useInteractiveRuntimeStore.getState().restart(nodeId)}><Play size={15}/>Restart</button>
            <button
              type="button"
              className="text-editor-exit interactive-viewer-exit"
              onClick={dismiss}
              data-tip="Exit (Esc)"
            >
              <SquareArrowRight size={15} /> Exit
            </button>
          </div>

          <section className="interactive-viewer-program-host" aria-label="Interactive program">
            <div className="interactive-viewer-program-fit">
              <div
                className="interactive-viewer-program-canvas"
                style={{ transform: `scale(${programScale})` }}
              >
                <InteractiveNodeBody node={node} active presentation="viewer"/>
              </div>
            </div>
          </section>
        </article>
      </div>
    </>
  );
}

export default function InteractiveViewerOverlay() {
  const open = useInteractiveViewerStore((state) => state.open);
  const nodeId = useInteractiveViewerStore((state) => state.nodeId);
  const versionIndex = useInteractiveViewerStore((state) => state.versionIndex);
  if (!open || !nodeId || versionIndex == null) return null;
  return (
    <InteractiveViewerWindow
      key={`${nodeId}-${versionIndex}`}
      nodeId={nodeId}
    />
  );
}
