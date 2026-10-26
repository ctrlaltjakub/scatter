import { describe, expect, test } from 'vitest';
import {
  measureWidthFor, nodeMinWidth, widthForAspectCap,
  MEASURE_WIDTH, MIN_NODE_W, NODE_BORDER_PX, NODE_BODY_H_PADDING,
  ASPECT_MAX_WIDTH, ASPECT_MAX_RATIO, APPROX_HEADER_CHROME,
} from './nodeSize';
import type { NodeVersion } from '@/store/types';

const ver = (minWidth?: number): NodeVersion =>
  ({ header: '', body: '', createdAt: 0, generatedBy: 'manual', minWidth });
const node = (minWidth?: number) => ({ versions: [ver(minWidth)], currentVersionIndex: 0 });

describe('measureWidthFor', () => {
  test('falls back to MEASURE_WIDTH for an ordinary version (no minWidth)', () => {
    expect(measureWidthFor(undefined)).toBe(MEASURE_WIDTH);
  });
  test('a raised minWidth measures at that width minus chrome', () => {
    const minW = 800;
    expect(measureWidthFor(minW)).toBe(minW - NODE_BORDER_PX - NODE_BODY_H_PADDING);
  });
  test('never returns less than MEASURE_WIDTH', () => {
    expect(measureWidthFor(MIN_NODE_W)).toBe(MEASURE_WIDTH);
    expect(measureWidthFor(100)).toBe(MEASURE_WIDTH);
  });
});

describe('nodeMinWidth', () => {
  test('defaults to the global floor', () => {
    expect(nodeMinWidth(node())).toBe(MIN_NODE_W);
  });
  test('honours a raised per-version minWidth', () => {
    expect(nodeMinWidth(node(749))).toBe(749);
  });
});

describe('widthForAspectCap', () => {
  const fixedPx = 80; // freetext + overhead + safety

  test('a short node stays at the default width', () => {
    const w = widthForAspectCap({ minBodyH: 300, measuredContentW: MEASURE_WIDTH, fixedPx });
    expect(w).toBe(MIN_NODE_W);
  });

  test('a tall node is widened', () => {
    const w = widthForAspectCap({ minBodyH: 1400, measuredContentW: MEASURE_WIDTH, fixedPx });
    expect(w).toBeGreaterThan(MIN_NODE_W);
    expect(w).toBeLessThanOrEqual(ASPECT_MAX_WIDTH);
  });

  test('the returned width brings the estimated proportion within 3:2', () => {
    const minBodyH = 1400;
    const measuredContentW = MEASURE_WIDTH;
    const w = widthForAspectCap({ minBodyH, measuredContentW, fixedPx });
    const PAD = NODE_BORDER_PX + NODE_BODY_H_PADDING;
    const reflow0 = minBodyH - fixedPx;
    const estBody = fixedPx + reflow0 * (measuredContentW / (w - PAD));
    // The chosen width must satisfy 3:2 (or be the hard cap).
    const ok = (estBody + APPROX_HEADER_CHROME) / w <= ASPECT_MAX_RATIO;
    expect(ok || w === ASPECT_MAX_WIDTH).toBe(true);
  });

  test('an extreme node clamps to the width cap', () => {
    const w = widthForAspectCap({ minBodyH: 100000, measuredContentW: MEASURE_WIDTH, fixedPx });
    expect(w).toBe(ASPECT_MAX_WIDTH);
  });
});
