import { describe, expect, it } from 'vitest';
import { inlineEmphasis } from './inlineEmphasis';

describe('legacy inline emphasis', () => {
  it('keeps original offsets when accepting a legacy connecting-word span', () => {
    const text = '[[**left**]]** and **[[**right**]]';
    const start = text.indexOf('** and **');
    expect(inlineEmphasis(text).get(start)).toEqual({ tag: 'strong', contentStart: start + 2,
      contentEnd: start + 7, end: start + 9 });
    expect(text.slice(start + 2, start + 7)).toBe(' and ');
  });
  it.each(['Literal ** spaced ** text.', '2 * 3 and file_name.', '`[[**left**]]** and **[[**right**]]`'])('leaves ordinary literal markers and code unchanged: %s', text => {
    expect(inlineEmphasis(text).size).toBe(0);
  });
});
