'use client';

import { useEffect, type RefObject } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { isBatchNodeSelection, NODE_SELECTION_CONTROLS } from './nodeSelection';

/** One app-wide listener, with live store reads rather than a subscription
 * that would re-render the canvas on every selection change. */
export function useNodeSelectionDismiss(canvasRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const onInteraction = (event: Event) => {
      const graph = useGraphStore.getState();
      const groupId = graph.selectedGroupId;
      const selection = graph.project?.selection;
      if (!groupId && !isBatchNodeSelection(selection, groupId)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (groupId && target?.closest('[data-sidebar-group-id]')?.getAttribute('data-sidebar-group-id') === groupId) return;
      if (target?.closest('.node-selection-toolbar')) return;

      // Canvas background taps, drags, and ASCII group-label hits share a DOM
      // target. Let Canvas finish that gesture instead of clearing a group
      // that its pointer-up handler has just selected from an ASCII label.
      if (target === canvasRef.current) return;

      const node = target?.closest<HTMLElement>('.node[data-node-id]');
      if (node && canvasRef.current?.contains(node)) {
        // Do not clear the original set before Ctrl-click / Shift-drag can
        // extend it (or restore it if the marquee gesture is cancelled).
        const pointer = event as MouseEvent;
        if ((pointer.ctrlKey || pointer.metaKey || pointer.shiftKey)
          && !target?.closest(NODE_SELECTION_CONTROLS)) return;
        if (!target?.closest('.node-followup-bar, .node-corner-btn, .node-resize')
          && selection?.includes(node.dataset.nodeId!)) return;
      }

      // Selection is transient: this deliberately creates no undo entry.
      graph.setSelection([]);
    };
    // Capture sees controls that stop propagation. Click also covers keyboard
    // activation and controls that synthesize a click without pointer events.
    document.addEventListener('pointerdown', onInteraction, true);
    document.addEventListener('click', onInteraction, true);
    return () => {
      document.removeEventListener('pointerdown', onInteraction, true);
      document.removeEventListener('click', onInteraction, true);
    };
  }, [canvasRef]);
}
