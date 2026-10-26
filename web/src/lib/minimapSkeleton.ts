import type { ScatterNode } from '@/store/types';
import { currentContentType } from './nodeContentType';

export interface MinimapMark { x: number; y: number; w: number; h: number; alpha: number }

/** Screen-pixel marks: rows are omitted when space runs out, never squashed.
 * Mirrors the canvas overview vocabulary: outline, prose, chat and website. */
export function minimapSkeleton(node: ScatterNode, width: number, height: number): MinimapMark[] {
  if (width < 12 || height < 10) return [];
  const marks: MinimapMark[] = [];
  const w = width - 4, bottom = height - 2;
  const add = (x: number, y: number, rw: number, h = 1.2, alpha = .4) => {
    if (y + h <= bottom && rw > 0) marks.push({ x: x + 2, y, w: Math.min(rw, w - x), h, alpha });
  };
  add(0, 3, w * .6, 1.7, .65);
  const kind = currentContentType(node);
  if (kind === 'media') {
    // A small image silhouette (sun + two rising mountain slopes).
    add(w * .15, 7, Math.max(1.5, w * .09), 2, .6);
    for (let i = 0; i < 4; i++) add(w * (.15 + i * .12), 16 - i * 2, w * .16, 2, .45);
    for (let i = 0; i < 3; i++) add(w * (.48 + i * .12), 12 + i * 2, w * .16, 2, .45);
  } else if (kind === 'chat') {
    // Larger cards need message-shaped blocks, not a dense stack of stripes.
    // Keep small maps legible; omit messages that do not fit instead of squeezing them.
    const messageHeight = Math.max(6, Math.min(16, w * .16));
    for (let y = 7, row = 0; y + messageHeight <= bottom; y += messageHeight + 3, row++) {
      const right = row % 2 === 0;
      const textX = right ? w * .4 : w * .08;
      add(right ? w * .32 : 0, y, w * (right ? .68 : .85), messageHeight, .25);
      if (messageHeight >= 10) {
        add(textX, y + messageHeight * .3, w * .45, 1, .55);
        add(textX, y + messageHeight * .65, w * .3, 1, .4);
      } else {
        add(textX, y + (messageHeight - 1) / 2, w * .45, 1, .55);
      }
    }
  } else if (kind === 'interactive') {
    add(0, 7, w, 2, .25); // navigation
    for (let y = 12; y + 2 <= bottom; y += 5) {
      add(0, y, w * .2, 1.2, .4); // menu
      add(w * .3, y, w * .3, 3, .3);
      add(w * .68, y, w * .32, 3, .3);
    }
  } else if (kind === 'encyclopedic') {
    add(0, 7, w * .95);
    add(0, 10, w * .72);
    for (let y = 15; y + 1.2 <= bottom; y += 7) {
      add(0, y, 1.3, 1.3, .65);
      add(3, y, w * .65);
      add(4, y + 3, w * .78, 1, .3);
    }
  } else {
    for (let y = 7, row = 0; y + 1.2 <= bottom; y += 3.5, row++) {
      add(0, y, w * (row % 3 === 2 ? .64 : .95), 1.2, kind === 'answer' && row % 4 === 0 ? .6 : .4);
    }
  }
  return marks;
}
