import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildAtlasCanvas } from './atlas';
import { ATLAS_GLYPHS, BOLD_RAY_GLYPHS, BOLD_RAY_GLYPH_OFFSET } from './atlasLayout';

afterEach(() => vi.restoreAllMocks());

describe('isolated glyph atlas cells', () => {
  test('prevents antialias coverage outside a glyph from painting neighbouring cells', () => {
    const cellPx = 11;
    // Model an antialiased font with a 1px left overhang. Give each glyph a
    // distinct value so any cross-cell contamination is observable, including
    // ordinary labels (the old implementation clipped bold rays only).
    const pixels = new Int16Array(cellPx * ATLAS_GLYPHS.length).fill(-1);
    let clip: [number, number] = [0, pixels.length];
    let rect: [number, number] = clip;
    const stack: [number, number][] = [];
    let glyphIndex = 0;
    const ctx = {
      clearRect: vi.fn(), beginPath: vi.fn(), strokeText: vi.fn(),
      save: () => { stack.push(clip); },
      restore: () => { clip = stack.pop()!; },
      rect: (x: number, _y: number, width: number) => { rect = [x, x + width]; },
      clip: () => { clip = rect; },
      fillText: (_glyph: string, x: number) => {
        for (let p = Math.max(x - 1, clip[0]); p < Math.min(x + cellPx - 1, clip[1]); p++) pixels[p] = glyphIndex;
        glyphIndex++;
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    buildAtlasCanvas(cellPx, 10);
    for (let i = 0; i < ATLAS_GLYPHS.length; i++) {
      expect(Array.from(pixels.slice(i * cellPx, (i + 1) * cellPx)))
        .toEqual([...Array(cellPx - 1).fill(i), -1]);
    }
  });

  test.each([1, 1.25, 1.5, 1.75, 2, 3])('clips every glyph and thickens only rays at DPR %s', (dpr) => {
    const ctx = {
      clearRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(),
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      lineWidth: 0, lineJoin: '', font: '', textBaseline: '', fillStyle: '', strokeStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const cellPx = Math.round(9 * dpr);
    const fontPx = Math.round(8 * dpr);
    const atlas = buildAtlasCanvas(cellPx, fontPx)!;
    expect(atlas.layout.cellPx).toBe(cellPx);
    expect(ctx.font).toBe(`${fontPx}px 'Press Start 2P', monospace`);
    expect(ctx.lineWidth).toBeCloseTo(0.75 * dpr);
    expect(ctx.fillText).toHaveBeenCalledTimes(ATLAS_GLYPHS.length);
    expect(ctx.strokeText.mock.calls).toEqual(BOLD_RAY_GLYPHS.map((glyph, i) => [glyph, (BOLD_RAY_GLYPH_OFFSET + i) * cellPx, 0]));
    expect(ctx.clip).toHaveBeenCalledTimes(ATLAS_GLYPHS.length);
    expect(ctx.save).toHaveBeenCalledTimes(ATLAS_GLYPHS.length);
    expect(ctx.restore).toHaveBeenCalledTimes(ATLAS_GLYPHS.length);
    for (let i = 0; i < ATLAS_GLYPHS.length; i++) {
      expect(ctx.rect).toHaveBeenNthCalledWith(i + 1, i * cellPx, 0, cellPx, cellPx);
      expect(ctx.fillText).toHaveBeenNthCalledWith(i + 1, ATLAS_GLYPHS[i], i * cellPx, 0);
      expect(ctx.clip.mock.invocationCallOrder[i]).toBeLessThan(ctx.fillText.mock.invocationCallOrder[i]!);
      expect(ctx.restore.mock.invocationCallOrder[i]).toBeGreaterThan(ctx.fillText.mock.invocationCallOrder[i]!);
      if (i >= BOLD_RAY_GLYPH_OFFSET) {
        expect(ctx.clip.mock.invocationCallOrder[i]).toBeLessThan(ctx.strokeText.mock.invocationCallOrder[i - BOLD_RAY_GLYPH_OFFSET]!);
      }
    }
  });
});
