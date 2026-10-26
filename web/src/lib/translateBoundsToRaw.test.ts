import { describe, expect, test } from 'vitest';
import { translateBoundsToRaw } from './generate';
import { endMarker, nextMarkerId, startMarker } from './rewriteMarkers';

/**
 * The character math that lets concurrent partial rewrites cohabit:
 * we locate section bounds on the marker-stripped body (because
 * locateSection's L1/L2 parsing must see clean markdown), then have
 * to translate those bounds BACK to char positions in the raw working
 * body so we can splice in our new marker pair without overwriting
 * any existing partial's markers.
 */
describe('translateBoundsToRaw', () => {
  test('no markers: raw bounds equal stripped bounds', () => {
    const raw = 'AAA\nBBB\nCCC';
    const out = translateBoundsToRaw(raw, 4, 7);
    expect(out.rawStart).toBe(4);
    expect(out.rawEnd).toBe(7);
    expect(out.originalSectionText).toBe('BBB');
  });

  test('marker BEFORE the section shifts rawStart past the marker', () => {
    const id = nextMarkerId();
    const raw = `${startMarker(id)}AAA${endMarker(id)}\nBBB\nCCC`;
    // stripped is "AAA\nBBB\nCCC" (11 chars); section "BBB" is 4..7.
    const out = translateBoundsToRaw(raw, 4, 7);
    expect(raw.slice(out.rawStart, out.rawEnd)).toBe('BBB');
    expect(out.originalSectionText).toBe('BBB');
  });

  test('marker AFTER the section leaves bounds clean', () => {
    const id = nextMarkerId();
    const raw = `AAA\nBBB\n${startMarker(id)}CCC${endMarker(id)}`;
    // stripped 0..3=AAA, 4..7=BBB, 8..11=CCC.
    const out = translateBoundsToRaw(raw, 0, 3);
    expect(out.rawStart).toBe(0);
    expect(out.rawEnd).toBe(3);
    expect(out.originalSectionText).toBe('AAA');
  });

  test('section adjacent to an existing marker pair (start touches marker)', () => {
    const idOther = nextMarkerId();
    // Existing partial owns "OTHER" between markers; new section
    // is "BBB" right after the closing marker.
    const raw = `${startMarker(idOther)}OTHER${endMarker(idOther)}BBB`;
    // stripped = "OTHERBBB"; new section bounds are 5..8 ("BBB").
    const out = translateBoundsToRaw(raw, 5, 8);
    expect(raw.slice(out.rawStart, out.rawEnd)).toBe('BBB');
    expect(out.originalSectionText).toBe('BBB');
  });

  test('originalSectionText strips markers found INSIDE the section', () => {
    // This shouldn't happen in practice (refused by same-section
    // check) but the helper should still produce a clean string.
    const id = nextMarkerId();
    const raw = `pre${startMarker(id)}inner${endMarker(id)}post`;
    // stripped = "preinnerpost"; section 3..8 in stripped = "inner".
    const out = translateBoundsToRaw(raw, 3, 8);
    expect(out.originalSectionText).toBe('inner');
  });
});
