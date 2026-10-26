/**
 * Fade-under-arrows math for the ASCII aura field (Part G).
 *
 * Arrows are drawn over the busy ASCII field; to keep them legible the
 * field is THINNED along each arrow — cells under it are demoted to
 * lighter ramp glyphs (a dense `#`/`S` → a sparse `,`/`.`), ASCII-art
 * style, rather than the same glyphs at lower opacity. This module is
 * the pure geometry — point-to-segment distance and the distance→
 * stage-demotion falloff. The renderer iterates each arrow's
 * screen-space segments, marks the nearby cells, and the shader picks
 * the glyph from the demoted stage. Status-text cells are exempt
 * (handled by the renderer).
 *
 * Everything is screen-space CSS pixels: cells are screen-locked, so
 * "which cells does the arrow cross" is a screen question, and the band
 * stays a constant visual width at any zoom.
 */

import type { Project } from '@/store/types';
import { isArrowVisible } from '@/lib/arrowPolicy';

/** Band half-width: cells within this many CSS px of an arrow are faded. */
export const ARROW_DEMOTE_RADIUS_PX = 22;
/** Ramp stages subtracted right on the arrow centerline (the strongest
 *  thinning; 8 ≈ the full ramp, so the densest glyph drops to '.'). */
export const ARROW_DEMOTE_MAX_STAGES = 8;

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by).
 *  Squared so the per-cell hot path avoids a sqrt; compare against
 *  ARROW_DIM_RADIUS_PX² and only sqrt the survivors. */
export function pointSegDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  let t = lenSq > 0 ? (wx * vx + wy * vy) / lenSq : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * vx;
  const cy = ay + t * vy;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

/** Integer ramp stages to subtract from a cell's glyph, given its distance
 *  to the nearest arrow: ARROW_DEMOTE_MAX_STAGES at the centerline (lightest
 *  glyph), easing linearly to 0 at the radius, and a flat 0 beyond it. The
 *  shader clamps `stage - demote` at 0. */
export function demoteStages(dist: number): number {
  if (dist >= ARROW_DEMOTE_RADIUS_PX) return 0;
  return Math.round(ARROW_DEMOTE_MAX_STAGES * (1 - dist / ARROW_DEMOTE_RADIUS_PX));
}

/** Apply clearing only for currently visible arrows; stale or hidden chains
 * must not leave a trace in the ASCII background. Data is the RGBA cell overlay. */
export function paintArrowDimming(
  data: Uint8Array,
  anchors: Record<string, { x: number; y: number }[]>,
  project: Pick<Project, 'arrows' | 'selection'> | null,
  viewport: { x: number; y: number; zoom: number },
  cellPx: number, cellsX: number, cellsY: number,
): void {
  if (!project) return;
  const radius = ARROW_DEMOTE_RADIUS_PX;
  const radiusSq = radius * radius;
  for (const id in anchors) {
    const arrow = project.arrows[id];
    if (!arrow || !isArrowVisible(arrow, project.selection)) continue;
    const chain = anchors[id]!;
    for (let i = 0; i + 1 < chain.length; i++) {
      const ax = chain[i]!.x * viewport.zoom + viewport.x;
      const ay = chain[i]!.y * viewport.zoom + viewport.y;
      const bx = chain[i + 1]!.x * viewport.zoom + viewport.x;
      const by = chain[i + 1]!.y * viewport.zoom + viewport.y;
      const col0 = Math.max(0, Math.floor((Math.min(ax, bx) - radius) / cellPx));
      const col1 = Math.min(cellsX - 1, Math.floor((Math.max(ax, bx) + radius) / cellPx));
      const row0 = Math.max(0, Math.floor((Math.min(ay, by) - radius) / cellPx));
      const row1 = Math.min(cellsY - 1, Math.floor((Math.max(ay, by) + radius) / cellPx));
      for (let row = row0; row <= row1; row++) {
        const cy = row * cellPx + cellPx / 2;
        for (let col = col0; col <= col1; col++) {
          const cx = col * cellPx + cellPx / 2;
          const distanceSq = pointSegDistSq(cx, cy, ax, ay, bx, by);
          if (distanceSq >= radiusSq) continue;
          const demote = demoteStages(Math.sqrt(distanceSq));
          const greenByte = (row * cellsX + col) * 4 + 1;
          if (demote > data[greenByte]!) data[greenByte] = demote;
        }
      }
    }
  }
}
