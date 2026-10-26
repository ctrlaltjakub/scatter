'use client';

import {
  useEffect, useLayoutEffect, useRef, type RefObject,
} from 'react';
import { clearPreservedSelectionHighlight } from '@/lib/selectionHighlight';
import { exitReading } from '@/lib/readingController';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { OVERVIEW_SCREEN_FONT_PX } from '@/lib/overviewHeader';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { useGraphStore } from '@/store/useGraphStore';
import { nodeRenderedH, nodeWidth } from '@/lib/nodeSize';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';

const overviewBoundsByContainer = new WeakMap<HTMLElement, { width: number; height: number }>();

function overviewViewportSize(container: HTMLElement) {
  let bounds = overviewBoundsByContainer.get(container);
  if (!bounds) {
    bounds = { width: container.clientWidth, height: container.clientHeight };
    overviewBoundsByContainer.set(container, bounds);
  }
  return bounds;
}

export function overviewFontSizeForZoom(
  zoom: number,
): number {
  return OVERVIEW_SCREEN_FONT_PX / Math.max(zoom, 0.01);
}

export function overviewSkeletonMetricsForZoom(zoom: number): {
  gap: number;
  unit: number;
  controlClearance: number;
} {
  const safeZoom = Math.max(zoom, 0.01);
  // Keep the line weight, message rhythm, and button clearance in screen
  // pixels. Width/height remain CSS-driven, so resizing needs no DOM reads.
  // The surface has 12px padding; the fit control sits 6px from the card edge.
  return { gap: 7 / safeZoom, unit: 1 / safeZoom, controlClearance: 38 / safeZoom - 6 };
}

export function overviewTitleLayoutForZoom(zoom: number, height: number): {
  lines: number;
  reserve: number;
} {
  const safeZoom = Math.max(zoom, 0.01);
  const lineHeight = OVERVIEW_SCREEN_FONT_PX * 1.2;
  // Reserve the button's 32px screen-space hit area + a 2px breathing gap.
  // 18 canvas pixels account for title top padding and the button's inset.
  const availableAboveControl = (height - 18) * safeZoom - 34;
  if (availableAboveControl >= lineHeight) {
    return { lines: Math.max(1, Math.floor(availableAboveControl / lineHeight)), reserve: 0 };
  }
  // Very short cards cannot stack even one title line above the button.
  // Let the title use the left-hand column instead of painting underneath it.
  return {
    lines: Math.max(1, Math.floor((height - 24) * safeZoom / lineHeight)),
    reserve: overviewSkeletonMetricsForZoom(zoom).controlClearance,
  };
}

function clearReadableSurface() {
  exitReading();
  clearPreservedSelectionHighlight();
  useNodeTextSelectionStore.getState().clear();
  if (typeof window.getSelection === 'function') {
    window.getSelection()?.removeAllRanges();
  }
}

export function applyNodeOverviewMode(
  container: HTMLElement,
  overview: boolean,
  animate = false,
) {
  // Read once before changing presentation; later camera frames use the
  // ResizeObserver snapshot instead of forcing layout after transform writes.
  overviewViewportSize(container);
  // Preserve panel drafts/disclosures. This also covers panels first opened
  // while zoomed out; no graph mutation or undo entry belongs to zooming.
  // React owns className on the host/cards. Use independent attributes so
  // focus, hover and drag renders cannot erase the current zoom state.
  container.toggleAttribute('data-node-overview', overview);
  if (overview && document.activeElement instanceof HTMLElement
    && container.contains(document.activeElement)
    && document.activeElement.closest('.side-panel, .citations-panel, .node-followup-bar, .node-type-menu')) {
    document.activeElement.blur();
  }
  const nodes = container.querySelectorAll<HTMLElement>('.node-overview-eligible');
  const project = useGraphStore.getState().project;
  for (const node of nodes) {
    node.toggleAttribute('data-node-overview-active', overview);
    const detail = node.querySelector<HTMLElement>('.node-detail-surface');
    const title = node.querySelector<HTMLElement>('.node-overview-surface');
    if (detail) {
      const model = project?.nodes[node.dataset.nodeId ?? ''];
      if (model) {
        detail.style.setProperty('contain-intrinsic-width', `${nodeWidth(model)}px`);
        detail.style.setProperty('contain-intrinsic-height', `${nodeRenderedH(model)}px`);
      }
      detail.style.opacity = overview ? '0' : '1';
      detail.style.contentVisibility = node.hasAttribute('data-node-needs-measurement')
        ? 'visible' : overview ? 'hidden' : 'auto';
      // content-visibility hides the descendants and the overview surface
      // owns hit-testing above this box. Do not flip inherited pointer-events
      // here: that restyles every word/chip in the project at the threshold.
      if (detail.style.pointerEvents) detail.style.removeProperty('pointer-events');
      if (overview) {
        detail.setAttribute('aria-hidden', 'true');
      } else {
        detail.removeAttribute('aria-hidden');
      }
    }
    if (title) {
      title.classList.remove(
        'node-overview-surface--entering',
        'node-overview-surface--exiting',
      );
      if (animate) {
        title.classList.add(
          overview
            ? 'node-overview-surface--entering'
            : 'node-overview-surface--exiting',
        );
      }
      title.style.opacity = overview ? '1' : '0';
      title.style.pointerEvents = overview ? 'auto' : 'none';
      if (overview) {
        title.removeAttribute('aria-hidden');
      } else {
        title.setAttribute('aria-hidden', 'true');
      }
    }
  }
}

const overviewLayoutByCard = new WeakMap<HTMLElement, { zoom: number; height: number }>();
const overviewZoomByContainer = new WeakMap<HTMLElement, number>();

export function applyNodeOverviewFontSize(
  container: HTMLElement,
  zoom: number,
) {
  const previousZoom = overviewZoomByContainer.get(container);
  overviewZoomByContainer.set(container, zoom);
  // Ordinary detail zoom is a transform only. Hidden overview text does not
  // need another DOM sweep after it has been reset on leaving overview.
  if (zoom >= GROUP_LABEL_ZOOM_THRESHOLD && previousZoom != null
    && previousZoom >= GROUP_LABEL_ZOOM_THRESHOLD) return;
  // Keep the changing value on the small controls themselves. An inherited
  // variable on the canvas invalidates styles throughout every node body on
  // each zoom frame, even though only these buttons use it.
  const controlScale = zoom < GROUP_LABEL_ZOOM_THRESHOLD ? 1 / Math.max(zoom, 0.01) : 1;
  const viewport = useLiveViewportStore.getState();
  const project = useGraphStore.getState().project;
  const positions = useLivePositionsStore.getState().positions;
  const { width, height } = overviewViewportSize(container);
  const fontSize = overviewFontSizeForZoom(zoom);
  const metrics = overviewSkeletonMetricsForZoom(zoom);
  for (const card of container.querySelectorAll<HTMLElement>('.node-overview-eligible')) {
    const model = project?.nodes[card.dataset.nodeId ?? ''];
    if (zoom < GROUP_LABEL_ZOOM_THRESHOLD && model && width > 0 && height > 0) {
      const position = positions[model.id] ?? model.position;
      const left = position.x * zoom + viewport.x;
      const top = position.y * zoom + viewport.y;
      // Include the small controls and pre-size just before a card enters.
      const margin = 64;
      if (left > width + margin || top > height + margin
        || left + nodeWidth(model) * zoom < -margin
        || top + nodeRenderedH(model) * zoom < -margin) continue;
    }
    const cardHeight = nodeRenderedH(model ?? {});
    const previousLayout = overviewLayoutByCard.get(card);
    if (previousLayout?.zoom === zoom && previousLayout.height === cardHeight) continue;
    overviewLayoutByCard.set(card, { zoom, height: cardHeight });
    const control = card.querySelector<HTMLElement>(':scope > .node-fit-btn');
    control?.style.setProperty('--node-overview-control-scale', `${controlScale}`);
    const title = card.querySelector<HTMLElement>('.node-overview-title');
    if (!title) continue;
    if (zoom >= GROUP_LABEL_ZOOM_THRESHOLD) {
      title.style.fontSize = '';
      continue;
    }
    const titleLayout = overviewTitleLayoutForZoom(zoom, cardHeight);
    title.style.fontSize = `${fontSize}px`;
    title.style.setProperty('--overview-title-lines', `${titleLayout.lines}`);
    title.style.setProperty('--overview-title-reserve', `${titleLayout.reserve}px`);
    title.toggleAttribute('data-overview-title-compact', titleLayout.reserve > 0);
    const skeleton = title.nextElementSibling;
    if (skeleton instanceof HTMLElement
      && skeleton.classList.contains('node-overview-skeleton')) {
      skeleton.style.setProperty('--overview-skeleton-gap', `${metrics.gap}px`);
      skeleton.style.setProperty('--overview-skeleton-unit', `${metrics.unit}px`);
      skeleton.style.setProperty('--overview-control-clearance', `${metrics.controlClearance}px`);
    }
  }
}

/**
 * One threshold subscription updates only the two presentation surfaces in
 * each eligible card. Node bodies never mount, unmount, or remeasure here.
 */
export function NodeOverviewController({
  containerRef,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  const overview = useLiveViewportStore(
    (viewport) => viewport.zoom < GROUP_LABEL_ZOOM_THRESHOLD,
  );
  const previousOverviewRef = useRef<boolean | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const animate = previousOverviewRef.current !== null
      && previousOverviewRef.current !== overview;
    applyNodeOverviewMode(container, overview, animate);
    previousOverviewRef.current = overview;
    applyNodeOverviewFontSize(container, useLiveViewportStore.getState().zoom);
    if (overview) clearReadableSurface();
  }, [containerRef, overview]);

  // On the first commit the child's layout effect may run before the host's
  // ref is attached. Initialize after refs are ready as well, including a
  // project that opens already below the skeleton threshold.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || previousOverviewRef.current !== null) return;
    applyNodeOverviewMode(container, overview);
    previousOverviewRef.current = overview;
    applyNodeOverviewFontSize(container, useLiveViewportStore.getState().zoom);
    if (overview) clearReadableSurface();
  }, [containerRef, overview]);

  useEffect(() => {
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const container = containerRef.current;
        if (container) {
          applyNodeOverviewFontSize(
            container,
            useLiveViewportStore.getState().zoom,
          );
        }
      });
    };
    const unsubscribe = useLiveViewportStore.subscribe((viewport, previous) => {
      if (viewport.zoom >= GROUP_LABEL_ZOOM_THRESHOLD && previous.zoom >= GROUP_LABEL_ZOOM_THRESHOLD) return;
      schedule();
    });
    const container = containerRef.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
      if (!container) return;
      for (const entry of entries) {
        if (entry.target !== container) continue;
        overviewBoundsByContainer.set(container, {
          width: entry.contentRect.width, height: entry.contentRect.height,
        });
        schedule();
      }
    });
    if (container) observer?.observe(container);
    return () => {
      unsubscribe();
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [containerRef]);

  useEffect(() => () => {
    const container = containerRef.current;
    if (container) {
      applyNodeOverviewMode(container, false);
      applyNodeOverviewFontSize(container, 1);
    }
  }, [containerRef]);

  return null;
}
