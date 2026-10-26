'use client';
import { registerScreenshotRenderer } from '@/lib/screenshotRenderers';
import { useEffect, useRef } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { computeNodesBBox } from '@/lib/nodesBounds';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { resolveColorHex } from '@/lib/groupColor';
import { hitTestRects } from '@/lib/minimapHit';
import { minimapSkeleton } from '@/lib/minimapSkeleton';

const MINIMAP_H = 124;
// Default sidebar tip; hovering a node swaps it for the node's header
// (AppTooltips live-watches data-tip mutations, so no store round-trip).
const DEFAULT_TIP = 'Click or drag to pan the camera';

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Point on a rect's border along the ray from its center toward (tx, ty). */
function rectEdgePoint(cx: number, cy: number, rx: number, ry: number, rw: number, rh: number, tx: number, ty: number) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (rx + rw - cx) / dx);
  else if (dx < 0) t = Math.min(t, (rx - cx) / dx);
  if (dy > 0) t = Math.min(t, (ry + rh - cy) / dy);
  else if (dy < 0) t = Math.min(t, (ry - cy) / dy);
  if (!Number.isFinite(t) || t < 0) return { x: cx, y: cy };
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Does the segment pass through the rect's interior? (sampled). */
function segmentHitsRect(x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) {
  const N = 8;
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const px = x0 + (x1 - x0) * t;
    const py = y0 + (y1 - y0) * t;
    if (px >= rx && px <= rx + rw && py >= ry && py <= ry + rh) return true;
  }
  return false;
}

/**
 * Sidebar minimap — a 2D-canvas overview of the whole project, just above the
 * model picker / footer nav. Shows every node (translucent, group-tinted, with a
 * skeleton "text" hint), the parent→child connection arrows, and the current
 * camera viewport rectangle; click/drag pans the camera (zoom unchanged).
 *
 * Always mounted (in the sidebar) and must track physics, so it paints on a
 * <canvas> redrawn via coalesced rAF on vanilla store subscriptions — never
 * per-tick React reconciliation (which PERF R2–R4 removed). Idle = no work.
 */
export function Minimap() {
  const hasNodes = useGraphStore((s) => !!s.project && Object.keys(s.project.nodes).length > 0);
  if (!hasNodes) return null;
  return <MinimapCanvas />;
}

interface Rect { x: number; y: number; w: number; h: number; id: string }

function MinimapCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  // Latest layout geometry from the last draw, reused by pointer→world mapping.
  const geomRef = useRef({ minX: 0, minY: 0, scale: 1, offX: 0, offY: 0, cw: 1, ch: 1 });
  // Node rects from the last draw (draw order), for pointer hover hit-testing.
  const rectsRef = useRef<Rect[]>([]);
  const hoveredIdRef = useRef<string | null>(null);
  // Lets pointer handlers request a repaint (assigned inside the draw effect).
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let cssW = canvas.clientWidth;
    let cssH = MINIMAP_H;

    const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const draw = () => {
      raf = 0;
      const project = useGraphStore.getState().project;
      if (!project) { rectsRef.current = []; return; }
      const positions = useLivePositionsStore.getState().positions;
      const bbox = computeNodesBBox(project, positions);
      ctx.clearRect(0, 0, cssW, cssH);
      if (!bbox) { rectsRef.current = []; return; }

      const host = document.querySelector('.canvas-host') as HTMLElement | null;
      const cw = host?.clientWidth ?? window.innerWidth;
      const ch = host?.clientHeight ?? window.innerHeight;
      const vp = useLiveViewportStore.getState();

      // Extent = node bbox + 6% padding. NOT unioned with the viewport, so the
      // viewport rect keeps a fixed size and clamps at the edges rather than
      // rescaling the whole map.
      const padX = (bbox.maxX - bbox.minX) * 0.06 || 1;
      const padY = (bbox.maxY - bbox.minY) * 0.06 || 1;
      const minX = bbox.minX - padX, maxX = bbox.maxX + padX;
      const minY = bbox.minY - padY, maxY = bbox.maxY + padY;
      const extW = maxX - minX, extH = maxY - minY;
      const scale = Math.min(cssW / extW, cssH / extH);
      const offX = (cssW - extW * scale) / 2;
      const offY = (cssH - extH * scale) / 2;
      geomRef.current = { minX, minY, scale, offX, offY, cw, ch };
      const lx = (wx: number) => offX + (wx - minX) * scale;
      const ly = (wy: number) => offY + (wy - minY) * scale;

      const neutral = cssVar('--overlay0') || '#9ca0b0';
      const grey = cssVar('--overlay1') || '#8c8fa1';

      // Node rects in minimap coords (shared by arrows + node drawing).
      const rects: Record<string, Rect> = {};
      for (const n of Object.values(project.nodes)) {
        const lp = positions[n.id];
        rects[n.id] = {
          id: n.id,
          x: lx(lp?.x ?? n.position.x),
          y: ly(lp?.y ?? n.position.y),
          w: Math.max(2, nodeWidth(n) * scale),
          h: Math.max(2, nodeRenderedH(n) * scale),
        };
      }
      const rectList = Object.values(rects);
      rectsRef.current = rectList;

      // 1) Arrows — behind the nodes, edge-to-edge, with a small head. They fade
      //    when they'd cross a third node (and are dimmed by the translucent
      //    nodes drawn on top), giving a gentle "behind the nodes" look.
      ctx.strokeStyle = grey;
      ctx.fillStyle = grey;
      ctx.lineWidth = 1;
      for (const a of Object.values(project.arrows)) {
        const A = rects[a.fromNodeId], B = rects[a.toNodeId];
        if (!A || !B) continue;
        const acx = A.x + A.w / 2, acy = A.y + A.h / 2;
        const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
        const p0 = rectEdgePoint(acx, acy, A.x, A.y, A.w, A.h, bcx, bcy);
        const p1 = rectEdgePoint(bcx, bcy, B.x, B.y, B.w, B.h, acx, acy);
        let crosses = false;
        for (const r of rectList) {
          if (r.id === a.fromNodeId || r.id === a.toNodeId) continue;
          if (segmentHitsRect(p0.x, p0.y, p1.x, p1.y, r.x, r.y, r.w, r.h)) { crosses = true; break; }
        }
        ctx.globalAlpha = crosses ? 0.12 : 0.32;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
        // Arrowhead at the child edge, pointing along the line.
        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const hl = 4, hw = 0.5;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p1.x - hl * Math.cos(ang - hw), p1.y - hl * Math.sin(ang - hw));
        ctx.lineTo(p1.x - hl * Math.cos(ang + hw), p1.y - hl * Math.sin(ang + hw));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 2) Nodes — translucent fill + skeleton "text" + slim border.
      for (const n of Object.values(project.nodes)) {
        const r = rects[n.id];
        if (!r) continue;
        const gid = n.groupId;
        // Grouped → group color; ungrouped/root → project base color; neutral
        // grey only on legacy color-less data. (Arrows above stay grey by design.)
        const color = gid && project.groups[gid]
          ? resolveColorHex(project.groups[gid]!.color)
          : project.color ? resolveColorHex(project.color) : neutral;
        const rad = Math.min(2.5, r.w / 3, r.h / 3);

        roundRectPath(ctx, r.x, r.y, r.w, r.h, rad);
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = color;
        ctx.fill();

        // Type-specific overview marks, with fixed screen-pixel line weights.
        for (const mark of minimapSkeleton(n, r.w, r.h)) {
          ctx.fillStyle = color;
          ctx.globalAlpha = mark.alpha;
          roundRectPath(ctx, r.x + mark.x, r.y + mark.y, mark.w, mark.h, Math.min(1, mark.h / 2));
          ctx.fill();
        }

        roundRectPath(ctx, r.x, r.y, r.w, r.h, rad);
        const hovered = hoveredIdRef.current === n.id;
        ctx.globalAlpha = hovered ? 1 : 0.8;
        ctx.lineWidth = hovered ? 1.5 : 1;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // 3) Viewport rect — light grey, rounded to match the minimap, clamped.
      const vLeft = lx(-vp.x / vp.zoom);
      const vTop = ly(-vp.y / vp.zoom);
      const vRight = vLeft + (cw / vp.zoom) * scale;
      const vBottom = vTop + (ch / vp.zoom) * scale;
      const cx0 = Math.max(0, vLeft), cy0 = Math.max(0, vTop);
      const cx1 = Math.min(cssW, vRight), cy1 = Math.min(cssH, vBottom);
      if (cx1 > cx0 && cy1 > cy0) {
        const rmd = parseFloat(cssVar('--r-md')) || 6;
        ctx.strokeStyle = grey;
        ctx.lineWidth = 1;
        roundRectPath(ctx, cx0 + 0.5, cy0 + 0.5, cx1 - cx0 - 1, cy1 - cy0 - 1, rmd);
        ctx.stroke();
      }
    };

    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    scheduleRef.current = schedule;

    const resize = () => {
      cssW = canvas.clientWidth;
      cssH = canvas.clientHeight || MINIMAP_H;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      schedule();
    };

    resize();
    const unregisterCapture = registerScreenshotRenderer(canvas, pixelRatio => {
      try {
        const ratio = Math.max(1, pixelRatio);
        canvas.width = Math.ceil(cssW * ratio); canvas.height = Math.ceil(cssH * ratio);
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0); draw();
        return canvas.toDataURL('image/png');
      } finally { resize(); draw(); }
    });
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const unsubA = useLivePositionsStore.subscribe(schedule);
    const unsubB = useLiveViewportStore.subscribe(schedule);
    const unsubC = useGraphStore.subscribe(schedule);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      unregisterCapture();
      unsubA(); unsubB(); unsubC();
    };
  }, []);

  // Hover → sidebar title: write the hovered node's header into the canvas
  // data-tip (AppTooltips follows it), and repaint so the rect highlights.
  const setHovered = (id: string | null) => {
    if (hoveredIdRef.current === id) return;
    hoveredIdRef.current = id;
    let tip = DEFAULT_TIP;
    if (id) {
      const n = useGraphStore.getState().project?.nodes[id];
      const header = n?.versions[n.currentVersionIndex]?.header ?? '';
      tip = header.trim() || 'Untitled';
    }
    canvasRef.current?.setAttribute('data-tip', tip);
    scheduleRef.current();
  };

  const hoveredNodeAt = (e: React.PointerEvent): string | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return hitTestRects(rectsRef.current, e.clientX - rect.left, e.clientY - rect.top);
  };

  // Pan the camera so the world point under the cursor is centered.
  const panTo = (e: React.PointerEvent, commit: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const { minX, minY, scale, offX, offY, cw, ch } = geomRef.current;
    const wx = minX + (e.clientX - rect.left - offX) / scale;
    const wy = minY + (e.clientY - rect.top - offY) / scale;
    const z = useLiveViewportStore.getState().zoom;
    const next = { x: cw / 2 - wx * z, y: ch / 2 - wy * z, zoom: z };
    useLiveViewportStore.getState().setViewport(next);
    if (commit) useGraphStore.getState().setViewport(next);
  };

  return (
    <div className="sidebar-minimap" ref={wrapRef} onPointerDown={(e) => e.stopPropagation()}>
      <canvas
        ref={canvasRef}
        className="sidebar-minimap-canvas"
        data-tip={DEFAULT_TIP}
        onPointerDown={(e) => {
          e.stopPropagation();
          // Taking the camera by minimap-hand cancels any follow tween /
          // generation autopan — same rule as drag-pan and zoomCameraBy.
          // (Nothing re-issues the request: generate.ts pans once, at spawn.)
          useGraphStore.getState().requestPanTo(null);
          draggingRef.current = true;
          canvasRef.current?.setPointerCapture(e.pointerId);
          panTo(e, false);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) { e.stopPropagation(); panTo(e, false); return; }
          setHovered(hoveredNodeAt(e));
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          e.stopPropagation();
          draggingRef.current = false;
          canvasRef.current?.releasePointerCapture(e.pointerId);
          panTo(e, true);
          setHovered(hoveredNodeAt(e));
        }}
        onPointerLeave={() => setHovered(null)}
      />
    </div>
  );
}
