import { describe, expect, it } from 'vitest';
import { cleanImageQuestionTitle, generatingTitleDotVisible, imageQuestionTitleInput, isImageTitlePending } from './imageQuestionTitle';
import type { ScatterNode } from '@/store/types';

describe('image question titles', () => {
  it('bounds context, removes term markers, and preserves the actual question as data', () => {
    const input = JSON.parse(imageQuestionTitleInput('is it healthy?', 'The [[cigar]] has risks.'));
    expect(input).toEqual({ question: 'is it healthy?', imageAwareAnswer: 'The cigar has risks.' });
    expect(JSON.parse(imageQuestionTitleInput('q'.repeat(3000), 'a'.repeat(9000))).imageAwareAnswer).toHaveLength(6000);
  });
  it('accepts concise titles but rejects prose dumps and malformed outputs', () => {
    expect(cleanImageQuestionTitle(' "Health risks of cigars" ')).toBe('Health risks of cigars');
    expect(cleanImageQuestionTitle('a '.repeat(30))).toBeNull();
    expect(cleanImageQuestionTitle('{"title":"Cigars"}')).toBeNull();
    expect(cleanImageQuestionTitle('')).toBeNull();
  });
  it('animates only the three reserved dot cells without changing label placement', () => {
    const dots = (now: number) => [10, 11, 12].map((k) => generatingTitleDotVisible(k, 13, now));
    expect(dots(0)).toEqual([true, false, false]);
    expect(dots(400)).toEqual([true, true, false]);
    expect(dots(800)).toEqual([true, true, true]);
    expect(dots(1200)).toEqual(dots(0));
    expect(generatingTitleDotVisible(0, 13, 0)).toBe(true);
  });
  it('never shows an eternal spinner after a reload or on another version', () => {
    const node = { currentVersionIndex: 0, versions: [{ imageTitleState: 'pending' }] } as ScatterNode;
    expect(isImageTitlePending(node)).toBe(false);
    expect(isImageTitlePending({ ...node, generating: true })).toBe(true);
    expect(isImageTitlePending({ ...node, generating: true, generatingVersionIndex: 1 })).toBe(false);
  });
});
