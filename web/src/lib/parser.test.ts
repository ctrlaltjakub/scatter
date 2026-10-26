import { describe, it, expect } from 'vitest';
import { extractReferences, unchipHeaders } from './parser';

describe('extractReferences', () => {
  it('returns an empty array when no references', () => {
    expect(extractReferences('plain text')).toEqual([]);
  });
  it('extracts a single reference', () => {
    expect(extractReferences('The [[Pasteur]] effect.')).toEqual(['Pasteur']);
  });
  it('extracts multiple references in order', () => {
    expect(extractReferences('A [[one]] and [[two-word]] and [[three]].'))
      .toEqual(['one', 'two-word', 'three']);
  });
  it('does not extract nested or malformed brackets', () => {
    expect(extractReferences('a [[ b ]] c [[[d]]] e [[]]')).toEqual(['b']);
  });
  it('extracts multi-word references', () => {
    expect(extractReferences('In [[lactic acid bacteria]] cultures.'))
      .toEqual(['lactic acid bacteria']);
  });
});

describe('unchipHeaders', () => {
  it('compares mixed-format term labels by their visible name and preserves emphasis', () => {
    expect(unchipHeaders('The [[**Working** *memory*]] matters.', ['Working memory']))
      .toBe('The **Working** *memory* matters.');
  });
  it('returns body unchanged when there are no blocked headers', () => {
    const body = 'See [[Foo]] and [[Bar]].';
    expect(unchipHeaders(body, [])).toBe(body);
  });

  it('removes the brackets around a chip that matches a blocked header', () => {
    expect(unchipHeaders('Back to [[Photosynthesis]] again.', ['Photosynthesis']))
      .toBe('Back to Photosynthesis again.');
  });

  it('matches case-insensitively', () => {
    expect(unchipHeaders('The [[Krebs Cycle]] runs.', ['krebs cycle']))
      .toBe('The Krebs Cycle runs.');
  });

  it('matches regardless of surrounding/internal whitespace differences', () => {
    expect(unchipHeaders('A [[ lactic   acid ]] step.', ['Lactic acid']))
      .toBe('A lactic   acid step.');
  });

  it('leaves non-matching chips intact', () => {
    expect(unchipHeaders('Keep [[Glucose]], drop [[ATP]].', ['ATP']))
      .toBe('Keep [[Glucose]], drop ATP.');
  });

  it('unchips several matching chips and keeps the rest', () => {
    const out = unchipHeaders(
      '[[Alpha]] vs [[Beta]] vs [[Gamma]].',
      ['alpha', 'gamma'],
    );
    expect(out).toBe('Alpha vs [[Beta]] vs Gamma.');
  });

  it('handles a colon inside the chip term', () => {
    expect(unchipHeaders('Watch [[2001: A Space Odyssey]] tonight.', ['2001: A Space Odyssey']))
      .toBe('Watch 2001: A Space Odyssey tonight.');
  });

  it('ignores malformed/nested brackets like extractReferences does', () => {
    const body = 'x [[[Nested]]] y';
    expect(unchipHeaders(body, ['Nested'])).toBe(body);
  });
});
