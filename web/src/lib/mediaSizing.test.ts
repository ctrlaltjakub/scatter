import { describe, it, expect } from 'vitest';
import {
  fitMediaToWidth, aspectResize, chooserWidth,
  MEDIA_MIN_W, MEDIA_SPAWN_MAX_W, CHOOSER_MIN_W, CHOOSER_MAX_W,
} from './mediaSizing';

describe('fitMediaToWidth', () => {
  it('caps a huge landscape image at the spawn max width and keeps the ratio', () => {
    const r = fitMediaToWidth(1600, 900);
    expect(r.width).toBe(MEDIA_SPAWN_MAX_W);  // 624
    expect(r.bodyMaxHeight).toBe(Math.round(r.width * 900 / 1600));
  });
  it('caps a tall portrait HEIGHT at the spawn max (deriving a narrower width)', () => {
    const r = fitMediaToWidth(900, 1600);
    expect(r.bodyMaxHeight).toBe(MEDIA_SPAWN_MAX_W);  // height hits the cap
    expect(r.width).toBe(Math.round(MEDIA_SPAWN_MAX_W * 900 / 1600)); // 351, narrower
    expect(r.width).toBeLessThan(MEDIA_SPAWN_MAX_W);
  });
  it('never spawns taller than the spawn max for any aspect', () => {
    for (const [w, h] of [[100, 4000], [4000, 100], [800, 800], [1920, 1080]] as const) {
      expect(fitMediaToWidth(w, h).bodyMaxHeight).toBeLessThanOrEqual(MEDIA_SPAWN_MAX_W);
      expect(fitMediaToWidth(w, h).width).toBeLessThanOrEqual(MEDIA_SPAWN_MAX_W);
    }
  });
  it('floors a tiny image at the minimum width', () => {
    const r = fitMediaToWidth(100, 100);
    expect(r.width).toBe(MEDIA_MIN_W);        // 280
  });
  it('uses a 16:9 fallback for unknown dimensions (embeds), capped at spawn max', () => {
    const r = fitMediaToWidth(0, 0, 640);
    expect(r.width).toBe(MEDIA_SPAWN_MAX_W);  // 624 (640 capped)
    expect(r.bodyMaxHeight).toBe(Math.round(MEDIA_SPAWN_MAX_W * 9 / 16));
  });
});

describe('manual resize has no upper size limit', () => {
  it('aspectResize can exceed the spawn cap', () => {
    expect(aspectResize(1600, 900, 1000).width).toBe(1000);
    expect(aspectResize(1600, 900, 9999)).toEqual({ width: 9999, bodyMaxHeight: 5624 });
  });
});

describe('aspectResize', () => {
  it('preserves the aspect ratio at an arbitrary proposed width', () => {
    const r = aspectResize(1600, 900, 600);
    expect(r.width).toBe(600);
    expect(r.bodyMaxHeight).toBe(Math.round(600 * 900 / 1600));
  });
  it('keeps the minimum but does not cap large sizes', () => {
    expect(aspectResize(1600, 900, 50).width).toBe(MEDIA_MIN_W);
    expect(aspectResize(1600, 900, 9999).width).toBe(9999);
  });
});

describe('chooserWidth', () => {
  it('adds padding + slack to the widest sentence', () => {
    expect(chooserWidth(300)).toBe(300 + 44 + 24);
  });
  it('clamps to the chooser min/max', () => {
    expect(chooserWidth(50)).toBe(CHOOSER_MIN_W);
    expect(chooserWidth(900)).toBe(CHOOSER_MAX_W);
  });
});
