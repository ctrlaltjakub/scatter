import { describe, expect, it, vi } from 'vitest';
import { markTerms, termBatches, markedTerms } from './termMarking';

describe('term marking with rich text extensions', () => {
  it('skips embedded files without making hundreds of paid text batches', async () => {
    const image = '![Figure](data:image/png;base64,' + 'abcd'.repeat(5000) + ')';
    const body = `Therapy before ${image} and code after.`;
    const batches = termBatches(body);
    expect(batches.map(batch => batch.text).join('')).toBe(body);
    expect(batches.filter(batch => !batch.skip)).toHaveLength(2);
    const complete = vi.fn(async ({ user }: { user: string }) => {
      expect(user).not.toContain('base64');
      return '{"terms":["Therapy", "code"]}';
    });
    const marked = await markTerms(body, new AbortController().signal, complete);
    expect(marked.body).toContain(image);
    expect(marked.body.replace(image, '<IMAGE>')).toBe('[[Therapy]] before <IMAGE> and [[code]] after.');
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('does not treat math or hidden comments as explorable terms', () => {
    expect(markedTerms('%%[[Hidden]]%% $[[Math]]$ and ==[[Therapy]]==')).toEqual(['Therapy']);
  });
});
