'use client';
import { useReadingTypography } from '@/hooks/useReadingTypography';
import { languageInfo, languageDirection } from '@/lib/languages';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { MousePointerClick } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useReadingStore } from '@/store/useReadingStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useDisplayBody } from '@/store/useRewriteStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { termPreviewFor } from '@/lib/termPreviewCore';
import { termPreviewProcess } from '@/lib/termPreviews';
import { termLabel } from '@/lib/termLabel';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { currentSidebarInsetPx } from '@/lib/nodeVisibility';
import {
  fitRelationPreview,
  openingParagraphPreview,
  previewTailParts,
  previewFormattedParts,
  type FittedRelationPreview,
} from '@/lib/relationPreview';

const SHOW_DELAY_MS = 120;
const HIDE_GRACE_MS = 80;
const PREVIEW_GAP_CANVAS_PX = 6;
const PREVIEW_LINE_LIMIT = 3;
// Chromium adds a little line-box rounding because the inline icon participates
// in the final line. Three pixels admits a real third line (~59px for 18.9px
// line-height) while staying far below line 4 (~77px).
const LINE_MEASURE_TOLERANCE_PX = 3;
const PREVIEW_ID = 'scatter-relation-hover-preview';
const RELATION_SELECTOR = '[data-reference-term], [data-relation-child-id], [data-relation-arrow-id]';

interface RectSnapshot {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface RelationTarget {
  key: string;
  childId?: string;
  parentId?: string;
  term?: string;
  versionCreatedAt?: number;
  element: HTMLElement;
  pointer: { x: number; y: number } | null;
  anchor: RectSnapshot;
}

function snapshotRect(rect: DOMRect): RectSnapshot {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function rectDistance(rect: DOMRect, point: { x: number; y: number }): number {
  const dx = point.x < rect.left
    ? rect.left - point.x
    : point.x > rect.right ? point.x - rect.right : 0;
  const dy = point.y < rect.top
    ? rect.top - point.y
    : point.y > rect.bottom ? point.y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function anchorFor(
  element: HTMLElement,
  pointer: { x: number; y: number } | null,
): RectSnapshot {
  const rects = [...element.getClientRects()];
  if (pointer && rects.length > 1) {
    rects.sort((a, b) => rectDistance(a, pointer) - rectDistance(b, pointer));
  }
  return snapshotRect(rects[0] ?? element.getBoundingClientRect());
}

function relationElement(
  target: EventTarget | null,
  container: HTMLElement,
): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // A citation inside a whole-title term has its own source-domain preview.
  if (target.closest('.cite-marker')) return null;
  const element = target.closest<HTMLElement>(RELATION_SELECTOR);
  return element && container.contains(element) ? element : null;
}

function resolveTarget(
  element: HTMLElement,
  pointer: { x: number; y: number } | null,
): RelationTarget | null {
  // Expansion belongs to the bullet, not the focused node. Fully expanded
  // bullets and opening prose remain hoverable even in unfocused cards.
  if (element.closest('.zoom-disabled, .sc-ab-measure, [aria-hidden="true"], .sc-ab-item[aria-expanded="false"], .sc-collapsible-li:not(.is-pinned)')) return null;
  const directChildId = element.dataset.relationChildId;
  const arrowId = element.dataset.relationArrowId;
  const project = useGraphStore.getState().project;
  const childId = directChildId || (arrowId ? project?.arrows[arrowId]?.toNodeId : undefined);
  const parentId = element.dataset.referenceParentId;
  const term = element.dataset.referenceTerm;
  const versionCreatedAt = Number(element.closest<HTMLElement>('[data-preview-version]')?.dataset.previewVersion) || undefined;
  if ((!childId || !project?.nodes[childId]) && (!parentId || !term || !project?.nodes[parentId])) return null;
  return {
    key: parentId && term ? `term:${parentId}:${versionCreatedAt ?? ''}:${term}` : directChildId ? `child:${childId}` : `arrow:${arrowId}`,
    childId,
    parentId, term, versionCreatedAt,
    element,
    pointer,
    anchor: anchorFor(element, pointer),
  };
}

function writeMeasure(element: HTMLElement, candidate: string, markdown: string) {
  const parts = previewTailParts(candidate);
  const append = (parent: HTMLElement, from: number, to: number) => {
    for (const part of previewFormattedParts(markdown, from, to)) {
      const span = document.createElement(part.bold ? 'strong' : part.italic ? 'em' : 'span');
      span.textContent = part.text;
      parent.append(span);
    }
  };
  element.replaceChildren();
  append(element, 0, parts.head.length);
  const tail = document.createElement('span');
  tail.className = 'relation-hover-preview-tail';
  append(tail, parts.head.length, candidate.length);
  const icon = document.createElement('span');
  icon.className = 'relation-hover-preview-icon-measure';
  tail.append(icon);
  element.append(tail);
}

function PreviewText({ markdown, from = 0, to = Infinity }: { markdown: string; from?: number; to?: number }) {
  return <>{previewFormattedParts(markdown, from, to).map((part, index) => {
    const text = part.italic ? <em>{part.text}</em> : part.text;
    return part.bold ? <strong key={index}>{text}</strong> : <span key={index}>{text}</span>;
  })}</>;
}

function PreviewCopy({
  text,
  compact = false,
  full = false,
}: {
  text: string;
  compact?: boolean;
  full?: boolean;
}) {
  const plain = useMemo(() => termLabel(text).text, [text]);
  const contentRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fitted, setFitted] = useState<FittedRelationPreview | null>(null);

  useLayoutEffect(() => {
    if (compact || full) {
      setFitted({ text: plain, leading: plain, faded: '', truncated: false });
      return;
    }
    const content = contentRef.current;
    const measure = measureRef.current;
    if (!content || !measure) return;

    const fit = () => {
      const width = content.clientWidth;
      if (width <= 0) return;
      measure.style.width = `${width}px`;
      const lineHeight = Number.parseFloat(getComputedStyle(content).lineHeight) || 18.9;
      const next = fitRelationPreview(plain, (candidate) => {
        writeMeasure(measure, candidate, text);
        return measure.scrollHeight <= lineHeight * PREVIEW_LINE_LIMIT + LINE_MEASURE_TOLERANCE_PX
          && measure.scrollWidth <= width + 0.75;
      });
      setFitted((previous) => (
        previous?.text === next.text ? previous : next
      ));
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [compact, full, plain, text]);

  const shown = fitted?.text || plain;
  const parts = previewTailParts(shown);
  return (
    <>
      <div
        ref={contentRef}
        className="relation-hover-preview-copy"
        style={{ visibility: fitted ? 'visible' : 'hidden' }}
        aria-hidden="true"
      >
        {compact ? (
          <span className="relation-hover-preview-tail">
            {shown}
            <MousePointerClick size={15} strokeWidth={1.8} aria-hidden="true" />
          </span>
        ) : (
          <>
            <PreviewText markdown={text} to={parts.head.length} />
            <span className="relation-hover-preview-tail">
              <PreviewText markdown={text} from={parts.head.length} to={shown.length - parts.faded.length} />
              <span className={full ? undefined : 'relation-hover-preview-fade'}>
                <PreviewText markdown={text} from={shown.length - parts.faded.length} to={shown.length} />
              </span>
              <MousePointerClick size={15} strokeWidth={1.8} aria-hidden="true" />
            </span>
          </>
        )}
      </div>
      {!compact && !full && (
        <div
          ref={measureRef}
          className="relation-hover-preview-copy relation-hover-preview-measure"
          aria-hidden="true"
        />
      )}
    </>
  );
}

function RelationPreviewCard({ target }: { target: RelationTarget }) {
  const autoPreviews = useSettingsStore(state => state.autoTermPreviews);
  const zoom = useLiveViewportStore((viewport) => viewport.zoom);
  const scale = target.element.closest('[data-sc-reading-node-id]') ? 1 : zoom;
  const linkedChildId = useGraphStore((state) => (target.childId && state.project?.nodes[target.childId] ? target.childId : undefined) || (target.parentId && target.term
    ? Object.values(state.project?.arrows ?? {}).find(arrow => arrow.fromNodeId === target.parentId
      && arrow.label === target.term && (!target.versionCreatedAt || arrow.sourceAnswer?.versionCreatedAt === target.versionCreatedAt))?.toNodeId
    : undefined));
  const node = useGraphStore((state) => linkedChildId ? state.project?.nodes[linkedChildId] : undefined);
  const parent = useGraphStore((state) => target.parentId ? state.project?.nodes[target.parentId] : undefined);
  const parentVersion = target.versionCreatedAt
    ? parent?.versions.find(version => version.createdAt === target.versionCreatedAt)
    : parent?.versions[parent.currentVersionIndex];
  const explaining = useNodeStatusStore((state) => !!target.parentId && !!parentVersion
    && state.processes[target.parentId]?.[termPreviewProcess(parentVersion.createdAt)]?.clearedAt === null);
  const versionIndex = node?.currentVersionIndex ?? 0;
  const version = node?.versions[versionIndex];
  const displayBody = useDisplayBody(linkedChildId ?? '', versionIndex, version?.body ?? '');
  const opening = openingParagraphPreview(displayBody, true);
  const explanation = autoPreviews && !node && target.term ? termPreviewFor(parentVersion, target.term) : undefined;
  const compact = node ? !!node.generating && !opening : autoPreviews && !explanation && explaining;
  const full = !node && !!explanation;
  const text = node ? opening || (compact ? 'Generating' : version?.header?.trim() || '')
    : explanation || (compact ? 'Generating' : '');
  const language = (node ? version : parentVersion)?.language;
  const typography = useReadingTypography(language, text);
  const plain = termLabel(text).text;
  const accessibleText = /[.!?]$/u.test(plain) ? plain : `${plain}.`;
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const place = () => {
      const safeScale = Math.max(0.01, scale);
      const width = card.offsetWidth * safeScale;
      const height = card.offsetHeight * safeScale;
      if (width <= 0 || height <= 0) return;
      const screenMargin = 8;
      const gap = PREVIEW_GAP_CANVAS_PX * safeScale;
      const minLeft = currentSidebarInsetPx() + screenMargin;
      const maxLeft = Math.max(minLeft, window.innerWidth - width - screenMargin);
      const centered = target.anchor.left + target.anchor.width / 2 - width / 2;
      const left = Math.max(minLeft, Math.min(maxLeft, centered));
      const below = target.anchor.bottom + gap;
      const above = target.anchor.top - height - gap;
      // Relation previews belong above their source text. Only flip below when
      // the upper viewport edge genuinely cannot contain the complete card.
      const top = above >= screenMargin
        ? above
        : Math.min(window.innerHeight - height - screenMargin, below);
      setPosition((previous) => (
        previous?.left === left && previous.top === top ? previous : { left, top }
      ));
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(card);
    void document.fonts?.ready.then(place);
    return () => observer.disconnect();
  }, [target.anchor, scale, text]);

  if (!text) return null;
  return (
    <div
      ref={cardRef}
      id={PREVIEW_ID}
      className={`relation-hover-preview${compact ? ' is-compact' : ''}${full ? ' is-explanation' : ''}`}
      role="tooltip"
      lang={languageInfo(language).locale} dir={languageDirection(language)}
      aria-label={`${accessibleText} Click the highlighted text to ${node ? 'open this node' : 'explore this term'}.`}
      style={{
        ...typography,
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
        transform: `scale(${scale})`,
      }}
    >
      <PreviewCopy text={text} compact={compact} full={full} />
    </div>
  );
}

/** One delegated hover surface for terms/relations in all canvas nodes.
 * Hover and ruler state are transient navigation, never undoable content. */
export function RelationHoverPreview({
  containerRef,
  screenSized = false,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  screenSized?: boolean;
}) {
  const overview = useLiveViewportStore(
    (viewport) => viewport.zoom < GROUP_LABEL_ZOOM_THRESHOLD,
  );
  const disabled = !screenSized && overview;
  const [target, setTarget] = useState<RelationTarget | null>(null);
  const targetRef = useRef<RelationTarget | null>(null);
  const pendingTargetRef = useRef<RelationTarget | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  const clearTimer = (ref: typeof showTimerRef) => {
    if (ref.current !== null) window.clearTimeout(ref.current);
    ref.current = null;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container || disabled) {
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
      targetRef.current = null;
      pendingTargetRef.current = null;
      setTarget(null);
      return;
    }

    const clearHide = () => clearTimer(hideTimerRef);
    const hide = () => {
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
      targetRef.current = null;
      pendingTargetRef.current = null;
      setTarget(null);
    };
    const scheduleHide = () => {
      clearTimer(hideTimerRef);
      hideTimerRef.current = window.setTimeout(() => { hide(); showReading(); }, HIDE_GRACE_MS);
    };
    const show = (
      element: HTMLElement,
      pointer: { x: number; y: number } | null,
      immediate: boolean,
    ) => {
      clearHide();
      const next = resolveTarget(element, pointer);
      if (!next) {
        hide();
        return;
      }
      if (targetRef.current?.key === next.key) {
        targetRef.current = next;
        setTarget(next);
        return;
      }
      if (!immediate && pendingTargetRef.current?.key === next.key) {
        pendingTargetRef.current = next;
        return;
      }
      clearTimer(showTimerRef);
      pendingTargetRef.current = next;
      const commit = () => {
        showTimerRef.current = null;
        const pending = pendingTargetRef.current;
        pendingTargetRef.current = null;
        if (!pending?.element.isConnected) return;
        const resolved = resolveTarget(pending.element, pending.pointer);
        if (!resolved) return;
        targetRef.current = resolved;
        setTarget(resolved);
      };
      if (immediate) commit();
      else showTimerRef.current = window.setTimeout(commit, SHOW_DELAY_MS);
    };

    const showReading = () => {
      // Pointer hover takes priority, including while the ruler is in line mode.
      if (targetRef.current?.pointer || pendingTargetRef.current?.pointer) return;
      const reading = useReadingStore.getState();
      const reference = reading.clusterIdx !== null ? reading.activeReference : null;
      if (reference?.kind === 'term' && container.contains(reference.element)) show(reference.element, null, true);
      else hide();
    };

    const onPointerOver = (event: PointerEvent) => {
      const element = relationElement(event.target, container);
      if (!element) return;
      show(element, { x: event.clientX, y: event.clientY }, false);
    };
    const onPointerOut = (event: PointerEvent) => {
      const from = relationElement(event.target, container);
      if (!from) return;
      const to = relationElement(event.relatedTarget, container);
      const fromTarget = resolveTarget(from, null);
      const toTarget = to ? resolveTarget(to, null) : null;
      if (fromTarget?.key === toTarget?.key) return;
      scheduleHide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const element = relationElement(event.target, container);
      if (element) show(element, null, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const to = relationElement(event.relatedTarget, container);
      const current = targetRef.current;
      if (to && resolveTarget(to, null)?.key === current?.key) return;
      scheduleHide();
    };
    const onScroll = (event: Event) => {
      const current = targetRef.current ?? pendingTargetRef.current;
      if (!current?.pointer || !(event.target instanceof Element) || !event.target.contains(current.element)) return;
      // The portal lives outside the scroll clip. Dismiss a mouse preview in
      // the same frame instead of following an off-screen term onto the canvas.
      flushSync(hide);
    };

    container.addEventListener('pointerover', onPointerOver);
    container.addEventListener('pointerout', onPointerOut);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    container.addEventListener('scroll', onScroll, true);
    const unsubscribeReading = useReadingStore.subscribe(showReading);
    showReading();
    return () => {
      unsubscribeReading();
      container.removeEventListener('pointerover', onPointerOver);
      container.removeEventListener('pointerout', onPointerOut);
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
      container.removeEventListener('scroll', onScroll, true);
      clearTimer(showTimerRef);
      clearTimer(hideTimerRef);
      pendingTargetRef.current = null;
    };
  }, [containerRef, disabled]);

  useEffect(() => {
    if (!target) return;
    const reposition = () => {
      const current = targetRef.current;
      const next = current?.element.isConnected ? resolveTarget(current.element, current.pointer) : null;
      if (!next) {
        targetRef.current = null;
        setTarget(null);
        return;
      }
      targetRef.current = next;
      setTarget(next);
    };
    // A bullet can collapse while the pointer stays still (keyboard navigation,
    // resizing, or the adaptive layout). Observe only this target's ancestors.
    const observer = new MutationObserver(reposition);
    for (let element: HTMLElement | null = target.element; element && element !== containerRef.current; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ['aria-expanded', 'aria-hidden', 'class'] });
    }
    const unsubscribe = useLiveViewportStore.subscribe(reposition);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      unsubscribe();
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
    };
  }, [target?.key, target?.element, containerRef]);

  const visibleTarget = disabled ? null : target;

  useEffect(() => {
    const element = visibleTarget?.element;
    if (!element) return;
    const previous = element.getAttribute('aria-describedby');
    const values = new Set((previous ?? '').split(/\s+/).filter(Boolean));
    values.add(PREVIEW_ID);
    element.setAttribute('aria-describedby', [...values].join(' '));
    return () => {
      if (previous) element.setAttribute('aria-describedby', previous);
      else element.removeAttribute('aria-describedby');
    };
  }, [visibleTarget?.element]);

  if (
    !visibleTarget
    || typeof document === 'undefined'
  ) return null;
  return createPortal(<RelationPreviewCard target={visibleTarget} />, document.body);
}
