'use client';
/**
 * The image editor's drawing surface — the ONLY file that imports Konva.
 * (It's reached exclusively through the page-level dynamic import of
 * ImageEditorOverlay, so Konva never enters the main bundle.)
 *
 * Coordinate model: the Stage's logical space IS the (90°-turned) image in
 * pixels — annotations, stroke widths and font sizes all live in image space,
 * and the stage is merely scaled down to fit the card. Export happens at
 * scale 1, so the preview and the baked file are the same pixels by
 * construction. The fine "straighten" angle rotates a world group (image +
 * annotations together) about the crop center, zoomed by coverScaleForRotation
 * so the crop window never sees an empty corner.
 */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import Konva from 'konva';
import {
  Stage, Layer, Group, Image as KImage, Line, Arrow, Text as KText, Rect as KRect, Circle,
  Transformer,
} from 'react-konva';
import { newId } from '@/lib/ids';
import { applyAdjustments } from '@/lib/imageEditAdjust';
import {
  brushCursorSpec, clampCropRect, coverScaleForRotation, resizeCropRect, transformedImageBBox,
  turnedDims, unionRect,
  type CropHandle, type Rect,
} from '@/lib/imageEditGeometry';
import type { AnnotEl, EditorDoc, EditorOp, TextEl } from '@/lib/imageEditElements';
import { adjustedCanvasFontSize } from '@/lib/imageEditFonts';
import { resizeTextInput, textPlacement } from '@/lib/imageEditText';
import {
  imageEditorViewTransform,
  type ImageEditorViewGeometry,
  type ImageEditorViewportController,
} from '@/lib/imageEditorViewport';
import { pinchZoomDelta } from '@/components/canvas/pinchZoomDelta';
import type { ImageRegion } from '@/store/types';
import { useImageRegionDrag } from '@/hooks/useImageRegionDrag';
import { ImageRegionOverlay } from '@/components/node/ImageRegionOverlay';

export type EditorTool = 'select' | 'hand' | 'crop' | 'pen' | 'highlighter' | 'text' | 'arrow';

export interface ImageEditorCanvasHandle {
  /** Bake everything (minus UI chrome) to a full-resolution bitmap. */
  exportBlob(): Promise<{ blob: Blob; width: number; height: number }>;
  clearImageSelection(): boolean;
}

interface Props {
  image: HTMLImageElement;
  doc: EditorDoc;
  tool: EditorTool;
  color: string;
  strokeWidth: number;
  /** Concrete, already-resolved CSS family for NEW text elements. */
  fontFamily: string;
  fontSize: number;
  selectedIds: string[];
  editingTextId: string | null;
  /** A slider gesture is scrubbing → cheap low-res filter cache. */
  lowRes: boolean;
  /** Bumped when a lazily-downloaded font finishes → redraw text. */
  fontTick: number;
  viewportController: ImageEditorViewportController;
  onSelect: (ids: string[]) => void;
  onDispatch: (op: EditorOp, transient?: boolean) => void;
  onGestureEnd: () => void;
  onEditText: (id: string | null) => void;
  onCommitText: (id: string, text: string) => void;
  imageRegions: readonly ImageRegion[];
  onImageRegions: (regions: ImageRegion[]) => void;
  imageSelectionDisabled?: boolean;
}

const MIN_CROP = 32;
const DIM_FILL = 'rgba(17, 17, 17, 0.45)';

/** Konva filter adapter — reads the adjustment attrs off the image node. */
function adjustFilter(this: Konva.Node, imageData: ImageData) {
  applyAdjustments(imageData.data, {
    saturation: (this.getAttr('adjSaturation') as number) ?? 0,
    warmth: (this.getAttr('adjWarmth') as number) ?? 0,
    contrast: (this.getAttr('adjContrast') as number) ?? 0,
    hue: (this.getAttr('adjHue') as number) ?? 0,
  });
}

export const ImageEditorCanvas = forwardRef<ImageEditorCanvasHandle, Props>(
  function ImageEditorCanvas(p, ref) {
    const { image, doc, tool } = p;
    const imgW = image.naturalWidth;
    const imgH = image.naturalHeight;
    const turns = doc.crop.quarterTurns;
    const { w: tw, h: th } = turnedDims(imgW, imgH, turns);
    const frame: Rect = { x: 0, y: 0, width: tw, height: th };
    const cropRect: Rect = doc.crop.rect ?? frame;
    const inCropMode = tool === 'crop';
    const cover = doc.crop.fineAngle
      ? coverScaleForRotation(cropRect, tw, th, doc.crop.fineAngle)
      : 1;
    // What the stage shows: while cropping, the frame PLUS whatever the
    // straighten transform pushed outside it (those parts render dimmed, like
    // the outside-crop area); while annotating, just the cropped view.
    const region: Rect = inCropMode
      ? unionRect(frame, transformedImageBBox(tw, th, cropRect, doc.crop.fineAngle, cover))
      : (doc.crop.rect ?? frame);

    const stageRef = useRef<Konva.Stage>(null);
    const worldRef = useRef<Konva.Group>(null);
    const imgRef = useRef<Konva.Image>(null);
    const uiLayerRef = useRef<Konva.Layer>(null);
    const trRef = useRef<Konva.Transformer | null>(null);
    const wrapRef = useRef<HTMLDivElement>(null);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const panPointerRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
    const view = useSyncExternalStore(
      p.viewportController.subscribe,
      p.viewportController.getSnapshot,
      p.viewportController.getSnapshot,
    );

    // Latest doc for pointer handlers (they fire between renders).
    const docRef = useRef(doc);
    useEffect(() => { docRef.current = doc; });

    // ── Fit the stage to the card ─────────────────────────────────────────
    const [wrap, setWrap] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const measure = () => setWrap({ w: el.clientWidth, h: el.clientHeight });
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      measure();
      return () => ro.disconnect();
    }, []);
    const viewGeometry: ImageEditorViewGeometry = {
      viewportWidth: wrap.w,
      viewportHeight: wrap.h,
      region,
    };
    const viewTransform = imageEditorViewTransform(view, viewGeometry);
    const viewScale = viewTransform.scale;
    useLayoutEffect(() => {
      p.viewportController.configure({
        viewportWidth: wrap.w,
        viewportHeight: wrap.h,
        region: {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        },
      });
    }, [
      p.viewportController,
      wrap.w,
      wrap.h,
      region.x,
      region.y,
      region.width,
      region.height,
    ]);
    useEffect(() => {
      p.viewportController.fit();
    }, [image, p.viewportController]);

    // Wheel and Mac trackpad pinch use the main canvas's exact sensitivity.
    // A native non-passive listener is required to stop browser page zoom.
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        if (wrap.w <= 0 || wrap.h <= 0) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = el.getBoundingClientRect();
        p.viewportController.zoomByWheel(pinchZoomDelta({
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        }), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, [p.viewportController, wrap.w, wrap.h]);

    // ── Adjustment filters (cached bitmap; low-res while scrubbing) ───────
    const adj = doc.adjustments;
    const hasAdjust = !!(adj.saturation || adj.warmth || adj.contrast || adj.hue);
    const hasAdjustRef = useRef(hasAdjust);
    hasAdjustRef.current = hasAdjust;
    const lowResRef = useRef(p.lowRes);
    lowResRef.current = p.lowRes;
    // Re-caching runs the filter over the whole cache bitmap — on big photos
    // that's way too heavy to do per slider EVENT. Coalesce to at most one
    // re-cache per animation frame (the queued frame reads the LATEST attrs,
    // which react-konva has already written to the node), and scrub at a
    // small preview resolution; the gesture-end effect run re-caches sharp.
    const cacheQueuedRef = useRef(0);
    useEffect(() => {
      const n = imgRef.current;
      if (!n) return;
      if (!hasAdjust) {
        n.clearCache();
        n.getLayer()?.batchDraw();
        return;
      }
      if (cacheQueuedRef.current) return;
      cacheQueuedRef.current = requestAnimationFrame(() => {
        cacheQueuedRef.current = 0;
        const node = imgRef.current;
        if (!node || !hasAdjustRef.current) return;
        const maxDim = Math.max(imgW, imgH);
        // The WORKING cache never exceeds ~2560px on the long edge — plenty
        // for the on-screen stage, and it keeps the per-pixel filter pass
        // interactive even on huge photos. Only exportBlob() pays for the
        // true full-resolution filter, as part of saving.
        node.cache({ pixelRatio: Math.min(1, (lowResRef.current ? 1280 : 2560) / maxDim) });
        node.getLayer()?.batchDraw();
      });
    }, [hasAdjust, p.lowRes, adj.saturation, adj.warmth, adj.contrast, adj.hue, image, imgW, imgH]);
    useEffect(() => () => cancelAnimationFrame(cacheQueuedRef.current), []);

    // Redraw once a lazily-downloaded annotation font is ready.
    useEffect(() => { stageRef.current?.batchDraw(); }, [p.fontTick]);

    // CRITICAL cursor detail: Konva writes ITS cursors (plain browser ones)
    // to the stage's inner `content` div, so anything we write only to the
    // outer container loses whenever both are set — the innermost element
    // wins in CSS. We therefore write every custom cursor to BOTH elements;
    // our handlers fire after Konva's on the same events, so on the shared
    // target ours lands last.
    //
    // applyCursor('') does NOT blank the cursor — it restores the active
    // tool's RESTING cursor (baseCursorRef: the brush circle/dot for draw
    // tools, '' → wrap CSS otherwise). Shape unhover handlers (elements,
    // crop handles, transformer anchors) all "clear" on mouseleave; with a
    // draw tool active a literal clear stripped the brush circle the moment
    // the pointer crossed any existing element's hit area, and nothing
    // reapplied it until the next tool switch.
    const baseCursorRef = useRef('');
    const applyCursor = useCallback((value: string) => {
      const stage = stageRef.current;
      if (!stage) return;
      const v = value || baseCursorRef.current;
      stage.container().style.cursor = v;
      stage.content.style.cursor = v;
    }, []);

    // Pen/highlighter/arrow cursor = a circle exactly as wide as the stroke
    // will paint on screen (stroke width × world zoom × view scale), so the
    // cursor previews the line. White halo + dark ring for visibility. Big
    // brushes outgrow the browser's cursor-image cap (oversize cursor URLs are
    // DROPPED, not clamped) — those keep a small center-dot cursor while a
    // Konva ring of the true size follows the pointer (rendered below).
    const effectiveHand = tool === 'hand' || view.spaceHeld;
    const isBrushTool = tool === 'pen' || tool === 'highlighter' || tool === 'arrow';
    const onScreenBrush = Math.round(p.strokeWidth * cover * viewScale);
    const brushSpec = brushCursorSpec(onScreenBrush);
    const circleCursorCss = (d: number) => {
      const c = d / 2;
      const r = Math.max(1.5, c - 2);
      const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='${d}' height='${d}'>` +
        `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='%23ffffff' stroke-width='2.5'/>` +
        `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='%231a1a1a' stroke-width='1.25'/>` +
        `</svg>`;
      return `url("data:image/svg+xml,${svg}") ${Math.floor(c)} ${Math.floor(c)}, crosshair`;
    };
    // Past the cursor-image cap the Konva ring draws the circle instead; the
    // cursor itself shrinks to a filled dot marking the brush center.
    const dotCursorCss = () =>
      `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'>` +
      `<circle cx='6' cy='6' r='3' fill='%231a1a1a' stroke='%23ffffff' stroke-width='1.5'/>` +
      `</svg>") 6 6, crosshair`;
    // Set during render so any event firing between renders restores the
    // right cursor; the effect (re)applies it whenever it changes — and
    // clears it (base '') when leaving the draw tools.
    const baseCursor = effectiveHand
      ? (view.panning ? 'var(--cur-grab)' : 'var(--cur-hand)')
      : !isBrushTool ? ''
      : brushSpec.kind === 'svg' ? circleCursorCss(brushSpec.size)
      : dotCursorCss();
    baseCursorRef.current = baseCursor;
    useEffect(() => { applyCursor(''); }, [baseCursor, applyCursor]);

    // The over-cap brush ring: positioned imperatively per pointer move (a
    // React state write per mousemove would re-render the whole stage).
    const brushRingRef = useRef<Konva.Group>(null);
    const moveBrushRing = () => {
      const g = brushRingRef.current;
      if (!g) return;
      const pos = stageRef.current?.getRelativePointerPosition();
      if (!pos) return;
      g.position(pos);
      g.visible(true);
      g.getLayer()?.batchDraw();
    };
    const hideBrushRing = () => {
      const g = brushRingRef.current;
      if (!g) return;
      g.visible(false);
      g.getLayer()?.batchDraw();
    };

    // Transformer anchors get the same Lucide resize/rotate cursors as the
    // crop handles and node corners. Attached via the ref callback — an
    // on-mount effect would fire BEFORE the stage exists (it renders only
    // once the card is measured), bind to nothing, and never retry.
    const attachAnchorCursors = useCallback((tr: Konva.Transformer | null) => {
      trRef.current = tr;
      if (!tr) return;
      const MAP: Record<string, string> = {
        'top-left': '--cur-scaling-tl',
        'top-right': '--cur-scaling-tr',
        'bottom-left': '--cur-scaling-bl',
        'bottom-right': '--cur-scaling-br',
        'top-center': '--cur-resize-v',
        'bottom-center': '--cur-resize-v',
        'middle-left': '--cur-resize-h',
        'middle-right': '--cur-resize-h',
        rotater: '--cur-rotate',
      };
      // Konva's own mouseout only clears ITS element — clear both of ours
      // too, but never mid-transform (the pointer often slips off the tiny
      // anchor while dragging it).
      let transforming = false;
      tr.off('.curvar');
      tr.on('transformstart.curvar', () => { transforming = true; });
      tr.on('transformend.curvar', () => { transforming = false; applyCursor(''); });
      for (const [name, cssVar] of Object.entries(MAP)) {
        const anchor = tr.findOne(`.${name}`);
        anchor?.off('.curvar');
        // Registered AFTER Konva's own mouseenter/mousedown cursor handlers
        // (which write browser defaults to the content div), so ours land
        // last on the same element.
        for (const ev of ['mouseenter.curvar', 'mousedown.curvar']) {
          anchor?.on(ev, () => applyCursor(`var(${cssVar})`));
        }
        anchor?.on('mouseleave.curvar', () => { if (!transforming) applyCursor(''); });
      }
    }, [applyCursor]);

    // Keep the HIT canvases in sync. Konva refreshes the visible scene on its
    // own, but the mount-time hit graph gets drawn before the stage scale
    // applies (observed live: clicks tested against an unscaled snapshot,
    // breaking element selection entirely). Redraw once now and once after
    // Konva's own scheduled mount draw (double rAF), and again per committed
    // change — cheap, a handful of shapes on a container-sized buffer.
    useEffect(() => {
      // Coalesced to one draw after Konva's own scheduled frame — a hit graph
      // is only consulted between gestures, never mid-stroke.
      let id2 = 0;
      const id1 = requestAnimationFrame(() => {
        id2 = requestAnimationFrame(() => {
          const stage = stageRef.current;
          if (!stage) return;
          for (const layer of stage.getLayers()) layer.draw();
        });
      });
      return () => { cancelAnimationFrame(id1); cancelAnimationFrame(id2); };
    }, [doc, viewScale, tool]);

    // ── Transformer follows the selection (select tool only) ──────────────
    // This must happen before paint. A normal effect left one browser frame
    // where Konva could draw the previous selection rectangle after changing
    // to Pen/Crop/Hand/Text.
    const transformerEligible = tool === 'select'
      && !p.editingTextId
      && p.selectedIds.length > 0;
    useLayoutEffect(() => {
      const tr = trRef.current;
      const stage = stageRef.current;
      if (!tr || !stage) return;
      if (!transformerEligible) {
        tr.nodes([]);
        tr.visible(false);
        tr.getLayer()?.batchDraw();
        return;
      }
      const nodes = p.selectedIds
        .map((id) => stage.findOne(`#${id}`))
        .filter((n): n is Konva.Node => !!n);
      tr.nodes(nodes);
      // A lazy font download can change a text shape's size without changing
      // its selection or document entry; refresh the handles on that tick.
      tr.forceUpdate();
      tr.visible(nodes.length > 0);
      tr.getLayer()?.batchDraw();
    }, [p.selectedIds, transformerEligible, doc.elements, p.fontTick]);

    // ── Pointer interactions ──────────────────────────────────────────────
    // In-flight gesture geometry lives in the refs themselves: pointer events
    // outrun React's render cycle, so reading the element back from the doc
    // would see stale data (a fast flick would finish before any re-render).
    const drawingRef = useRef<{ id: string; tool: 'pen' | 'highlighter' | 'arrow'; points: number[] } | null>(null);
    const textBoxPreviewRef = useRef<Konva.Rect>(null);
    const textDragRef = useRef<{
      pointerId: number; start: { x: number; y: number }; end: { x: number; y: number };
      screenScale: number; fontFamily: string; fontSize: number; color: string;
    } | null>(null);
    const clearTextDrag = useCallback(() => {
      const draft = textDragRef.current;
      textDragRef.current = null;
      textBoxPreviewRef.current?.hide();
      textBoxPreviewRef.current?.getLayer()?.batchDraw();
      const content = stageRef.current?.content;
      if (draft && content?.hasPointerCapture(draft.pointerId)) content.releasePointerCapture(draft.pointerId);
      return !!draft;
    }, []);
    const cropDragRef = useRef<
      | { kind: 'handle'; handle: CropHandle; rect: Rect }
      | { kind: 'move'; rect: Rect }
      | null
    >(null);
    const lastCropPos = useRef<{ x: number; y: number } | null>(null);

    const worldPos = () => worldRef.current?.getRelativePointerPosition() ?? null;
    const stagePos = () => stageRef.current?.getRelativePointerPosition() ?? null;

    const onStagePointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (e.evt.button !== 0 || textDragRef.current) return;
      if (p.editingTextId) return; // the textarea commits itself via blur
      if (inCropMode) return;      // the crop chrome has its own handlers
      if (effectiveHand) return;   // wrapper capture owns view panning
      const pos = worldPos();
      if (!pos) return;
      if (tool === 'pen' || tool === 'highlighter') {
        const id = newId();
        p.onDispatch({
          kind: 'addElement',
          el: {
            id, tool, points: [pos.x, pos.y], strokeWidth: p.strokeWidth, color: p.color,
            x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
          },
        }, true);
        drawingRef.current = { id, tool, points: [pos.x, pos.y] };
      } else if (tool === 'arrow') {
        const id = newId();
        p.onDispatch({
          kind: 'addElement',
          el: {
            id, tool: 'arrow', points: [pos.x, pos.y, pos.x, pos.y],
            strokeWidth: p.strokeWidth, color: p.color,
            x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
          },
        }, true);
        drawingRef.current = { id, tool: 'arrow', points: [pos.x, pos.y, pos.x, pos.y] };
      } else if (tool === 'text') {
        // CRITICAL: a real (trusted) mousedown's default action moves focus to
        // the clicked element — blurring the just-focused textarea, whose
        // blur-commit then deletes the empty text element ("nothing happens").
        // Synthetic events skip that default, which is why only live clicks
        // ever showed the bug. preventDefault keeps focus where we put it.
        e.evt.preventDefault();
        // Clicking an EXISTING text with the text tool edits it in place.
        const hit = e.target;
        if (hit instanceof Konva.Text && hit.id()) {
          p.onSelect([hit.id()]);
          p.onEditText(hit.id());
          return;
        }
        // Wait for release to distinguish point text from paragraph text.
        // Nothing enters document/history until the placement is complete.
        textDragRef.current = {
          pointerId: e.evt.pointerId, start: pos, end: pos, screenScale: viewScale * cover,
          fontFamily: p.fontFamily, fontSize: p.fontSize, color: p.color,
        };
        stageRef.current?.content.setPointerCapture(e.evt.pointerId);
      } else if (tool === 'select') {
        if (e.target === e.target.getStage() || e.target === imgRef.current) p.onSelect([]);
      }
    };

    const onStagePointerMove = () => {
      moveBrushRing();
      const textDraft = textDragRef.current;
      if (textDraft) {
        const pos = worldPos();
        if (!pos) return;
        textDraft.end = pos;
        const placement = textPlacement(textDraft.start, pos, textDraft.screenScale, textDraft.fontSize);
        textBoxPreviewRef.current?.setAttrs({
          ...placement, height: placement.minHeight ?? 0, visible: placement.width !== undefined,
        });
        textBoxPreviewRef.current?.getLayer()?.batchDraw();
        return;
      }
      const cd = cropDragRef.current;
      if (cd) {
        const pos = stagePos();
        if (!pos) return;
        const last = lastCropPos.current ?? pos;
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;
        lastCropPos.current = pos;
        const minSize = Math.min(MIN_CROP, tw, th);
        const next = cd.kind === 'handle'
          ? resizeCropRect(cd.rect, cd.handle, dx, dy, tw, th, minSize)
          : clampCropRect({ ...cd.rect, x: cd.rect.x + dx, y: cd.rect.y + dy }, tw, th, minSize);
        cd.rect = next;
        p.onDispatch({ kind: 'setCrop', patch: { rect: next } }, true);
        return;
      }
      const d = drawingRef.current;
      if (!d) return;
      const pos = worldPos();
      if (!pos) return;
      if (d.tool === 'arrow') {
        d.points = [d.points[0]!, d.points[1]!, pos.x, pos.y];
      } else {
        d.points = [...d.points, pos.x, pos.y];
      }
      p.onDispatch({ kind: 'updateElement', id: d.id, patch: { points: d.points } }, true);
    };

    const endPointer = useCallback((event: PointerEvent) => {
      const textDraft = textDragRef.current;
      if (textDraft) {
        if (textDraft.pointerId !== event.pointerId) return;
        // Include the final position even if no move rendered before release,
        // or if release happened outside the image.
        stageRef.current?.setPointersPositions(event);
        const end = worldRef.current?.getRelativePointerPosition() ?? textDraft.end;
        clearTextDrag();
        const id = newId();
        p.onDispatch({ kind: 'addElement', el: {
          id, tool: 'text', text: '', fontFamily: textDraft.fontFamily, fontSize: textDraft.fontSize,
          color: textDraft.color, rotation: 0, scaleX: 1, scaleY: 1,
          ...textPlacement(textDraft.start, end, textDraft.screenScale, textDraft.fontSize),
        } }, true);
        p.onSelect([id]);
        p.onEditText(id);
        // Placement + typing is one undo entry, committed by the text editor.
        return;
      }
      if (cropDragRef.current) {
        cropDragRef.current = null;
        lastCropPos.current = null;
        setCursor(null);
        p.onGestureEnd();
        return;
      }
      const d = drawingRef.current;
      if (!d) return;
      drawingRef.current = null;
      if (d.tool === 'arrow') {
        const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = d.points;
        // An accidental click (no drag) leaves a zero-length arrow — void the
        // gesture instead of committing it.
        if (Math.hypot(x1 - x0, y1 - y0) < 3) {
          p.onDispatch({ kind: 'removeElements', ids: [d.id] }, true);
        }
      }
      p.onGestureEnd();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.onGestureEnd, p.onDispatch, p.onSelect, p.onEditText, clearTextDrag]);

    // Gestures end even when the pointer is released off-canvas.
    useEffect(() => {
      window.addEventListener('pointerup', endPointer);
      window.addEventListener('pointercancel', clearTextDrag);
      window.addEventListener('blur', clearTextDrag);
      return () => {
        window.removeEventListener('pointerup', endPointer);
        window.removeEventListener('pointercancel', clearTextDrag);
        window.removeEventListener('blur', clearTextDrag);
      };
    }, [endPointer, clearTextDrag]);
    useEffect(() => { if (tool !== 'text' || effectiveHand) clearTextDrag(); }, [tool, effectiveHand, clearTextDrag]);

    // ── Element handlers (select tool) ────────────────────────────────────
    const selectEl = (el: AnnotEl) => (e: Konva.KonvaEventObject<PointerEvent>) => {
      if (tool !== 'select') return;
      e.cancelBubble = true;
      const add = e.evt.shiftKey;
      p.onSelect(add ? Array.from(new Set([...p.selectedIds, el.id])) : [el.id]);
    };
    // Movable elements advertise it: the Lucide "move" cursor on hover and
    // throughout the drag (mouseleave fires mid-drag, so track the drag).
    const draggingElRef = useRef(false);
    const hoverEl = () => { if (tool === 'select' && !p.editingTextId) setCursor('--cur-move'); };
    const unhoverEl = () => { if (!draggingElRef.current) setCursor(null); };
    const dragStart = () => { draggingElRef.current = true; setCursor('--cur-move'); };
    const dragEnd = (el: AnnotEl) => (e: Konva.KonvaEventObject<DragEvent>) => {
      draggingElRef.current = false;
      setCursor(null);
      p.onDispatch({ kind: 'updateElement', id: el.id, patch: { x: e.target.x(), y: e.target.y() } });
    };
    const transformEnd = (el: AnnotEl) => (e: Konva.KonvaEventObject<Event>) => {
      const n = e.target;
      p.onDispatch({
        kind: 'updateElement', id: el.id,
        patch: { x: n.x(), y: n.y(), rotation: n.rotation(), scaleX: n.scaleX(), scaleY: n.scaleY() },
      });
    };

    // ── Inline text editing (the classic Konva floating-textarea pattern) ─
    const editingEl = p.editingTextId
      ? (doc.elements.find((el) => el.id === p.editingTextId) as TextEl | undefined)
      : undefined;
    // Use Konva's own wrapping metrics so selection/export and the live editor
    // agree. A paragraph box grows vertically if its text exceeds the drag.
    const textBoxHeights = useMemo(() => {
      const heights = new Map<string, number>();
      for (const el of doc.elements) {
        if (el.tool !== 'text' || el.minHeight === undefined) continue;
        const measure = new Konva.Text({
          text: el.text, width: el.width, fontFamily: el.fontFamily,
          fontSize: adjustedCanvasFontSize(el.fontSize, el.fontFamily),
        });
        heights.set(el.id, Math.max(el.minHeight, measure.height()));
        measure.destroy();
      }
      return heights;
    }, [doc.elements, p.fontTick]);
    const [taStyle, setTaStyle] = useState<CSSProperties | null>(null);
    useLayoutEffect(() => {
      if (!p.editingTextId) { setTaStyle(null); return; }
      const stage = stageRef.current;
      const n = stage?.findOne(`#${p.editingTextId}`) as Konva.Text | undefined;
      if (!stage || !n) { setTaStyle(null); return; }
      const abs = n.absolutePosition();
      const scale = n.getAbsoluteScale();
      setTaStyle({
        left: abs.x,
        top: abs.y,
        fontFamily: n.fontFamily(),
        color: n.fill() as string,
        width: editingEl?.width ?? Math.max(n.width(), n.fontSize() * 3),
        minHeight: editingEl?.minHeight ?? n.fontSize(),
        fontSize: n.fontSize(),
        transform: `rotate(${n.getAbsoluteRotation()}deg) scale(${scale.x}, ${scale.y})`,
        lineHeight: String(n.lineHeight()),
      });
      // Font/size deps: picking a font or size mid-edit restyles the floating
      // field live — and the fresh taStyle re-focuses it (effect below), so
      // editing continues seamlessly after using the dropdowns.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [p.editingTextId, viewScale, viewTransform.x, viewTransform.y, editingEl?.fontFamily, editingEl?.fontSize, editingEl?.width, editingEl?.minHeight, p.fontTick]);

    // Focus + size the field once it actually exists in the DOM (an rAF from
    // the effect above can fire before React commits the textarea).
    useLayoutEffect(() => {
      const ta = taRef.current;
      if (!ta || !taStyle) return;
      ta.focus();
      resizeTextInput(ta, editingEl?.width !== undefined, Number(taStyle.width), Number(taStyle.minHeight));
    }, [taStyle, editingEl?.width]);

    const commitTa = () => {
      const id = p.editingTextId;
      if (!id) return;
      p.onCommitText(id, taRef.current?.value ?? '');
    };

    // ── Export ────────────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      clearImageSelection: () => clearTextDrag() || imageSelection.clearSelection(),
      async exportBlob() {
        const stage = stageRef.current;
        if (!stage) throw new Error('Editor stage is gone');
        const cur = docRef.current;
        // The save path has just awaited font downloads. Refresh Konva's
        // derived text sizes synchronously before its synchronous bitmap draw,
        // even if React has not painted the font-load tick yet.
        for (const el of cur.elements) {
          if (el.tool !== 'text') continue;
          const textNode = stage.findOne(`#${el.id}`) as Konva.Text | undefined;
          textNode?.fontSize(adjustedCanvasFontSize(el.fontSize, el.fontFamily));
          if (textNode && el.minHeight !== undefined) {
            textNode.setAttr('height', 'auto');
            textNode.height(Math.max(el.minHeight, textNode.height()));
          }
        }
        const curTurns = cur.crop.quarterTurns;
        const dims = turnedDims(imgW, imgH, curTurns);
        const rect = cur.crop.rect ?? { x: 0, y: 0, width: dims.w, height: dims.h };
        const exportPR = Math.min(1, 8192 / Math.max(rect.width, rect.height));

        const imgNode = imgRef.current;
        if (hasAdjustRef.current && imgNode) {
          // The one true full-resolution filter pass, paid only when saving.
          imgNode.cache({ pixelRatio: Math.min(1, 8192 / Math.max(imgW, imgH)) });
        }
        const tr = trRef.current;
        const prevTrNodes = tr?.nodes() ?? [];
        const prevScale = stage.scale();
        const prevPos = stage.position();
        const prevSize = stage.size();
        // Konva renders the export bitmap SYNCHRONOUSLY inside toBlob (only
        // the encode is async), so the stage state is restored the moment the
        // call returns — nothing off-state is ever painted (no save flicker).
        const grab = (mimeType: string) => {
          tr?.nodes([]);
          uiLayerRef.current?.visible(false);
          stage.scale({ x: 1, y: 1 });
          stage.position({ x: 0, y: 0 });
          stage.size({ width: dims.w, height: dims.h });
          try {
            return new Promise<Blob | null>((resolve) => {
              (stage as unknown as { toBlob(cfg: object): void }).toBlob({
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                pixelRatio: exportPR,
                mimeType,
                quality: 0.92,
                callback: resolve,
              });
            });
          } finally {
            stage.scale(prevScale);
            stage.position(prevPos);
            stage.size(prevSize);
            uiLayerRef.current?.visible(true);
            tr?.nodes(prevTrNodes);
            stage.batchDraw();
          }
        };
        // Safari can't encode webp — it silently hands back PNG; the real
        // format travels in blob.type either way. (No post-export re-cache:
        // saving moves to the freshly-baked version, which resets the doc.)
        const blob = (await grab('image/webp')) ?? (await grab('image/png'));
        if (!blob) throw new Error('The browser refused to export this image.');
        return {
          blob,
          width: Math.round(rect.width * exportPR),
          height: Math.round(rect.height * exportPR),
        };
      },
    }), [imgW, imgH]);

    // ── Derived transforms ────────────────────────────────────────────────
    const ccx = cropRect.x + cropRect.width / 2;
    const ccy = cropRect.y + cropRect.height / 2;
    // 90°-turn placement of the natural-orientation bitmap in turned space.
    const place = [
      { x: 0, y: 0, rotation: 0 },
      { x: tw, y: 0, rotation: 90 },
      { x: tw, y: th, rotation: 180 },
      { x: 0, y: th, rotation: 270 },
    ][turns]!;

    const handleSize = viewScale > 0 ? 14 / viewScale : 14;
    const cropHandles: { k: CropHandle; x: number; y: number }[] = [
      { k: 'nw', x: cropRect.x, y: cropRect.y },
      { k: 'n', x: cropRect.x + cropRect.width / 2, y: cropRect.y },
      { k: 'ne', x: cropRect.x + cropRect.width, y: cropRect.y },
      { k: 'e', x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height / 2 },
      { k: 'se', x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height },
      { k: 's', x: cropRect.x + cropRect.width / 2, y: cropRect.y + cropRect.height },
      { k: 'sw', x: cropRect.x, y: cropRect.y + cropRect.height },
      { k: 'w', x: cropRect.x, y: cropRect.y + cropRect.height / 2 },
    ];

    // Inline cursor override for the stage (a <canvas> can't carry per-shape
    // CSS) — the Lucide cursor vars from cursors.css, written via applyCursor
    // so they land on the same element Konva's own cursor writes target.
    const setCursor = useCallback((cssVar: string | null) => {
      applyCursor(cssVar ? `var(${cssVar})` : '');
    }, [applyCursor]);
    const HANDLE_CURSOR: Record<CropHandle, string> = {
      nw: '--cur-scaling-tl', ne: '--cur-scaling-tr', se: '--cur-scaling-br', sw: '--cur-scaling-bl',
      n: '--cur-resize-v', s: '--cur-resize-v', e: '--cur-resize-h', w: '--cur-resize-h',
    };

    const beginCropDrag = (drag: { kind: 'handle'; handle: CropHandle } | { kind: 'move' }) =>
      (e: Konva.KonvaEventObject<PointerEvent>) => {
        e.cancelBubble = true;
        const rect = docRef.current.crop.rect ?? { x: 0, y: 0, width: tw, height: th };
        cropDragRef.current = { ...drag, rect };
        lastCropPos.current = stagePos();
        setCursor(drag.kind === 'move' ? '--cur-move' : HANDLE_CURSOR[drag.handle]);
      };

    const draggable = tool === 'select' && !p.editingTextId;

    const imageSelection = useImageRegionDrag({
      enabled: tool === 'select' && !effectiveHand && !p.editingTextId && !p.imageSelectionDisabled,
      regions: p.imageRegions,
      bounds: () => {
        const rect = wrapRef.current?.getBoundingClientRect();
        return rect ? { left: rect.left + viewTransform.x + region.x * viewScale,
          top: rect.top + viewTransform.y + region.y * viewScale,
          width: region.width * viewScale, height: region.height * viewScale } : null;
      },
      canStart: (event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey) return true;
        const rect = wrapRef.current?.getBoundingClientRect();
        const hit = rect ? stageRef.current?.getIntersection({ x: event.clientX - rect.left, y: event.clientY - rect.top }) : null;
        // Existing annotations keep normal pointer-tool dragging. Shift (or
        // additive Ctrl/Command) deliberately selects image pixels over them.
        return !hit || hit === imgRef.current;
      },
      onStart: () => p.onSelect([]),
      onClick: () => p.onSelect([]),
      onChange: p.onImageRegions,
    });

    // Pan in capture phase so Hand / Space / middle-button gestures never
    // reach Konva's annotation, crop, or drawing handlers beneath us.
    const beginViewPan = (e: ReactPointerEvent<HTMLDivElement>) => {
      if (p.editingTextId || (!effectiveHand && e.button !== 1)) return;
      e.preventDefault();
      e.stopPropagation();
      panPointerRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      p.viewportController.setPanning(true);
    };
    const moveViewPan = (e: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = panPointerRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const dx = e.clientX - gesture.x;
      const dy = e.clientY - gesture.y;
      gesture.x = e.clientX;
      gesture.y = e.clientY;
      p.viewportController.panBy(dx, dy);
    };
    const endViewPan = (e: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = panPointerRef.current;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      panPointerRef.current = null;
      p.viewportController.setPanning(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    };

    return (
      <div
        ref={wrapRef}
        className={`ie-canvas-wrap is-${tool}${effectiveHand ? ' is-hand' : ''}${view.panning ? ' is-panning' : ''}`}
        onPointerDownCapture={(event) => {
          if (effectiveHand || event.button === 1) beginViewPan(event);
          else imageSelection.handlers.onPointerDownCapture(event);
        }}
        onPointerMoveCapture={(event) => {
          if (panPointerRef.current) moveViewPan(event);
          else imageSelection.handlers.onPointerMoveCapture(event);
        }}
        onPointerUpCapture={(event) => {
          if (panPointerRef.current) endViewPan(event);
          else imageSelection.handlers.onPointerUpCapture(event);
        }}
        onPointerCancelCapture={(event) => {
          if (panPointerRef.current) endViewPan(event);
          else imageSelection.handlers.onPointerCancelCapture(event);
        }}
        onClickCapture={imageSelection.handlers.onClickCapture}
        onLostPointerCapture={() => {
          clearTextDrag();
          imageSelection.handlers.onLostPointerCapture();
          if (!panPointerRef.current) return;
          panPointerRef.current = null;
          p.viewportController.setPanning(false);
        }}
      >
        {viewScale > 0 && (
          <div
            className="ie-stage-holder"
            style={{ width: wrap.w, height: wrap.h }}
          >
            {/* Display backing only: stays outside Konva, so transparent pixels
                remain transparent in saved/exported image files. */}
            <div className="ie-image-background" aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none',
              left: viewTransform.x + region.x * viewScale, top: viewTransform.y + region.y * viewScale,
              width: region.width * viewScale, height: region.height * viewScale, background: '#fff' }} />
            <Stage
              ref={stageRef}
              width={wrap.w}
              height={wrap.h}
              scaleX={viewScale}
              scaleY={viewScale}
              x={viewTransform.x}
              y={viewTransform.y}
              onPointerDown={onStagePointerDown}
              onPointerMove={onStagePointerMove}
              onMouseLeave={hideBrushRing}
            >
              <Layer
                clipX={region.x}
                clipY={region.y}
                clipWidth={region.width}
                clipHeight={region.height}
              >
                <Group
                  ref={worldRef}
                  x={ccx}
                  y={ccy}
                  offsetX={ccx}
                  offsetY={ccy}
                  rotation={doc.crop.fineAngle}
                  scaleX={cover}
                  scaleY={cover}
                >
                  <KImage
                    ref={imgRef}
                    image={image}
                    x={place.x}
                    y={place.y}
                    rotation={place.rotation}
                    width={imgW}
                    height={imgH}
                    filters={hasAdjust ? [adjustFilter] : undefined}
                    adjSaturation={adj.saturation}
                    adjWarmth={adj.warmth}
                    adjContrast={adj.contrast}
                    adjHue={adj.hue}
                  />
                  {doc.elements.map((el) => {
                    const common = {
                      id: el.id,
                      x: el.x,
                      y: el.y,
                      rotation: el.rotation,
                      scaleX: el.scaleX,
                      scaleY: el.scaleY,
                      draggable,
                      onPointerDown: selectEl(el),
                      onMouseEnter: hoverEl,
                      onMouseLeave: unhoverEl,
                      onDragStart: dragStart,
                      onDragEnd: dragEnd(el),
                      onTransformEnd: transformEnd(el),
                    };
                    if (el.tool === 'text') {
                      return (
                        <KText
                          key={el.id}
                          {...common}
                          text={el.text}
                          fontFamily={el.fontFamily}
                          fontSize={adjustedCanvasFontSize(el.fontSize, el.fontFamily)}
                          fill={el.color}
                          width={el.width}
                          height={textBoxHeights.get(el.id)}
                          visible={p.editingTextId !== el.id}
                          onDblClick={() => { p.onSelect([el.id]); p.onEditText(el.id); }}
                          onDblTap={() => { p.onSelect([el.id]); p.onEditText(el.id); }}
                        />
                      );
                    }
                    if (el.tool === 'arrow') {
                      return (
                        <Arrow
                          key={el.id}
                          {...common}
                          points={el.points}
                          stroke={el.color}
                          fill={el.color}
                          strokeWidth={el.strokeWidth}
                          pointerLength={6 + el.strokeWidth * 2.5}
                          pointerWidth={6 + el.strokeWidth * 2.5}
                          lineCap="round"
                          lineJoin="round"
                          hitStrokeWidth={Math.max(el.strokeWidth + 14, 32 / viewScale)}
                        />
                      );
                    }
                    const hl = el.tool === 'highlighter';
                    return (
                      <Line
                        key={el.id}
                        {...common}
                        points={el.points}
                        stroke={el.color}
                        strokeWidth={el.strokeWidth}
                        opacity={hl ? 0.45 : 1}
                        globalCompositeOperation={hl ? 'multiply' : 'source-over'}
                        lineCap="round"
                        lineJoin="round"
                        tension={0.4}
                        hitStrokeWidth={Math.max(el.strokeWidth + 14, 32 / viewScale)}
                      />
                    );
                  })}
                </Group>
              </Layer>
              <Layer ref={uiLayerRef}>
                {tool === 'text' && (
                  <Group x={ccx} y={ccy} offsetX={ccx} offsetY={ccy}
                    rotation={doc.crop.fineAngle} scaleX={cover} scaleY={cover}>
                    <KRect ref={textBoxPreviewRef} visible={false} listening={false}
                      stroke={p.color} strokeWidth={1 / (viewScale * cover)}
                      dash={[4 / (viewScale * cover), 3 / (viewScale * cover)]} />
                  </Group>
                )}
                {inCropMode && (
                  <>
                    <KRect x={region.x} y={region.y} width={region.width} height={Math.max(0, cropRect.y - region.y)} fill={DIM_FILL} listening={false} />
                    <KRect x={region.x} y={cropRect.y + cropRect.height} width={region.width} height={Math.max(0, region.y + region.height - cropRect.y - cropRect.height)} fill={DIM_FILL} listening={false} />
                    <KRect x={region.x} y={cropRect.y} width={Math.max(0, cropRect.x - region.x)} height={cropRect.height} fill={DIM_FILL} listening={false} />
                    <KRect x={cropRect.x + cropRect.width} y={cropRect.y} width={Math.max(0, region.x + region.width - cropRect.x - cropRect.width)} height={cropRect.height} fill={DIM_FILL} listening={false} />
                    <KRect
                      x={cropRect.x}
                      y={cropRect.y}
                      width={cropRect.width}
                      height={cropRect.height}
                      fill="rgba(0,0,0,0.001)"
                      onPointerDown={beginCropDrag({ kind: 'move' })}
                    />
                    <KRect
                      x={cropRect.x}
                      y={cropRect.y}
                      width={cropRect.width}
                      height={cropRect.height}
                      stroke="#ffffff"
                      strokeWidth={2 / viewScale}
                      listening={false}
                      shadowColor="rgba(0,0,0,0.6)"
                      shadowBlur={3 / viewScale}
                    />
                    {cropHandles.map((h) => (
                      <KRect
                        key={h.k}
                        x={h.x - handleSize / 2}
                        y={h.y - handleSize / 2}
                        width={handleSize}
                        height={handleSize}
                        fill="#ffffff"
                        stroke="rgba(0,0,0,0.55)"
                        strokeWidth={1 / viewScale}
                        cornerRadius={3 / viewScale}
                        hitStrokeWidth={16 / viewScale}
                        onPointerDown={beginCropDrag({ kind: 'handle', handle: h.k })}
                        onMouseEnter={() => setCursor(HANDLE_CURSOR[h.k])}
                        onMouseLeave={() => { if (!cropDragRef.current) setCursor(null); }}
                      />
                    ))}
                  </>
                )}
                {/* No ignoreStroke: for drawn strokes the stroke IS the
                    visible body — ignoring it framed only the centerline
                    skeleton, comically small around fat brushes. */}
                <Transformer
                  ref={attachAnchorCursors}
                  visible={transformerEligible}
                  listening={transformerEligible}
                  rotateEnabled
                  keepRatio={false}
                  anchorSize={10 / viewScale}
                  borderStrokeWidth={1 / viewScale}
                  borderDash={[4 / viewScale, 3 / viewScale]}
                  rotateAnchorOffset={50 / viewScale}
                />
                {isBrushTool && brushSpec.kind === 'ring' && (
                  // True-size preview for brushes too big for a cursor image;
                  // hidden until the pointer reports a position. Same white
                  // halo + dark ring as the cursor, at constant screen width.
                  <Group ref={brushRingRef} listening={false} visible={false}>
                    <Circle radius={brushSpec.diameter / 2 / viewScale} stroke="#ffffff" strokeWidth={2.5 / viewScale} />
                    <Circle radius={brushSpec.diameter / 2 / viewScale} stroke="#1a1a1a" strokeWidth={1.25 / viewScale} />
                  </Group>
                )}
              </Layer>
            </Stage>
            {!inCropMode && <ImageRegionOverlay regions={imageSelection.displayedRegions} style={{
              left: viewTransform.x + region.x * viewScale, top: viewTransform.y + region.y * viewScale,
              width: region.width * viewScale, height: region.height * viewScale,
            }} />}
            {editingEl && taStyle && (
              <textarea
                key={editingEl.id}
                ref={taRef}
                className={`ie-text-input${editingEl.width === undefined ? '' : ' is-boxed'}`}
                aria-label="Text annotation"
                wrap={editingEl.width === undefined ? 'off' : 'soft'}
                style={taStyle}
                defaultValue={editingEl.text}
                rows={1}
                autoFocus
                spellCheck={false}
                onInput={(e) => {
                  resizeTextInput(e.currentTarget, editingEl.width !== undefined, Number(taStyle.width), Number(taStyle.minHeight));
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.nativeEvent.isComposing) return;
                  if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
                    e.preventDefault();
                    commitTa();
                  }
                }}
                onBlur={(e) => {
                  // Focus moving to the font/size dropdowns is part of the
                  // editing workflow, not the end of it — the pick restyles
                  // this element and focus returns here automatically.
                  const rt = e.relatedTarget as HTMLElement | null;
                  if (rt?.closest('.ie-font-row')) return;
                  commitTa();
                }}
              />
            )}
          </div>
        )}
      </div>
    );
  },
);
