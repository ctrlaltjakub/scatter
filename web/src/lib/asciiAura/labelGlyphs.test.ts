import { expect, it } from 'vitest';
import { LANGUAGES } from '../languages';
import { labelClusters, labelLine, labelWidth, statusGlyphIndex } from './labelGlyphs';
import { wrapStatus } from './statusText';
import { buildLabelCells } from './arrowLabels';
import { placeGroupOverlayGlyph, writeOverlayIndex } from './gl/overlay';

it.each(LANGUAGES.map(l => [l.name, l.sample] as const))('keeps every visible grapheme of a %s label', (_language, sample) => {
  const text = sample.toUpperCase().normalize('NFC'), lines = wrapStatus(text, 12);
  expect(lines.join('').replaceAll(' ', '')).toBe(text.replaceAll(' ', ''));
  for (const line of lines) {
    expect(labelWidth(line)).toBeLessThanOrEqual(12);
    const cells = buildLabelCells({lines: [line], boxX: 0, boxY: 0, cellPx: 9, viewport: {x: 0, y: 0, zoom: 1}});
    for (const [i, char] of labelClusters(line).entries()) if (char.trim()) {
      const cell = cells.find(c => c.col === i);
      expect(cell).toBeDefined();
      expect(cell!.fallback?.run ?? statusGlyphIndex(char)).not.toBeNull();
    }
  }
});
it('shapes mixed-direction text as a complete run and reveals RTL from the right', () => {
  const text = 'العربية 123 (AI)';
  const line = labelLine(text);
  expect(line.letters[0]?.offset).toBe(line.width - 1);
  expect(line.letters.every(c => c.fallback?.run === text)).toBe(true);
  expect(labelWidth('A\u0301क्षि')).toBe(2);
  expect(labelLine('@').letters).toHaveLength(1);
});
it('encodes more than a byte of unique glyphs without corrupting priority or color', () => {
  const data = new Uint8Array(4);
  for (const slot of [0, 254, 255, 256, 4097, 16383]) {
    expect(placeGroupOverlayGlyph(data, 0, 256 + slot, 389, {replaceExisting: true})).toBe(true);
    expect((data[1]! - 128) * 255 + data[0]! - 1).toBe(slot);
    expect(data[0]).not.toBe(0); expect(data[2]).toBe(133);
  }
  writeOverlayIndex(data, 0, 24);
  expect(data.slice(0, 2)).toEqual(new Uint8Array([24, 0]));
});
