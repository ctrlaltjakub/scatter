'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { animateScrollbarRange } from './scrollbarMotion';

/* -------------------------------------------------------------------------
 * Snap-to-section scrollbar (single-bar variant).
 *
 * One thumb-style bar that snaps from section to section. The bar's
 * top + height match the active section's bounding rect, so the bar
 * visibly represents the section it currently occupies. As the
 * cascade changes section heights (active bullet grows, others
 * collapse) the bar resizes to track the active section's new size.
 *
 * Wheel handling lives in the parent NodeBody: chunky wheel input retains the
 * 200-unit threshold, while smooth precision input uses the guarded touchpad
 * path in SectionWheelController.
 *
 * This component is responsible only for:
 *   - Rendering the gutter on the right edge of .node-body
 *   - Reading section-anchor rects to know each section's range
 *   - Click-to-advance: pointer down on the gutter moves the active
 *     stop to whichever section's center is closest to the pointer.
 *
 * Always visible while mounted (selected, non-collapsed, has bullets) — even
 * when every bullet already fits, the bar still marks the active section.
 * ------------------------------------------------------------------------*/

interface Props {
  /** Currently-active stop index: 0 = freetext, 1..N = bullet i-1. */
  activeStop: number;
  /** Previously visible stop when focus + activation mount the scrollbar together. */
  initialStop?: number;
  /** Called when the user clicks the scrollbar to advance to a stop. */
  onChangeStop: (next: number) => void;
  /** The .node-body element the scrollbar overlays. */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** Selectors of section anchors inside the body, in stop-index
   *  order: stop 0 = freetext anchor, stops 1..N = bullet i-1
   *  anchor. AdaptiveBullets tags each section with
   *  `data-sc-anchor="ft"` and `data-sc-anchor="b-<i>"`. */
  anchorSelectors: string[];
}

interface StopRange { top: number; height: number }
interface Measurement { ranges: StopRange[]; active: StopRange | undefined }

function sameRange(a: StopRange | undefined, b: StopRange | undefined): boolean {
  return a === b || !!a && !!b && Math.abs(a.top - b.top) < 0.01 && Math.abs(a.height - b.height) < 0.01;
}

// Scrollbar gutter's own top inset (matches `.node-scrollbar { top: 4px }`
// in globals.css). Section ranges are measured in BODY coordinates, but
// the bar renders inside the scrollbar gutter whose top:0 is body-top + 4.
// Subtract this so the bar's visual top aligns with the section's true
// top edge instead of sitting 4px lower.
const GUTTER_INSET = 4;

export function NodeScrollbar({
  activeStop, initialStop = activeStop, onChangeStop, bodyRef, anchorSelectors,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ pointerId: number } | null>(null);
  // Commit the target together with the layout it was measured from. Selecting
  // activeStop from the previous render's ranges briefly animates toward the
  // collapsed bullet, then cancels/restarts when the expanded layout arrives.
  const [measurement, setMeasurement] = useState<Measurement>({ ranges: [], active: undefined });
  const stopRanges = measurement.ranges;
  const measuredOnceRef = useRef(false);
  const [entryStop, setEntryStop] = useState<number | null>(
    () => initialStop !== activeStop ? initialStop : null,
  );
  const entryRangeRef = useRef<StopRange | undefined>(undefined);
  useEffect(() => {
    if (entryStop === null) return;
    // Paint the prior section first, then use the same frame-driven motion
    // as an ordinary wheel/click update on an existing scrollbar.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setEntryStop(null));
    });
    return () => cancelAnimationFrame(frame);
  }, [entryStop]);
  // ZOOM NORMALIZATION. The canvas wraps each node in a
  // `transform: scale(zoom)` container. `getBoundingClientRect()`
  // returns POST-transform (screen) pixels — at zoom 0.5 every
  // measured offset is half its real CSS pixel value. The bar's
  // inline `top`/`height` are interpreted in the scrollbar's CSS
  // coordinate space (which is ALSO transformed by the same zoom).
  // If we wrote raw screen-pixel offsets the browser would apply the
  // zoom transform a SECOND time, producing a misaligned bar at any
  // zoom ≠ 1. Dividing by zoom converts back to CSS-pixel space.
  // These ranges are in node-local CSS pixels, so camera zoom cannot change
  // them. Read the live scale when measuring / handling input, not through a
  // render subscription that restarts the whole observer + 420ms poll on each
  // pinch event.

  // Recompute each section's range by reading the anchor's bounding
  // rect inside the body. The cascade can shift anchors around (when
  // modes change → bullet heights change), so we re-run this on both
  // ResizeObserver fires AND for ~420 ms after every activeStop
  // change (covers any settle time after the cascade resolves).
  const recompute = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const z = useLiveViewportStore.getState().zoom || 1;
    const ranges: StopRange[] = [];
    for (const sel of anchorSelectors) {
      const a = body.querySelector<HTMLElement>(sel);
      if (!a) { ranges.push({ top: 0, height: 0 }); continue; }
      const r = a.getBoundingClientRect();
      // Anchor's top + height in CSS pixels relative to body-top.
      // The anchor is set on each section's container element, so
      // r.height matches the section's full rendered height — which
      // is what the bar needs to span.
      ranges.push({
        top: (r.top - bodyRect.top) / z,
        height: r.height / z,
      });
    }
    // Freeze the entry position: focusing + expanding can change that old
    // section's geometry before the first animation frame. Following it would
    // send the bar in the wrong direction before it heads to the clicked one.
    if (entryStop !== null && !entryRangeRef.current) entryRangeRef.current = ranges[entryStop];
    const active = entryStop !== null ? entryRangeRef.current : ranges[activeStop];
    setMeasurement(previous => sameRange(previous.active, active)
      && previous.ranges.length === ranges.length
      && previous.ranges.every((range, index) => sameRange(range, ranges[index]))
      ? previous : { ranges, active });
  }, [anchorSelectors, bodyRef, activeStop, entryStop]);

  // A sibling's layout effect can still be settling the cascade during this
  // commit. Keep the displayed target until the next frame/resize callback,
  // rather than measuring halfway through that commit. Only the first mount
  // needs an immediate range to avoid a missing initial bar.
  useLayoutEffect(() => {
    if (!measuredOnceRef.current) {
      measuredOnceRef.current = true;
      recompute();
    }
    const body = bodyRef.current;
    if (!body) return;
    // RAF poll for ~420 ms after each activeStop change — covers any
    // post-cascade settle time so the bar tracks the section's final
    // size precisely.
    let raf = 0;
    const tick = () => { recompute(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const stopRaf = window.setTimeout(() => cancelAnimationFrame(raf), 420);
    const ro = new ResizeObserver(recompute);
    ro.observe(body);
    // The body itself has a fixed height. Expanding a bullet can therefore
    // leave it unchanged while moving/resizing every anchor inside it.
    for (const selector of anchorSelectors) {
      const anchor = body.querySelector(selector);
      if (anchor) ro.observe(anchor);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(stopRaf);
      ro.disconnect();
    };
  }, [recompute, anchorSelectors, bodyRef]);

  const computeStopFromY = (clientY: number): number => {
    const body = bodyRef.current;
    if (!body || stopRanges.length === 0) return activeStop;
    const bodyRect = body.getBoundingClientRect();
    // Same zoom normalization as recompute(): screen-pixel offset
    // divided by zoom = CSS-pixel offset. stopRanges are in body
    // CSS pixels, so the comparison must be in body CSS pixels too.
    const z = useLiveViewportStore.getState().zoom || 1;
    const localY = (clientY - bodyRect.top) / z;
    // Pick the section the click is INSIDE (distance 0), falling back to the
    // nearest section by EDGE distance for clicks that land in the gaps
    // between sections. Using interval distance — not center distance — means
    // a click near a tall section's edge resolves to that section, not to a
    // neighbour whose center happens to be closer. (Center-distance is why a
    // click at the top of the first bullet used to snap to the freetext.)
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < stopRanges.length; i++) {
      const r = stopRanges[i]!;
      const bottom = r.top + r.height;
      const d = localY < r.top ? r.top - localY : localY > bottom ? localY - bottom : 0;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    draggingRef.current = { pointerId: e.pointerId };
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    onChangeStop(computeStopFromY(e.clientY));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = draggingRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    onChangeStop(computeStopFromY(e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = draggingRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    draggingRef.current = null;
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const active = measurement.active;
  const targetTop = active?.top;
  const targetHeight = active?.height;
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || targetTop == null || targetHeight == null) return;
    return animateScrollbarRange(bar, { top: targetTop - GUTTER_INSET, height: targetHeight });
  }, [targetTop, targetHeight]);
  return (
    <div
      ref={trackRef}
      className="node-scrollbar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-tip="Drag to expand a section"
    >
      {active ? (
        <div
          ref={barRef}
          className="node-scrollbar-bar"
        />
      ) : null}
    </div>
  );
}
