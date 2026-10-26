import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_NODE_W,
  NODE_BORDER_PX,
  NODE_BODY_H_PADDING,
  MEASURE_WIDTH,
} from './nodeSize';

/**
 * REGRESSION GUARD for the "long bullet overflows the node" bug.
 *
 * AdaptiveBullets renders its hidden measurement labs at MEASURE_WIDTH
 * and derives `minBodyHeight` from how tall each bullet is at that
 * width. If MEASURE_WIDTH is even slightly WIDER than the body's real
 * content width, text wraps to fewer lines in the lab than it will in
 * reality, the measured heights come out too short, `minBodyHeight` is
 * undersized, and a tall bullet overflows the body.
 *
 * That is exactly what happened when `.node-body` horizontal padding
 * was widened from 12px to 22px per side (24 → 44 total) but the
 * MEASURE_WIDTH constant kept subtracting the old 24. The lab measured
 * at 598px while the real content was 578px — 20px too generous.
 *
 * These tests parse globals.css so the constants can never silently
 * drift from the stylesheet again.
 */

const cssPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'app',
  'globals.css',
);
const css = readFileSync(cssPath, 'utf8');

/** Extract the body of a top-level rule `selector { ... }`. Matches the
 *  FIRST occurrence; relies on rules not nesting braces (true for this
 *  stylesheet — no @media wrapping these rules). */
function ruleBody(selector: string): string {
  // Escape regex metachars in the selector, then require it be followed
  // by optional whitespace and `{` — so `.node` won't match `.node-body`.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the selector itself, not a descendant rule such as
  // `.node-initial-text-frame .node-body`.
  const re = new RegExp('(?:^|\\n)\\s*' + esc + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1]!;
}

describe('MEASURE_WIDTH ↔ globals.css consistency', () => {
  test('.node has no border declaration (matches NODE_BORDER_PX === 0)', () => {
    const body = ruleBody('.node');
    // `.node` should not declare `border:` directly; modifier rules like
    // `.node.dragging` may, but the base rule should be borderless after
    // the Scatter polish pass.
    expect(body).not.toMatch(/border:\s*\d+px/);
    expect(NODE_BORDER_PX).toBe(0);
  });

  test('.node-body horizontal padding matches NODE_BODY_H_PADDING', () => {
    const body = ruleBody('.node-body');
    // First `padding:` in the rule. Shorthand is `top right bottom left`.
    const m = body.match(/padding:\s*([^;]+);/);
    expect(m, '.node-body should declare padding').not.toBeNull();
    const parts = m![1]!.trim().split(/\s+/).map((p) => parseInt(p, 10));
    // top right bottom left → horizontal = right + left
    const [, right, , left] = parts;
    const horizontal = (right ?? 0) + (left ?? 0);
    expect(NODE_BODY_H_PADDING).toBe(horizontal);
  });

  test('MEASURE_WIDTH equals the real body content width at MIN_NODE_W', () => {
    const body = ruleBody('.node-body');
    const padParts = body.match(/padding:\s*([^;]+);/)![1]!
      .trim().split(/\s+/).map((p) => parseInt(p, 10));
    const horizontalPad = (padParts[1] ?? 0) + (padParts[3] ?? 0);
    // No border on .node anymore, so the only horizontal real-estate
    // consumed beyond MIN_NODE_W is body padding.
    const realContentWidth = MIN_NODE_W - NODE_BORDER_PX - horizontalPad;
    expect(MEASURE_WIDTH).toBe(realContentWidth);
  });
});
