import { describe, expect, it } from 'vitest';
import {
  brushCursorSpec,
  clampCropRect,
  coverScaleForRotation,
  CURSOR_IMG_MAX,
  resizeCropRect,
  rotateCropForQuarterTurn,
  transformedImageBBox,
  turnedDims,
  unionRect,
  type CropHandle,
  type Rect,
} from './imageEditGeometry';

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe('coverScaleForRotation', () => {
  it('is 1 at angle 0 for any in-bounds crop', () => {
    expect(coverScaleForRotation(rect(0, 0, 800, 600), 800, 600, 0)).toBe(1);
    expect(coverScaleForRotation(rect(100, 100, 200, 150), 800, 600, 0)).toBe(1);
  });

  it('is √2 for a full-frame square crop at 45°', () => {
    const s = coverScaleForRotation(rect(0, 0, 400, 400), 400, 400, 45);
    expect(s).toBeCloseTo(Math.SQRT2, 10);
  });

  it('is 1 for a full-frame square crop at 90° (square covers itself)', () => {
    const s = coverScaleForRotation(rect(0, 0, 400, 400), 400, 400, 90);
    expect(s).toBeCloseTo(1, 10);
  });

  it('needs 2× to cover a 200×100 frame rotated 90°', () => {
    // Rotating a landscape image 90° leaves only its (short) height to span
    // the crop's width: 200 wide needs 100-tall pixels scaled ×2.
    const s = coverScaleForRotation(rect(0, 0, 200, 100), 200, 100, 90);
    expect(s).toBeCloseTo(2, 10);
  });

  it('grows monotonically with |angle| up to 45° (full-frame crop)', () => {
    let prev = 1;
    for (let a = 0; a <= 45; a += 5) {
      const s = coverScaleForRotation(rect(0, 0, 640, 480), 640, 480, a);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = s;
    }
    expect(prev).toBeGreaterThan(1);
  });

  it('stays 1 for a small centered crop at gentle angles', () => {
    const s = coverScaleForRotation(rect(350, 250, 100, 100), 800, 600, 10);
    expect(s).toBe(1);
  });

  it('is symmetric in angle sign', () => {
    const a = coverScaleForRotation(rect(0, 0, 640, 480), 640, 480, 20);
    const b = coverScaleForRotation(rect(0, 0, 640, 480), 640, 480, -20);
    expect(a).toBeCloseTo(b, 10);
  });
});

describe('clampCropRect', () => {
  it('pulls an out-of-bounds rect back inside', () => {
    expect(clampCropRect(rect(-50, -50, 200, 200), 800, 600, 32)).toEqual(rect(0, 0, 200, 200));
    expect(clampCropRect(rect(700, 500, 200, 200), 800, 600, 32)).toEqual(rect(600, 400, 200, 200));
  });

  it('enforces the minimum size and the image maximum', () => {
    expect(clampCropRect(rect(10, 10, 5, 5), 800, 600, 32)).toEqual(rect(10, 10, 32, 32));
    expect(clampCropRect(rect(0, 0, 5000, 5000), 800, 600, 32)).toEqual(rect(0, 0, 800, 600));
  });
});

describe('resizeCropRect', () => {
  const base = rect(100, 100, 200, 150);

  it('moves only the edges a handle owns', () => {
    expect(resizeCropRect(base, 'e', 30, 999, 800, 600, 32)).toEqual(rect(100, 100, 230, 150));
    expect(resizeCropRect(base, 'w', -20, 999, 800, 600, 32)).toEqual(rect(80, 100, 220, 150));
    expect(resizeCropRect(base, 'n', 999, -10, 800, 600, 32)).toEqual(rect(100, 90, 200, 160));
    expect(resizeCropRect(base, 's', 999, 25, 800, 600, 32)).toEqual(rect(100, 100, 200, 175));
  });

  it('corner handles move both their edges', () => {
    expect(resizeCropRect(base, 'se', 30, 25, 800, 600, 32)).toEqual(rect(100, 100, 230, 175));
    expect(resizeCropRect(base, 'nw', -20, -10, 800, 600, 32)).toEqual(rect(80, 90, 220, 160));
    expect(resizeCropRect(base, 'ne', 15, -5, 800, 600, 32)).toEqual(rect(100, 95, 215, 155));
    expect(resizeCropRect(base, 'sw', -5, 15, 800, 600, 32)).toEqual(rect(95, 100, 205, 165));
  });

  it('clamps every handle to the image bounds', () => {
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as CropHandle[]) {
      const r = resizeCropRect(base, h, 5000, 5000, 800, 600, 32);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(800);
      expect(r.y + r.height).toBeLessThanOrEqual(600);
      const r2 = resizeCropRect(base, h, -5000, -5000, 800, 600, 32);
      expect(r2.x).toBeGreaterThanOrEqual(0);
      expect(r2.y).toBeGreaterThanOrEqual(0);
      expect(r2.x + r2.width).toBeLessThanOrEqual(800);
      expect(r2.y + r2.height).toBeLessThanOrEqual(600);
    }
  });

  it('never collapses below the minimum size', () => {
    for (const h of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as CropHandle[]) {
      const r = resizeCropRect(base, h, h.includes('w') ? 5000 : -5000, h.includes('n') ? 5000 : -5000, 800, 600, 32);
      expect(r.width).toBeGreaterThanOrEqual(32);
      expect(r.height).toBeGreaterThanOrEqual(32);
    }
  });
});

describe('transformedImageBBox', () => {
  it('is the identity at angle 0, scale 1', () => {
    const b = transformedImageBBox(800, 600, rect(100, 100, 200, 150), 0, 1);
    expect(b.x).toBeCloseTo(0, 10);
    expect(b.y).toBeCloseTo(0, 10);
    expect(b.width).toBeCloseTo(800, 10);
    expect(b.height).toBeCloseTo(600, 10);
  });

  it('grows to the rotated diagonal at 90° (centered crop)', () => {
    const b = transformedImageBBox(800, 600, rect(0, 0, 800, 600), 90, 1);
    expect(b.width).toBeCloseTo(600, 8);
    expect(b.height).toBeCloseTo(800, 8);
  });

  it('scales about the crop center', () => {
    const b = transformedImageBBox(800, 600, rect(0, 0, 800, 600), 0, 2);
    expect(b.width).toBeCloseTo(1600, 8);
    expect(b.height).toBeCloseTo(1200, 8);
    expect(b.x).toBeCloseTo(-400, 8);
    expect(b.y).toBeCloseTo(-300, 8);
  });
});

describe('unionRect', () => {
  it('contains both rects', () => {
    expect(unionRect(rect(0, 0, 10, 10), rect(5, -5, 20, 10))).toEqual(rect(0, -5, 25, 15));
  });
});

describe('quarter turns', () => {
  it('turnedDims swaps on odd turns only', () => {
    expect(turnedDims(800, 600, 0)).toEqual({ w: 800, h: 600 });
    expect(turnedDims(800, 600, 1)).toEqual({ w: 600, h: 800 });
    expect(turnedDims(800, 600, 2)).toEqual({ w: 800, h: 600 });
    expect(turnedDims(800, 600, 3)).toEqual({ w: 600, h: 800 });
  });

  it('four clockwise turns bring a crop rect home', () => {
    let r = rect(100, 50, 300, 200);
    let w = 800;
    let h = 600;
    for (let i = 0; i < 4; i++) {
      r = rotateCropForQuarterTurn(r, w, h, 1);
      const d = turnedDims(w, h, 1);
      w = d.w;
      h = d.h;
    }
    expect(r).toEqual(rect(100, 50, 300, 200));
    expect({ w, h }).toEqual({ w: 800, h: 600 });
  });

  it('a clockwise turn undoes a counter-clockwise one', () => {
    const start = rect(20, 30, 100, 80);
    const cw = rotateCropForQuarterTurn(start, 800, 600, 1);
    const back = rotateCropForQuarterTurn(cw, 600, 800, -1);
    expect(back).toEqual(start);
  });

  it('keeps the rect inside the turned frame', () => {
    const r = rotateCropForQuarterTurn(rect(0, 0, 800, 600), 800, 600, 1);
    expect(r).toEqual(rect(0, 0, 600, 800));
  });
});

describe('brushCursorSpec', () => {
  it('small brushes get an SVG cursor sized brush + 4px breathing room', () => {
    expect(brushCursorSpec(20)).toEqual({ kind: 'svg', size: 24 });
  });

  it('never shrinks the cursor image below 6px', () => {
    expect(brushCursorSpec(0)).toEqual({ kind: 'svg', size: 6 });
    expect(brushCursorSpec(1)).toEqual({ kind: 'svg', size: 6 });
  });

  it('uses the SVG cursor right up to the browser cursor-image cap', () => {
    expect(brushCursorSpec(CURSOR_IMG_MAX - 4)).toEqual({ kind: 'svg', size: CURSOR_IMG_MAX });
  });

  it('switches to a drawn ring once the image would exceed the cap (browsers DROP oversize cursors, not clamp them)', () => {
    expect(brushCursorSpec(CURSOR_IMG_MAX - 3)).toEqual({ kind: 'ring', diameter: CURSOR_IMG_MAX - 3 });
    expect(brushCursorSpec(400)).toEqual({ kind: 'ring', diameter: 400 });
  });
});
