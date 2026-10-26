import { describe, expect, it } from 'vitest';
import {
  cleanPreviewTail,
  fitRelationPreview,
  openingParagraphPreview,
  previewTailParts,
  previewFormattedParts,
} from './relationPreview';

describe('relation preview copy', () => {
  it('preserves and slices bold by visible positions, including a cut inside bold text', () => {
    const text = openingParagraphPreview('A **useful concept** explains [[memory]].', true);
    expect(text).toBe('A **useful concept** explains memory.');
    expect(previewFormattedParts(text, 2, 8)).toEqual([{ text: 'useful', bold: true }]);
  });
  it('extracts and normalizes the opening paragraph only', () => {
    expect(openingParagraphPreview(
      '**Light** is [[electromagnetic radiation]].⟦2⟧\n\n- Waves\n  - Frequency: cycles',
    )).toBe('Light is electromagnetic radiation.');
  });

  it('keeps link labels but removes Markdown and citations', () => {
    expect(openingParagraphPreview(
      'Read [the paper](https://example.com) about _signal flow_ ⟦12⟧.',
    )).toBe('Read the paper about signal flow.');
  });

  it('removes whitespace and awkward punctuation before the icon', () => {
    expect(cleanPreviewTail('A useful partial thought, — ')).toBe('A useful partial thought');
  });
});

describe('fitRelationPreview', () => {
  it('takes the longest fitting word boundary without an ellipsis', () => {
    const fitted = fitRelationPreview(
      'alpha beta gamma delta',
      (candidate) => candidate.length <= 16,
    );
    expect(fitted.text).toBe('alpha beta gamma');
    expect(fitted.text).not.toContain('…');
    expect(fitted.leading + fitted.faded).toBe(fitted.text);
    expect(Array.from(fitted.faded)).toHaveLength(2);
  });

  it('keeps checking multi-line fits when keeping an earlier long tail together does not fit', () => {
    const fitted = fitRelationPreview(
      'alpha exceptionallylongword beta gamma',
      (candidate) => (
        candidate === 'alpha'
        || candidate === 'alpha exceptionallylongword beta'
      ),
    );
    expect(fitted.text).toBe('alpha exceptionallylongword beta');
  });

  it('falls back to a character-safe prefix for one oversized word', () => {
    const fitted = fitRelationPreview('electromagnetism', (candidate) => candidate.length <= 6);
    expect(fitted.text).toBe('electr');
    expect(fitted.truncated).toBe(true);
  });

  it('keeps the final word and faded letters in one tail group', () => {
    expect(previewTailParts('alpha beta')).toEqual({
      head: 'alpha ',
      tailLeading: 'be',
      faded: 'ta',
    });
  });
});
