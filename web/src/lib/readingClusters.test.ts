import { describe, expect, it } from 'vitest';
import { buildClusters, trimToWord, type Segment } from './readingClusters';

/** Shorthand builders — segments tile the whole string, like the DOM walk. */
const seg = (start: number, end: number, kind: Segment['kind'] = 'text'): Segment => ({ start, end, kind });
const words = (text: string, clusters: { start: number; end: number }[]) =>
  clusters.map((c) => text.slice(c.start, c.end));

describe('buildClusters — plain text', () => {
  it('splits on whitespace with punctuation attached to its word', () => {
    const text = 'Hello, world.';
    const out = buildClusters(text, [seg(0, text.length)]);
    expect(out).toEqual([
      { start: 0, end: 6 }, // "Hello,"
      { start: 7, end: 13 }, // "world."
    ]);
  });

  it('returns [] for empty or whitespace-only text', () => {
    expect(buildClusters('', [])).toEqual([]);
    expect(buildClusters('   ', [seg(0, 3)])).toEqual([]);
  });

  it('merges a punctuation-only token backward (the ": " separator case)', () => {
    const text = 'Paris : capital';
    const out = buildClusters(text, [seg(0, text.length)]);
    expect(words(text, out)).toEqual(['Paris :', 'capital']);
  });

  it('merges a leading punctuation-only token forward instead', () => {
    const text = '( hello )';
    const out = buildClusters(text, [seg(0, text.length)]);
    expect(words(text, out)).toEqual(['( hello )']);
  });
});

describe('buildClusters — articles', () => {
  it('merges a/an/the with the following word', () => {
    const text = 'the cat sat';
    const out = buildClusters(text, [seg(0, text.length)]);
    expect(out).toEqual([
      { start: 0, end: 7 }, // "the cat"
      { start: 8, end: 11 }, // "sat"
    ]);
  });

  it('is case-insensitive', () => {
    const text = 'A dog barks';
    expect(words(text, buildClusters(text, [seg(0, text.length)]))).toEqual(['A dog', 'barks']);
    const text2 = 'An apple';
    expect(words(text2, buildClusters(text2, [seg(0, text2.length)]))).toEqual(['An apple']);
  });

  it('only merges whole tokens, not words starting with an article', () => {
    const text = 'Theatre tickets then again';
    expect(words(text, buildClusters(text, [seg(0, text.length)]))).toEqual([
      'Theatre',
      'tickets',
      'then',
      'again',
    ]);
  });

  it('leaves a trailing article alone', () => {
    const text = 'read the';
    expect(words(text, buildClusters(text, [seg(0, text.length)]))).toEqual(['read', 'the']);
  });

  it('merges an article into a following chip as one cluster', () => {
    const text = 'see the big idea';
    // "see the " is plain text, "big idea" is a chip.
    const out = buildClusters(text, [seg(0, 8), seg(8, 16, 'chip')]);
    expect(words(text, out)).toEqual(['see', 'the big idea']);
  });
});

describe('trimToWord', () => {
  it('strips a trailing period', () => {
    expect(trimToWord('settlement.', 0, 11)).toEqual({ start: 0, end: 10 });
  });
  it('strips leading and trailing punctuation, keeps internal', () => {
    expect(trimToWord('(hi)', 0, 4)).toEqual({ start: 1, end: 3 });
    expect(trimToWord('U.S.A.', 0, 6)).toEqual({ start: 0, end: 5 }); // internal dots kept
  });
  it('strips a trailing colon off a chip-style range', () => {
    const t = 'Roman Empire: ';
    expect(trimToWord(t, 0, t.length)).toEqual({ start: 0, end: 12 }); // "Roman Empire"
  });
  it('respects a sub-range (word inside a larger string)', () => {
    const t = 'see settlement. next';
    expect(trimToWord(t, 4, 15)).toEqual({ start: 4, end: 14 }); // "settlement"
  });
  it('returns null for an all-punctuation range', () => {
    expect(trimToWord('...', 0, 3)).toBeNull();
  });
});

describe('buildClusters — chips and bold phrases', () => {
  it('keeps a multi-word chip as a single cluster', () => {
    const text = 'France in Europe';
    expect(buildClusters(text, [seg(0, text.length, 'chip')])).toEqual([{ start: 0, end: 16 }]);
  });

  it('keeps a whole bold phrase as one cluster next to plain words', () => {
    const text = 'very important stuff';
    const out = buildClusters(text, [seg(0, 14, 'bold'), seg(14, 20)]);
    expect(words(text, out)).toEqual(['very important', 'stuff']);
  });

  it('trims whitespace inside chip/bold segment bounds', () => {
    const text = ' Paris ';
    expect(buildClusters(text, [seg(0, 7, 'chip')])).toEqual([{ start: 1, end: 6 }]);
  });

  it('emits nothing for a whitespace-only chip segment', () => {
    const text = 'a  b';
    const out = buildClusters(text, [seg(0, 1), seg(1, 3, 'chip'), seg(3, 4)]);
    expect(words(text, out)).toEqual(['a  b']); // article "a" merges into "b" across the empty chip
  });

  it('does NOT article-merge a chip whose label is "the"', () => {
    const text = 'the movie';
    const out = buildClusters(text, [seg(0, 3, 'chip'), seg(3, 9)]);
    expect(words(text, out)).toEqual(['the', 'movie']);
  });
});
