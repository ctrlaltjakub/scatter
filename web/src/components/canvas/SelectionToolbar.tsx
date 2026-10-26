'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selectionNodeId } from '@/lib/selectionNode';
import { resolveNodeTextSelection } from '@/lib/nodeTextSelection';
import { clearPreservedSelectionHighlight, preserveSelectionHighlight } from '@/lib/selectionHighlight';
import { spawnTermClick, spawnRoutedExplain } from '@/lib/generate';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import type { NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import { Sparkles } from 'lucide-react';
import { spawnImageFromSelection } from '@/lib/imageGeneration';
import { useImageGenerationAvailable } from '@/hooks/useImageGenerationAvailable';
import { activateChatAnswer } from '@/lib/chat/actions';
import { SelectionWebSearchLink } from '../SelectionWebSearchLink';
import { positionSelectionToolbar } from '@/lib/positionSelectionToolbar';

/**
 * Floating toolbar that appears above a finished text selection inside a single
 * node body, turning the selection into actions:
 *   - Copy    — copy the selected text.
 *   - Web search — open the configured search engine in a new browser tab.
 *   - Explore — spawn a normal node about the selection (same as a term-click).
 *   - Explain — spawn a node explaining the selection for a newcomer.
 *
 * Screen-fixed, but it TRACKS the selected text: its position is recomputed from
 * the live selection rect whenever the camera pans/zooms (live-viewport store)
 * or the window scrolls/resizes — so it stays anchored above the text instead of
 * drifting when the camera moves. Positioning is imperative (no re-render per
 * camera frame). It appears on mouse-up (after the selection is made), and
 * dismisses on Escape, selection-collapse, or a click outside the bar.
 */
interface ToolbarState {
  nodeId: string;
  text: string;
  selection: NodeTextSelection;
}

export function SelectionToolbar() {
  const [state, setState] = useState<ToolbarState | null>(null);
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const preservingForFollowUpRef = useRef(false);
  // Timer that reverts the "Copied" label back to "Copy" after a beat.
  const copiedTimerRef = useRef<number | null>(null);
  const imageEnabled = useImageGenerationAvailable();

  const clearSelection = useCallback((removeNative = false) => {
    setState(null);
    preservingForFollowUpRef.current = false;
    clearPreservedSelectionHighlight();
    useNodeTextSelectionStore.getState().clear();
    if (removeNative) window.getSelection()?.removeAllRanges();
  }, []);

  // Position the bar from the current selection rect (imperative — keeps it
  // glued to the text across camera motion without re-rendering).
  const reposition = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (!preservingForFollowUpRef.current) clearSelection();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      if (!preservingForFollowUpRef.current) clearSelection();
      return;
    }
    // Hide while the selection is scrolled/panned fully off-screen.
    const off = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
    bar.style.visibility = off ? 'hidden' : 'visible';
    // Viewer prose is screen-sized rather than camera-transformed. Canvas
    // selections retain their world-relative toolbar scale.
    const selectionRoot = sel.anchorNode?.nodeType === Node.ELEMENT_NODE
      ? sel.anchorNode as Element
      : sel.anchorNode?.parentElement;
    const inViewer = !!selectionRoot?.closest('[data-sc-reading-node-id]');
    positionSelectionToolbar(bar, rect, inViewer ? 1 : useLiveViewportStore.getState().zoom);
  }, [clearSelection]);

  // Keep the bar glued to the text after every render and on camera/scroll moves.
  useLayoutEffect(() => {
    if (state) reposition();
  });

  useEffect(() => {
    // Appear only AFTER the selection is finished (mouse released).
    const showFromSelection = () => {
      const sel = window.getSelection();
      const reject = () => {
        clearSelection();
      };
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return reject();
      const text = sel.toString().trim();
      if (!text) return reject();
      const nodeId = selectionNodeId(sel.anchorNode, sel.focusNode);
      if (!nodeId) return reject();
      const project = useGraphStore.getState().project;
      const node = project?.nodes[nodeId];
      const origin = (sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode as Element : sel.anchorNode?.parentElement)
        ?.closest<HTMLElement>('[data-chat-answer]');
      const endOrigin = (sel.focusNode?.nodeType === Node.ELEMENT_NODE ? sel.focusNode as Element : sel.focusNode?.parentElement)
        ?.closest<HTMLElement>('[data-chat-answer]');
      if (node?.chat && (!origin || origin !== endOrigin)) return reject();
      const versionIndex = origin ? node?.versions.findIndex((item) => item.createdAt === Number(origin.dataset.chatAnswerCreatedAt)) : node?.currentVersionIndex;
      const version = versionIndex == null ? undefined : node?.versions[versionIndex];
      const root = (sel.anchorNode?.nodeType === Node.ELEMENT_NODE
        ? sel.anchorNode as Element
        : sel.anchorNode?.parentElement)?.closest<HTMLElement>('.sc-ab-root, .chat-markdown');
      if (!node || versionIndex == null || !version || !root) return reject();
      if (version.chat) activateChatAnswer(nodeId, { turnId: version.chat.turnId, versionCreatedAt: version.createdAt });
      const exact = resolveNodeTextSelection({
        body: version.body,
        nodeId,
        versionIndex,
        range: sel.getRangeAt(0),
        root,
      });
      if (!exact) return reject();
      preservingForFollowUpRef.current = false;
      clearPreservedSelectionHighlight();
      useNodeTextSelectionStore.getState().set(exact);
      // Selecting source text also focuses its node, but deliberately does not
      // request a camera pan: the user is already looking at this text.
      useGraphStore.getState().setSelection([nodeId]);
      setCopied(false);
      setState({ nodeId, text: exact.text.trim(), selection: exact });
    };
    let raf: number | null = null;
    const onMouseUp = (e: MouseEvent) => {
      // A mouseup INSIDE the bar is a button click, not a text selection —
      // don't recompute/re-render (that flips the label and shudders the bar).
      if ((e.target as Element | null)?.closest?.('.sc-sel-toolbar, .node-followup-bar')) return;
      if (raf != null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(showFromSelection);
    };
    // Selection cleared by any means → hide.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        setState(null);
        if (!preservingForFollowUpRef.current) clearSelection();
      }
    };
    // A press anywhere outside the bar dismisses it; if it also lands outside a
    // node body (canvas, sidebar, header), clear the lingering highlight too.
    const onPointerDownCapture = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.sc-sel-toolbar')) return;
      setState(null);
      // Clicking into the node's bottom prompt intentionally keeps the source
      // range alive. Clone it into a paint-only CSS highlight before the
      // browser moves focus/caret into the textarea or action button.
      if (t?.closest?.('.node-followup-bar')) {
        const sel = window.getSelection();
        const exact = useNodeTextSelectionStore.getState().selection;
        if (exact && sel && !sel.isCollapsed && sel.rangeCount > 0) {
          preserveSelectionHighlight(sel.getRangeAt(0));
          preservingForFollowUpRef.current = true;
        }
        return;
      }
      clearSelection(!t?.closest?.('.sc-ab-root'));
    };
    const onWheelCapture = (e: WheelEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.('.node-followup-bar')) return;
      if (useNodeTextSelectionStore.getState().selection) clearSelection(true);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('.node-followup-bar, input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Shift' || (e.shiftKey && /^(Arrow|Home|End)/.test(e.key)) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) {
        if (raf != null) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(showFromSelection);
      }
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('wheel', onWheelCapture, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    // The camera (pan/zoom/tween/keyboard) all flow through the live viewport
    // store — track it so the bar follows the text wherever it moves.
    const unsub = useLiveViewportStore.subscribe(reposition);
    const unsubGraph = useGraphStore.subscribe((graph) => {
      const exact = useNodeTextSelectionStore.getState().selection;
      if (!exact) return;
      const node = graph.project?.nodes[exact.nodeId];
      const valid = node
        && graph.project?.selection.includes(exact.nodeId)
        && node.currentVersionIndex === exact.versionIndex
        && node.versions[exact.versionIndex]?.body === exact.sourceBody;
      if (!valid) useNodeTextSelectionStore.getState().clear();
    });
    const unsubSelection = useNodeTextSelectionStore.subscribe((selectionState) => {
      if (selectionState.selection) return;
      setState(null);
      preservingForFollowUpRef.current = false;
      clearPreservedSelectionHighlight();
    });
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onPointerDownCapture, true);
      document.removeEventListener('wheel', onWheelCapture, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      unsub();
      unsubGraph();
      unsubSelection();
      clearPreservedSelectionHighlight();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [clearSelection, reposition]);

  // Clear the pending "Copied" revert timer if the bar unmounts first.
  useEffect(() => () => { if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current); }, []);

  if (!state) return null;

  const dismiss = () => {
    clearSelection(true);
  };

  const onCopy = () => {
    void navigator.clipboard?.writeText(state.text);
    setCopied(true);
    // Flash "Copied", then revert to "Copy" after half a second.
    if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 500);
  };
  const onExplore = () => {
    void spawnTermClick(state.nodeId, state.text, { sourceSelection: state.selection });
    dismiss();
  };
  const onExplain = () => {
    void spawnRoutedExplain(state.nodeId, state.text, { sourceSelection: state.selection });
    dismiss();
  };
  const onImage = () => {
    if (!imageEnabled) return;
    void spawnImageFromSelection(state.nodeId, state.selection);
    dismiss();
  };

  return (
    <div
      ref={barRef}
      className="sc-sel-toolbar"
      // Keep the selection alive while the user clicks a button.
      onMouseDown={(e) => e.preventDefault()}
      // Don't let a click on the bar start a canvas pan.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="sc-sel-btn" onClick={onCopy} style={{ minWidth: 64, textAlign: 'center' }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="sc-sel-div" aria-hidden="true" />
      <SelectionWebSearchLink text={state.text} />
      <span className="sc-sel-div" aria-hidden="true" />
      <button type="button" className="sc-sel-btn" onClick={onExplore}>
        Explore
      </button>
      <span className="sc-sel-div" aria-hidden="true" />
      <button type="button" className="sc-sel-btn" onClick={onExplain}>
        Explain
      </button>
      <span className="sc-sel-div" aria-hidden="true" />
      <button
        type="button"
        className="sc-sel-btn sc-sel-image-btn"
        onClick={onImage}
        disabled={!imageEnabled}
        data-tip={imageEnabled ? 'Turn the selected text into an educational image' : 'Choose an image model in Settings → Models and generation.'}
      >
        <Sparkles size={13} aria-hidden="true" />
        Image
      </button>
    </div>
  );
}
