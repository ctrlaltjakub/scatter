import { describe, it, expect } from 'vitest';
import {
  clampResizeAgainstChain,
  maxMediaWidthAgainstChain,
  type RectInfo,
} from './rectChain';

const pin = (x: number, y: number, w: number, h: number): RectInfo => ({ x, y, w, h, pinned: true });
const free = (x: number, y: number, w: number, h: number): RectInfo => ({ x, y, w, h, pinned: false });

describe('clampResizeAgainstChain — reserves a gap before a pinned wall', () => {
  const start = { x: 0, y: 0, w: 100, h: 100 };

  it('rightward growth stops `gap` short of a pinned node on the right', () => {
    const r = clampResizeAgainstChain({ ...start, w: 400 }, start, 'br', [pin(300, 0, 100, 100)], 10);
    expect(r.w).toBe(290); // right edge stops at 300 − 10
    expect(r.x).toBe(0);
  });

  it('gap = 0 stops flush at the pinned edge (old behaviour)', () => {
    const r = clampResizeAgainstChain({ ...start, w: 400 }, start, 'br', [pin(300, 0, 100, 100)], 0);
    expect(r.w).toBe(300);
  });

  it('leftward growth keeps the right edge fixed and stops `gap` short on the left', () => {
    const s = { x: 300, y: 0, w: 100, h: 100 };          // right edge anchored at 400
    const r = clampResizeAgainstChain({ x: -50, y: 0, w: 450, h: 100 }, s, 'bl', [pin(0, 0, 100, 100)], 10);
    expect(r.x).toBe(110);   // left wall 100 + gap 10
    expect(r.x + r.w).toBe(400); // right edge unchanged
  });

  it('downward growth stops `gap` short of a pinned node below', () => {
    const r = clampResizeAgainstChain({ ...start, h: 400 }, start, 'br', [pin(0, 300, 100, 100)], 10);
    expect(r.h).toBe(290);
  });

  it('an unpinned obstacle is not a wall (growth is unconstrained)', () => {
    const r = clampResizeAgainstChain({ ...start, w: 400 }, start, 'br', [free(300, 0, 100, 100)], 10);
    expect(r.w).toBe(400);
  });
});

describe('maxMediaWidthAgainstChain — aspect-locked width that clears pinned walls by `gap`', () => {
  const start = { x: 0, y: 0, w: 100, h: 100 };
  const ratio = 0.5;     // body height per unit width
  const chromeH = 20;    // header/footer height, constant during a resize

  it('returns Infinity with no pinned obstacles', () => {
    expect(maxMediaWidthAgainstChain(start, 'br', ratio, chromeH, [], 10)).toBe(Infinity);
  });

  it('horizontal wall limits the width (grows right)', () => {
    // right wall 300, gap 10 → right edge ≤ 290 → width ≤ 290 (left edge at x=0)
    const m = maxMediaWidthAgainstChain(start, 'br', ratio, chromeH, [pin(300, 0, 100, 100)], 10);
    expect(m).toBe(290);
  });

  it('vertical wall limits the width through the aspect ratio (grows down)', () => {
    // bottom wall 120, gap 10 → bottom edge ≤ 110 → renderedH ≤ 110 →
    // body ≤ 90 → width ≤ 90 / 0.5 = 180
    const m = maxMediaWidthAgainstChain(start, 'br', ratio, chromeH, [pin(0, 120, 100, 100)], 10);
    expect(m).toBe(180);
  });

  it('takes the tighter of the horizontal and vertical limits', () => {
    const m = maxMediaWidthAgainstChain(
      start, 'br', ratio, chromeH,
      [pin(300, 0, 100, 100), pin(0, 120, 100, 100)], 10,
    );
    expect(m).toBe(180); // vertical (180) tighter than horizontal (290)
  });

  it('leftward/upward growth anchors the opposite edges', () => {
    const s = { x: 300, y: 300, w: 100, h: 100 }; // right edge 400, bottom edge 400
    // left wall 100 (+gap 10 = 110) → width ≤ 400 − 110 = 290
    const m = maxMediaWidthAgainstChain(s, 'tl', ratio, chromeH, [pin(0, 300, 100, 100)], 10);
    expect(m).toBe(290);
  });
});
