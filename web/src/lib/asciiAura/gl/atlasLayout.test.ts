/**
 * R5.4 — tests for the glyph-atlas layout math (pure part; the
 * actual canvas rasterization is DOM-bound and verified in-browser).
 *
 * The atlas is a single row: one cell per glyph of the flattened
 * ramp, in stage order. Pass B computes
 *   u = (glyphIndex * cellPx + inCellX) / widthPx
 * so the layout math here is the single source of truth for both
 * the rasterizer and the shader's uv lookup.
 */
import { describe, test, expect } from 'vitest';
import { RAMP, RAMP_FLAT, STAGE_OFFSETS, STAGE_LENGTHS, glyphIndexByHash } from '../ramp';
import { STATUS_CHARS, statusGlyphIndex } from '../statusText';
import { atlasLayout, ATLAS_GLYPHS, BOLD_RAY_GLYPHS, BOLD_RAY_GLYPH_OFFSET, boldRayGlyphIndex } from './atlasLayout';

describe('flattened ramp tables', () => {
  test('RAMP_FLAT concatenates the stage pools in order', () => {
    expect(RAMP_FLAT).toEqual(RAMP.flat());
  });

  test('offsets + lengths address the flat array per stage', () => {
    expect(STAGE_OFFSETS.length).toBe(RAMP.length);
    expect(STAGE_LENGTHS.length).toBe(RAMP.length);
    for (let stage = 0; stage < RAMP.length; stage++) {
      const off = STAGE_OFFSETS[stage]!;
      const len = STAGE_LENGTHS[stage]!;
      expect(RAMP_FLAT.slice(off, off + len)).toEqual([...RAMP[stage]!]);
    }
  });
});

describe('glyphIndexByHash', () => {
  test('always lands inside the stage pool', () => {
    for (let stage = 0; stage < RAMP.length; stage++) {
      for (const h of [0, 1, 2, 12345, 0xffffffff]) {
        const idx = glyphIndexByHash(stage, h);
        expect(idx).toBeGreaterThanOrEqual(STAGE_OFFSETS[stage]!);
        expect(idx).toBeLessThan(STAGE_OFFSETS[stage]! + STAGE_LENGTHS[stage]!);
      }
    }
  });

  test('is deterministic and uses hash % poolLength (the GLSL-portable pick)', () => {
    // Stage 1 has two glyphs: even hash → first, odd hash → second.
    expect(glyphIndexByHash(1, 4)).toBe(STAGE_OFFSETS[1]!);
    expect(glyphIndexByHash(1, 5)).toBe(STAGE_OFFSETS[1]! + 1);
  });
});

describe('atlasLayout', () => {
  test('single row, one cell per glyph (ramp + status + bold rays), at the device cell size', () => {
    const l = atlasLayout(14, 12); // deviceCellPx 14, deviceFontPx 12 (dpr 1.5)
    expect(l.glyphs).toEqual([...RAMP_FLAT, ...STATUS_CHARS, ...BOLD_RAY_GLYPHS]);
    expect(l.cellPx).toBe(14);
    expect(l.fontPx).toBe(12);
    expect(l.widthPx).toBe(14 * ATLAS_GLYPHS.length);
    expect(l.heightPx).toBe(14);
  });

  test('ramp glyphs keep their leading indices (GLSL parity untouched)', () => {
    expect(ATLAS_GLYPHS.slice(0, RAMP_FLAT.length)).toEqual([...RAMP_FLAT]);
  });

  test('statusGlyphIndex points at the atlas cell holding that letter', () => {
    for (const ch of STATUS_CHARS) {
      const idx = statusGlyphIndex(ch)!;
      expect(ATLAS_GLYPHS[idx]).toBe(ch);
    }
  });

  test('bold rays use separate appended cells without changing normal punctuation', () => {
    for (const glyph of BOLD_RAY_GLYPHS) {
      const index = boldRayGlyphIndex(glyph);
      expect(index).toBeGreaterThanOrEqual(BOLD_RAY_GLYPH_OFFSET);
      expect(index).not.toBe(statusGlyphIndex(glyph));
      expect(ATLAS_GLYPHS[index]).toBe(glyph);
    }
  });
});
