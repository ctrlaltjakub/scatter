import { describe, expect, it } from 'vitest';
import { DEFAULT_ASCII_OPACITY, normalizeAsciiOpacity } from './opacity';

describe('global ASCII opacity', () => {
  it.each([undefined, null, '0', NaN, Infinity, -Infinity, {}])('repairs invalid or missing values: %s', value => {
    expect(normalizeAsciiOpacity(value)).toBe(DEFAULT_ASCII_OPACITY);
  });
  it.each([[0, 0], [50, 50], [100, 100], [200, 200], [-10, 0], [500, 200], [123.6, 124]])(
    'normalizes %s to %s', (value, expected) => {
      expect(normalizeAsciiOpacity(value)).toBe(expected);
    },
  );
});
