'use client';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ImageRegion } from '@/store/types';
import { imageRegionFromDrag } from '@/lib/imageRegions';

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; width: number; height: number };

/** Screen-space gesture shared by DOM images and the editor's transformed
 * canvas. Only this tiny surface rerenders while dragging; graph state does not. */
export function useImageRegionDrag(options: {
  enabled: boolean;
  regions: readonly ImageRegion[];
  bounds: () => Bounds | null;
  canStart?: (event: ReactPointerEvent<HTMLDivElement>) => boolean;
  onStart?: () => void;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onChange: (regions: ImageRegion[]) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<{
    pointerId: number; element: HTMLDivElement; bounds: Bounds; start: Point;
    screenStart: Point; base: readonly ImageRegion[]; additive: boolean; moved: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<ImageRegion[] | null>(null);
  const suppressClick = useRef(false);

  const cancel = () => {
    const active = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
  };
  useEffect(() => { if (!options.enabled) cancel(); }, [options.enabled]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key !== 'Escape' || target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (!gesture.current && (!latest.current.enabled || !latest.current.regions.length)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (gesture.current) cancel();
      else latest.current.onChange([]);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', cancel);
      const active = gesture.current;
      gesture.current = null;
      if (active?.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    };
  }, []);

  const update = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return null;
    event.preventDefault();
    event.stopPropagation();
    if (!active.moved && Math.hypot(event.clientX - active.screenStart.x, event.clientY - active.screenStart.y) >= 4) {
      active.moved = true;
      suppressClick.current = true;
      latest.current.onStart?.();
    }
    if (!active.moved) return null;
    const rect = imageRegionFromDrag(active.start, {
      x: (event.clientX - active.bounds.left) / active.bounds.width,
      y: (event.clientY - active.bounds.top) / active.bounds.height,
    });
    const next = [...active.base, rect];
    setDraft(next);
    return next;
  };
  return {
    displayedRegions: draft ?? options.regions,
    clearSelection: () => {
      if (gesture.current) { cancel(); return true; }
      if (latest.current.regions.length) { latest.current.onChange([]); return true; }
      return false;
    },
    handlers: {
      onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
        suppressClick.current = false;
        if (!options.enabled || event.button !== 0 || gesture.current
          || (event.target as Element).closest('button, textarea, input')
          || options.canStart?.(event) === false) return;
        const bounds = options.bounds();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
        const point = { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
        if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
        const additive = event.ctrlKey || event.metaKey;
        gesture.current = { pointerId: event.pointerId, element: event.currentTarget, bounds, start: point,
          screenStart: { x: event.clientX, y: event.clientY }, base: additive ? options.regions : [], additive, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
      },
      onPointerMoveCapture: (event: ReactPointerEvent<HTMLDivElement>) => { update(event); },
      onPointerUpCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
        const active = gesture.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const next = update(event);
        if (next) options.onChange(next);
        else if (!active.additive) options.onChange([]);
        cancel();
      },
      onPointerCancelCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (gesture.current?.pointerId === event.pointerId) { event.stopPropagation(); cancel(); }
      },
      onLostPointerCapture: () => { if (gesture.current) cancel(); },
      onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current) { if (options.enabled) options.onClick?.(event); return; }
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
