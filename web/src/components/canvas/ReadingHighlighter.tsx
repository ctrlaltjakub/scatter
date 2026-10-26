'use client';
import { useEffect } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useEditorStore } from '@/store/useEditorStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { useReadingStore } from '@/store/useReadingStore';
import { exitReading, readingSurfaceFor, reconcileReading } from '@/lib/readingController';

/* -------------------------------------------------------------------------
 * ReadingHighlighter — the reading ruler's EXIT watcher. Renders nothing;
 * the ruler itself is driven imperatively by lib/readingController (keys)
 * and painted via the CSS Custom Highlight API (lib/readingDom).
 *
 * While a node is being read, tear the ruler down on anything that
 * invalidates the position:
 *   - any pointerdown ("clicking with the mouse somewhere else" — and any
 *     click can drag/select/edit, all of which move text under the ruler),
 *   - the selection moving away from the node (incl. deselect, Esc's
 *     deselect path never fires while reading — page.tsx consumes it),
 *   - a non-streaming body/version replacement (undo, version switch),
 *     while streaming mutations are observed and reconciled after paint,
 *   - the text/image editor overlays opening (full-window modes).
 * ------------------------------------------------------------------------*/
export function ReadingHighlighter() {
  const nodeId = useReadingStore((s) => s.nodeId);

  useEffect(() => {
    if (!nodeId) return;

    const onPointerDown = () => exitReading();
    document.addEventListener('pointerdown', onPointerDown, true);

    let reconcileRaf = 0;
    const scheduleReconcile = () => {
      if (reconcileRaf) cancelAnimationFrame(reconcileRaf);
      // Graph updates happen before React paints the matching DOM. One frame
      // gets us past the commit; the nested frame rebuilds from settled text.
      reconcileRaf = requestAnimationFrame(() => {
        reconcileRaf = requestAnimationFrame(() => {
          reconcileRaf = 0;
          reconcileReading(nodeId);
        });
      });
    };

    const versionedBody = () => {
      const n = useGraphStore.getState().project?.nodes[nodeId];
      if (!n) return null;
      return `${n.currentVersionIndex}\u0000${n.versions[n.currentVersionIndex]?.body ?? ''}`;
    };
    let lastBody = versionedBody();
    let lastChatVersions = useGraphStore.getState().project?.nodes[nodeId]?.versions;
    let sawGenerating = !!useGraphStore.getState().project?.nodes[nodeId]?.generating;

    const unsubGraph = useGraphStore.subscribe((s) => {
      const p = s.project;
      const n = p?.nodes[nodeId];
      const selectedAlone = p?.selection.length === 1 && p.selection[0] === nodeId;
      if (!n || !selectedAlone) {
        exitReading();
        return;
      }
      // All displayed turns share one reading surface. Moving the ruler into
      // another turn changes the side-panel target, not the text being read.
      // Ignore that navigation and physics-only writes; reconcile actual text.
      if (n.chat) {
        if (n.versions !== lastChatVersions) {
          lastChatVersions = n.versions;
          scheduleReconcile();
        }
        return;
      }
      const nextBody = versionedBody();
      if (n.generating) {
        sawGenerating = true;
        lastBody = nextBody;
        scheduleReconcile();
        return;
      }
      if (sawGenerating) {
        sawGenerating = false;
        lastBody = nextBody;
        scheduleReconcile();
        return;
      }
      if (nextBody !== lastBody) exitReading();
    });
    const unsubEditor = useEditorStore.subscribe((s) => {
      if (s.open) exitReading();
    });
    const unsubImage = useImageEditorStore.subscribe((s) => {
      if (s.open) exitReading();
    });

    const card = readingSurfaceFor(nodeId);
    const observer = card
      ? new MutationObserver(() => scheduleReconcile())
      : null;
    if (card && observer) observer.observe(card, { subtree: true, childList: true, characterData: true });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      unsubGraph();
      unsubEditor();
      unsubImage();
      observer?.disconnect();
      if (reconcileRaf) cancelAnimationFrame(reconcileRaf);
    };
  }, [nodeId]);

  return null;
}
