import { describe, expect, test } from 'vitest';
import {
  encodeCellKey,
  decodeCellKey,
  encodeCellState,
  decodeStage,
  coolStage,
  shouldRedrawCell,
  collectStaleCells,
} from './cellDiff';

/**
 * The Scatter screen-fixed paint path keeps a per-cell content fingerprint
 * (`lastCellState`) so that each paint only redraws cells whose stage/
 * focus changed since last time. Storing the STAGE (not the glyph) lets
 * us implement glyph cooldown (A.5) — the displayed glyph is recovered
 * from (stage, seed) each paint, and stages walk down one step at a
 * time when the target falls below the previously displayed value.
 *
 * Encoding contract:
 *   cellKey  = ((col + 32768) * 65536) + (row + 32768)
 *   cellState = (stage << 1) | (focused ? 1 : 0)
 */

describe('encodeCellKey / decodeCellKey', () => {
  test('roundtrips a positive coord', () => {
    const k = encodeCellKey(42, 17);
    expect(decodeCellKey(k)).toEqual({ col: 42, row: 17 });
  });

  test('roundtrips a negative coord', () => {
    const k = encodeCellKey(-5, -120);
    expect(decodeCellKey(k)).toEqual({ col: -5, row: -120 });
  });

  test('roundtrips origin', () => {
    const k = encodeCellKey(0, 0);
    expect(decodeCellKey(k)).toEqual({ col: 0, row: 0 });
  });

  test('keys are unique for distinct cells', () => {
    const seen = new Set<number>();
    for (let col = -3; col <= 3; col++) {
      for (let row = -3; row <= 3; row++) {
        const k = encodeCellKey(col, row);
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('encodeCellState / decodeStage', () => {
  test('same (stage, focused) → same state (stable hash for diff comparison)', () => {
    expect(encodeCellState(5, true)).toBe(encodeCellState(5, true));
  });

  test('different focus → different state', () => {
    expect(encodeCellState(5, true)).not.toBe(encodeCellState(5, false));
  });

  test('different stage → different state', () => {
    expect(encodeCellState(5, false)).not.toBe(encodeCellState(6, false));
  });

  test('decodeStage recovers the stage regardless of focused bit', () => {
    expect(decodeStage(encodeCellState(0, false))).toBe(0);
    expect(decodeStage(encodeCellState(0, true))).toBe(0);
    expect(decodeStage(encodeCellState(7, false))).toBe(7);
    expect(decodeStage(encodeCellState(7, true))).toBe(7);
  });
});

describe('coolStage', () => {
  test('target > last → returns target (heat instantly)', () => {
    expect(coolStage(2, 5)).toBe(5);
  });

  test('target === last → returns target (no change)', () => {
    expect(coolStage(3, 3)).toBe(3);
  });

  test('target < last → returns last - 1 (cool by one step)', () => {
    expect(coolStage(5, 2)).toBe(4);
  });

  test('cooling reaches 0 after N steps', () => {
    let s = 8;
    for (let i = 0; i < 8; i++) s = coolStage(s, 0);
    expect(s).toBe(0);
  });

  test('cooling floors at 0 (does not go negative)', () => {
    expect(coolStage(0, 0)).toBe(0);
    expect(coolStage(1, 0)).toBe(0);
  });
});

describe('shouldRedrawCell', () => {
  test('full refresh → always redraw', () => {
    const last = new Map<number, number>([[42, 0xff]]);
    expect(shouldRedrawCell(true, last, 42, 0xff)).toBe(true);
  });

  test('no last state for this key → redraw (new cell)', () => {
    const last = new Map<number, number>();
    expect(shouldRedrawCell(false, last, 42, 0xff)).toBe(true);
  });

  test('last state matches new state → skip', () => {
    const last = new Map<number, number>([[42, 0xff]]);
    expect(shouldRedrawCell(false, last, 42, 0xff)).toBe(false);
  });

  test('last state differs from new state → redraw', () => {
    const last = new Map<number, number>([[42, 0xfe]]);
    expect(shouldRedrawCell(false, last, 42, 0xff)).toBe(true);
  });
});

describe('collectStaleCells', () => {
  test('returns cells in last-but-not-new — these are candidates for cooling/erase', () => {
    const k1 = encodeCellKey(1, 0);
    const k2 = encodeCellKey(2, 0);
    const k3 = encodeCellKey(3, 0);
    const last = new Map<number, number>([[k1, 1], [k2, 1], [k3, 1]]);
    const next = new Map<number, number>([[k2, 1]]);
    const stale = collectStaleCells(last, next, 100, 100);
    const coords = stale.map((c) => `${c.col},${c.row}`).sort();
    expect(coords).toEqual(['1,0', '3,0']);
  });

  test('skips cells outside the current grid bounds (off-screen old cells)', () => {
    const inside = encodeCellKey(5, 5);
    const outside = encodeCellKey(999, 999);
    const last = new Map<number, number>([[inside, 1], [outside, 1]]);
    const next = new Map<number, number>();
    const stale = collectStaleCells(last, next, 100, 100);
    const coords = stale.map((c) => `${c.col},${c.row}`);
    expect(coords).toEqual(['5,5']);
  });

  test('skips negative coords (off-screen top-left after pan)', () => {
    const inside = encodeCellKey(5, 5);
    const offTopLeft = encodeCellKey(-1, -1);
    const last = new Map<number, number>([[inside, 1], [offTopLeft, 1]]);
    const next = new Map<number, number>();
    const stale = collectStaleCells(last, next, 100, 100);
    expect(stale).toEqual([{ col: 5, row: 5 }]);
  });

  test('empty last → empty result', () => {
    const stale = collectStaleCells(new Map(), new Map(), 100, 100);
    expect(stale).toEqual([]);
  });

  test('all last carried over to next → empty result', () => {
    const k1 = encodeCellKey(1, 0);
    const last = new Map<number, number>([[k1, 1]]);
    const next = new Map<number, number>([[k1, 1]]);
    const stale = collectStaleCells(last, next, 100, 100);
    expect(stale).toEqual([]);
  });
});
