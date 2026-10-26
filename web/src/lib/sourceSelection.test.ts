import { describe, expect, it } from 'vitest';
import {
  createArrowSourceSelection,
  resolveArrowSourceSelection,
} from './sourceSelection';

const source = `Opening alpha.\n\n- Topic\n  - First: hidden one\n  - Second: hidden two`;

describe('arrow source selections', () => {
  it('resolves exact-version parts without including hidden source intervals', () => {
    const first = source.indexOf('First');
    const second = source.indexOf('Second');
    const anchor = createArrowSourceSelection({
      nodeId: 'parent',
      versionIndex: 0,
      sourceBody: source,
      start: first,
      end: second + 6,
      text: 'First\nSecond',
      parts: [
        { sourceField: 'b:0:c:0:name', start: first, end: first + 5, text: 'First' },
        { sourceField: 'b:0:c:1:name', start: second, end: second + 6, text: 'Second' },
      ],
    }, 100, 200);

    expect(resolveArrowSourceSelection(source, 100, anchor)).toEqual({
      text: 'First Second',
      createdAt: 200,
      parts: [
        { sourceField: 'b:0:c:0:name', displayStart: 0, displayEnd: 5, text: 'First' },
        { sourceField: 'b:0:c:1:name', displayStart: 0, displayEnd: 6, text: 'Second' },
      ],
    });
  });

  it('remaps only one occurrence in the same field', () => {
    const start = source.indexOf('alpha');
    const anchor = createArrowSourceSelection({
      nodeId: 'parent',
      versionIndex: 0,
      sourceBody: source,
      start,
      end: start + 5,
      text: 'alpha',
      parts: [{ sourceField: 'ft', start, end: start + 5, text: 'alpha' }],
    }, 100, 200);

    expect(resolveArrowSourceSelection('Revised alpha opening.\n\n- Topic', 300, anchor)?.parts[0])
      .toMatchObject({ displayStart: 8, displayEnd: 13, text: 'alpha' });
    expect(resolveArrowSourceSelection('alpha then alpha.\n\n- Topic', 300, anchor)).toBeNull();
  });

  it('hides the whole multi-part relation when one part cannot resolve', () => {
    const first = source.indexOf('First');
    const second = source.indexOf('Second');
    const anchor = createArrowSourceSelection({
      nodeId: 'parent',
      versionIndex: 0,
      sourceBody: source,
      start: first,
      end: second + 6,
      text: 'First\nSecond',
      parts: [
        { sourceField: 'b:0:c:0:name', start: first, end: first + 5, text: 'First' },
        { sourceField: 'b:0:c:1:name', start: second, end: second + 6, text: 'Second' },
      ],
    }, 100, 200);
    const missingSecond = `Opening alpha.\n\n- Topic\n  - First: hidden one`;

    expect(resolveArrowSourceSelection(missingSecond, 300, anchor)).toBeNull();
  });

  it('normalizes stored relation text and rejects selections without semantic parts', () => {
    expect(createArrowSourceSelection({
      nodeId: 'parent',
      versionIndex: 0,
      sourceBody: source,
      start: 0,
      end: 7,
      text: ' Opening\nalpha ',
    }, 100, 200)).toBeNull();
  });
});
