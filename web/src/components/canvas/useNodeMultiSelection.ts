'use client';

import { useEffect, useRef, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { nodeRenderedH, nodeWidth } from '@/lib/nodeSize';
import { useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useCanvasSelectionStore } from '@/store/useCanvasSelectionStore';
import { NODE_SELECTION_CONTROLS as CONTROLS } from '@/lib/nodeSelection';

// Term chips keep Ctrl/⌘+click = explore collapsed. Inputs and node controls
// keep their normal interactions; plain card/title/text clicks select nodes.
// Target chips explicitly: bullet rows also use role="button", but Ctrl-click
// on a bullet's ordinary text must still toggle the containing node selection.

export function toggleNodeSelection(id: string) {
  const graph = useGraphStore.getState();
  const selection = graph.project?.selection ?? [];
  graph.setSelection(selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]);
  graph.requestPanTo(null);
}

/** Gesture state and the marquee stay outside React: dragging the rectangle
 * only updates the graph when the set of intersecting nodes actually changes. */
export function useNodeMultiSelection(containerRef: RefObject<HTMLDivElement>) {
  const drag = useRef<{
    pointerId: number; projectId: string; x: number; y: number;
    original: string[]; originalGroupId: string | null; additive: boolean; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const finish = (restore: boolean) => {
    const current = drag.current;
    drag.current = null;
    if (current && restore && useGraphStore.getState().project?.id === current.projectId) {
      const graph = useGraphStore.getState();
      if (current.originalGroupId && graph.project?.groups[current.originalGroupId]) graph.selectGroup(current.originalGroupId);
      else graph.setSelection(current.original);
    }
    if (current && containerRef.current?.hasPointerCapture?.(current.pointerId)) {
      containerRef.current.releasePointerCapture(current.pointerId);
    }
    if (containerRef.current) delete containerRef.current.dataset.nodeBoxSelecting;
    useCanvasSelectionStore.getState().setMarquee(null);
  };

  useEffect(() => {
    const showSelectCursor = (held: boolean) => {
      const container = containerRef.current;
      if (!container) return;
      if (held) container.dataset.nodeSelectionReady = '';
      else delete container.dataset.nodeSelectionReady;
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Shift') showSelectCursor(true);
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(true);
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Shift') showSelectCursor(false); };
    const onBlur = () => { finish(true); showSelectCursor(false); };
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    const unsubscribe = useGraphStore.subscribe((state) => {
      if (drag.current && state.project?.id !== drag.current.projectId) finish(false);
    });
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      unsubscribe();
      finish(false);
      showSelectCursor(false);
    };
    // Refs own the gesture; no state-dependent listener churn while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    if (event.target.closest(CONTROLS)) return;
    const node = event.target.closest<HTMLElement>('.node[data-node-id]');
    if (!node && event.target !== event.currentTarget) return;
    if (event.shiftKey) {
      const project = useGraphStore.getState().project;
      if (!project) return;
      drag.current = {
        pointerId: event.pointerId, projectId: project.id,
        x: event.clientX, y: event.clientY, original: [...project.selection],
        originalGroupId: useGraphStore.getState().selectedGroupId,
        additive: event.ctrlKey || event.metaKey, moved: false,
      };
      useGraphStore.getState().requestPanTo(null);
      if (containerRef.current) containerRef.current.dataset.nodeBoxSelecting = '';
      event.currentTarget.setPointerCapture(event.pointerId);
      suppressClick.current = true;
    } else if (!(node && (event.ctrlKey || event.metaKey))) return;
    window.getSelection()?.removeAllRanges();
    event.preventDefault();
    event.stopPropagation();
  };

  const updateRectangle = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const container = containerRef.current;
    if (!current || !container || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
    current.moved = true;
    const rect = container.getBoundingClientRect();
    const left = Math.min(current.x, event.clientX) - rect.left;
    const top = Math.min(current.y, event.clientY) - rect.top;
    const width = Math.abs(event.clientX - current.x);
    const height = Math.abs(event.clientY - current.y);
    useCanvasSelectionStore.getState().setMarquee({
      projectId: current.projectId, rect: { x: left, y: top, w: width, h: height },
    });
    const viewport = useLiveViewportStore.getState();
    const x = (left - viewport.x) / viewport.zoom;
    const y = (top - viewport.y) / viewport.zoom;
    const right = x + width / viewport.zoom;
    const bottom = y + height / viewport.zoom;
    const graph = useGraphStore.getState();
    if (!graph.project || graph.project.id !== current.projectId) return;
    const positions = useLivePositionsStore.getState().positions;
    const ids = new Set(current.additive ? current.original : []);
    for (const node of Object.values(graph.project.nodes)) {
      const pos = positions[node.id] ?? node.position;
      if (pos.x <= right && pos.x + nodeWidth(node) >= x
        && pos.y <= bottom && pos.y + nodeRenderedH(node) >= y) ids.add(node.id);
    }
    const next = [...ids];
    if (next.length !== graph.project.selection.length || next.some((id, i) => id !== graph.project!.selection[i])) {
      graph.setSelection(next);
    }
  };

  return {
    handlers: {
      onPointerDownCapture,
      onPointerMoveCapture: updateRectangle,
      onPointerUpCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        updateRectangle(event);
        finish(false);
        event.preventDefault();
        event.stopPropagation();
      },
      onPointerCancelCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        finish(true);
        event.stopPropagation();
      },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) finish(true);
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)
          || event.target.closest(CONTROLS)) return;
        const nodeId = event.target.closest<HTMLElement>('.node[data-node-id]')?.dataset.nodeId;
        if (!nodeId) return;
        event.preventDefault();
        event.stopPropagation();
        toggleNodeSelection(nodeId);
      },
    },
  };
}
