import { describe, expect, it } from 'vitest';
import { tokenizeOverviewText } from './overviewHeader';

describe('overview header words', () => {
  it('keeps ordinary words as separate atomic pieces', () => {
    const pieces = tokenizeOverviewText('alpha beta');
    expect(pieces.map((piece) => piece.kind)).toEqual(['word', 'space', 'word']);
    expect(pieces.map((piece) => piece.text.replaceAll('\u00ad', '')).join(''))
      .toBe('alpha beta');
  });

  it('adds invisible soft hyphens that render only when a word must wrap', () => {
    expect(tokenizeOverviewText('word')).toEqual([{
      kind: 'word',
      text: `w\u00ado\u00adr\u00add`,
    }]);
  });

  it('keeps slash-separated text naturally breakable', () => {
    const pieces = tokenizeOverviewText('good/bad');
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.breakAfter).toBe(true);
    expect(pieces.map((piece) => piece.text.replaceAll('\u00ad', '')).join(''))
      .toBe('good/bad');
  });
});
