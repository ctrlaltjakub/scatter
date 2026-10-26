'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { imageSelectionAllowed, useImageSelectionStore } from '@/store/useImageSelectionStore';
import { EMPTY_IMAGE_REGIONS } from '@/lib/imageRegions';
import { useImageRegionDrag } from '@/hooks/useImageRegionDrag';
import { ImageRegionOverlay } from './ImageRegionOverlay';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import { toggleNodeSelection } from '@/components/canvas/useNodeMultiSelection';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';
import { imageMediaKey } from '@/lib/imageAtlas';
import { useImageGeometryStore } from '@/store/useImageGeometryStore';
import { ImageAtlasOverlay } from './ImageAtlasOverlay';

export function SelectableImage({ nodeId, src, onLoad, onError }: {
  nodeId: string; src: string; onLoad: () => void; onError: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [imageRect, setImageRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [loaded, setLoaded] = useState(false);
  const editorOpen = useImageEditorStore((s) => s.open);
  const focused = useGraphStore((s) => s.project?.selection.length === 1 && s.project.selection[0] === nodeId);
  const detailed = useLiveViewportStore((s) => s.zoom >= GROUP_LABEL_ZOOM_THRESHOLD);
  const selectable = loaded && focused && detailed && !editorOpen;
  const owner = useRef(Symbol('image-layout'));
  const projectId = useGraphStore((s) => s.project?.id ?? '');
  const mediaKey = useGraphStore((s) => {
    const n = s.project?.nodes[nodeId];
    return imageMediaKey(n?.versions[n.currentVersionIndex]?.media);
  });
  const versionCreatedAt = useGraphStore((s) => {
    const n = s.project?.nodes[nodeId];
    return n?.versions[n.currentVersionIndex]?.createdAt ?? 0;
  });
  const regions = useImageSelectionStore((s) => s.selection?.nodeId === nodeId
    && s.selection.projectId === projectId && s.selection.versionCreatedAt === versionCreatedAt
    ? s.selection.regions : EMPTY_IMAGE_REGIONS);
  const measure = () => {
    const image = imageRef.current, wrap = wrapRef.current;
    if (!image?.naturalWidth || !wrap) return;
    const scale = Math.min(wrap.clientWidth / image.naturalWidth, wrap.clientHeight / image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    const next = { left: (wrap.clientWidth - width) / 2, top: (wrap.clientHeight - height) / 2, width, height };
    setImageRect((old) => Object.keys(next).every((key) => old[key as keyof typeof next] === next[key as keyof typeof next]) ? old : next);
    const card = wrap.closest<HTMLElement>('.node[data-node-id]');
    if (card && mediaKey && wrap.clientWidth && wrap.clientHeight) {
      const box = wrap.getBoundingClientRect(), cardBox = card.getBoundingClientRect();
      const sx = box.width / wrap.clientWidth, sy = box.height / wrap.clientHeight;
      if (sx > 0 && sy > 0) useImageGeometryStore.getState().set(nodeId, {
        projectId, mediaKey, owner: owner.current,
        rect: { x: (box.left - cardBox.left) / sx + next.left, y: (box.top - cardBox.top) / sy + next.top, width, height },
      });
    }
  };
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    const card = wrap.closest('.node[data-node-id]');
    if (card) observer.observe(card);
    const header = card?.querySelector('.node-header');
    if (header) observer.observe(header);
    measure();
    return () => {
      observer.disconnect();
      useImageGeometryStore.getState().remove(nodeId, owner.current);
    };
  }, [src, projectId, nodeId, mediaKey, versionCreatedAt]);
  const drag = useImageRegionDrag({
    enabled: selectable,
    canStart: () => imageSelectionAllowed(nodeId),
    regions,
    bounds: () => {
      const wrap = wrapRef.current;
      if (!wrap?.clientWidth || !wrap.clientHeight) return null;
      const screen = wrap.getBoundingClientRect();
      const sx = screen.width / wrap.clientWidth, sy = screen.height / wrap.clientHeight;
      return { left: screen.left + imageRect.left * sx, top: screen.top + imageRect.top * sy,
        width: imageRect.width * sx, height: imageRect.height * sy };
    },
    onStart: () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const graph = useGraphStore.getState();
      graph.requestPanTo(null);
    },
    onChange: (next) => useImageSelectionStore.getState().set({ projectId, nodeId, versionCreatedAt, regions: next }),
  });
  return (
    <div ref={wrapRef} className={`image-selection-surface${selectable ? ' is-selectable' : ''}`} role="group" aria-label="Image selection"
      data-image-selection-surface={selectable ? '' : undefined} {...drag.handlers}
      onClickCapture={(event) => {
        drag.handlers.onClickCapture(event);
        if (event.isPropagationStopped() || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault(); event.stopPropagation(); toggleNodeSelection(nodeId);
      }}
      data-tip={selectable ? 'Drag to select part of the image · Ctrl/⌘-drag to add · Esc to clear' : undefined}>
      <img ref={imageRef} src={src} alt="" className="sc-media-img" draggable={false}
        onLoad={() => { setLoaded(true); measure(); onLoad(); }} onError={() => { setLoaded(false); onError(); }} />
      {!editorOpen && <ImageAtlasOverlay nodeId={nodeId} style={imageRect} />}
      {selectable && <ImageRegionOverlay regions={drag.displayedRegions} style={imageRect} />}
    </div>
  );
}
