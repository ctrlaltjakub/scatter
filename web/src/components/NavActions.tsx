'use client';
import { useEffect, useState } from 'react';
import {
  Settings, Undo2, Redo2, ZoomIn, ZoomOut, Maximize2, Minimize2,
} from 'lucide-react';
import { useStore } from 'zustand';
import { useGraphStore } from '@/store/useGraphStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { zoomCameraBy, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from '@/lib/zoomCamera';
import { ThemeToggleButton } from '@/components/ThemeToggleButton';
import { redoGraphHistory, undoGraphHistory } from '@/lib/graphHistoryActions';
import { useHistoryMetaStore } from '@/store/useHistoryMetaStore';

/**
 * Shared navigation icon strip — used in two places:
 *   - Sidebar footer (when sidebar is expanded)
 *   - Canvas top-right toolbar (when sidebar is collapsed)
 *
 * Reads viewport/project from the graph store directly so the parent doesn't
 * need to plumb the data through.
 */
export function NavActions({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
  // Accepted for call-site compatibility (CanvasToolbar passes it); unused now
  // that fit-to-view became a fullscreen toggle.
  containerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const project = useGraphStore((s) => s.project);

  // While the image editor is open, Undo/Redo drive ITS history (annotation
  // steps), not the graph's — matching what Ctrl+Z does there.
  const editorUndo = useImageEditorStore((s) => s.undoHandle);
  const undo = () => {
    const h = useImageEditorStore.getState().undoHandle;
    if (h) h.undo();
    else undoGraphHistory();
  };
  const redo = () => {
    const h = useImageEditorStore.getState().undoHandle;
    if (h) h.redo();
    else redoGraphHistory();
  };

  const zoomIn = () => { if (project) zoomCameraBy(ZOOM_IN_FACTOR); };
  const zoomOut = () => { if (project) zoomCameraBy(ZOOM_OUT_FACTOR); };

  // Fullscreen toggle (replaces the old fit-to-view). Tracks the actual
  // fullscreen state so the icon + label adapt, including when the user exits
  // via Esc / the browser chrome.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  // Subscribe to the temporal store so the disabled state updates as past/future change
  const canUndoGraph = useStore(useGraphStore.temporal, (s) => s.pastStates.length > 0);
  const canRedoGraph = useStore(useGraphStore.temporal, (s) => s.futureStates.length > 0);
  const canUndo = editorUndo ? editorUndo.canUndo : canUndoGraph;
  const canRedo = editorUndo ? editorUndo.canRedo : canRedoGraph;
  const undoLabel = useHistoryMetaStore((state) => state.past.at(-1)?.label);
  const redoLabel = useHistoryMetaStore((state) => state.future.at(-1)?.label);
  const undoDescription = editorUndo
    ? 'Undo image edit'
    : undoLabel
      ? `Undo: ${undoLabel}`
      : 'Undo';
  const redoDescription = editorUndo
    ? 'Redo image edit'
    : redoLabel
      ? `Redo: ${redoLabel}`
      : 'Redo';

  return (
    <>
      <button
        type="button"
        className="icon-btn"
        data-tip={`${undoDescription} (⌘Z)`}
        aria-label={undoDescription}
        onClick={undo}
        disabled={!canUndo}
      >
        <Undo2 size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-tip={`${redoDescription} (⌘⇧Z)`}
        aria-label={redoDescription}
        onClick={redo}
        disabled={!canRedo}
      >
        <Redo2 size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-tip="Zoom in"
        aria-label="Zoom in"
        onClick={zoomIn}
      >
        <ZoomIn size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-tip="Zoom out"
        aria-label="Zoom out"
        onClick={zoomOut}
      >
        <ZoomOut size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-tip={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        onClick={toggleFullscreen}
      >
        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <ThemeToggleButton />
      <button
        type="button"
        className="icon-btn"
        data-tip="Settings (⌘,)"
        aria-label="Settings"
        onClick={onOpenSettings}
        data-testid="settings-gear"
      >
        <Settings size={16} />
      </button>
    </>
  );
}
