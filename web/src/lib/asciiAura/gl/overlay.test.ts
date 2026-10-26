import { describe, expect, it } from 'vitest';
import { isCharShown } from '../statusText';
import {
  GROUP_COLOR_RECORD_HIGH_BYTE,
  GROUP_COLOR_RECORD_LOW_BYTE,
  INHERIT_OVERLAY_OPACITY_BYTE,
  PROJECT_COLOR_INHERIT_OPACITY_BYTE,
  placeArrowOverlayGlyph,
  placeBorrowedOverlayGlyph,
  placeGroupOverlayGlyph,
  placeProjectColorOverlayGlyph,
} from './overlay';

describe('placeBorrowedOverlayGlyph', () => {
  it('marks a glyph as borrowing the underlying aura opacity', () => {
    const data = new Uint8Array([0, 4, 0, 0]);
    expect(placeBorrowedOverlayGlyph(data, 0, 27)).toBe(true);
    expect([...data]).toEqual([27, 4, 0, INHERIT_OVERLAY_OPACITY_BYTE]);
  });

  it('does not overwrite an existing status or higher-priority label', () => {
    const data = new Uint8Array([12, 3, 2, 0]);
    expect(placeBorrowedOverlayGlyph(data, 0, 27)).toBe(false);
    expect([...data]).toEqual([12, 3, 2, 0]);
  });

  it.each([
    { phase: 'visible', clearedAt: null, now: 100 },
    { phase: 'deleting', clearedAt: 100, now: 101 },
  ])('keeps a $phase drag hint above an overlapping arrow glyph', ({ clearedAt, now }) => {
    const data = new Uint8Array(8);
    const dragHintOccupied = isCharShown(0, 2, 0, clearedAt, now);
    expect(dragHintOccupied).toBe(true);
    expect(placeBorrowedOverlayGlyph(data, 0, 12)).toBe(true);

    expect(placeArrowOverlayGlyph(data, 0, 27, { dragHintOccupied })).toBe(false);
    expect(placeArrowOverlayGlyph(data, 4, 28, { dragHintOccupied: false })).toBe(true);

    expect(data[0]).toBe(12);
    expect(data[4]).toBe(28);
  });

  it('encodes a group-colour record while preserving the inherited-opacity mode', () => {
    const low = new Uint8Array(4);
    expect(placeGroupOverlayGlyph(low, 0, 27, 42)).toBe(true);
    expect([...low]).toEqual([27, 0, 42, GROUP_COLOR_RECORD_LOW_BYTE]);

    const high = new Uint8Array(4);
    expect(placeGroupOverlayGlyph(high, 0, 27, 300)).toBe(true);
    expect([...high]).toEqual([27, 0, 44, GROUP_COLOR_RECORD_HIGH_BYTE]);
  });

  it('does not let a group label replace a protected status or drag-hint cell', () => {
    const data = new Uint8Array([12, 0, 0, 0]);
    expect(placeGroupOverlayGlyph(data, 0, 27, 4, { protectedCell: true })).toBe(false);
    expect([...data]).toEqual([12, 0, 0, 0]);
  });

  it('encodes a project colour while retaining the occupied cell opacity', () => {
    const data = new Uint8Array(4);
    expect(placeProjectColorOverlayGlyph(data, 0, 27, 6)).toBe(true);
    expect([...data]).toEqual([27, 0, 6, PROJECT_COLOR_INHERIT_OPACITY_BYTE]);
  });

  it('keeps project sync labels below protected node statuses', () => {
    const data = new Uint8Array([12, 0, 0, 0]);
    expect(placeProjectColorOverlayGlyph(data, 0, 27, 6, { protectedCell: true })).toBe(false);
    expect([...data]).toEqual([12, 0, 0, 0]);
  });
});
