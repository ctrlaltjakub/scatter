import { describe, expect, it } from 'vitest';
import { asciiOpacityMultipliers, DEFAULT_ASCII_OPACITY, normalizeAsciiOpacity } from './opacity';

describe('global ASCII opacity', () => {
  it('lets labels follow the global setting, or replace it without multiplying it', () => {
    const settings = { asciiOpacity: 50, asciiLabelOpacity: 125, asciiLabelOpacityEnabled: false };
    expect(asciiOpacityMultipliers(settings)).toEqual({ aura: 0.5, label: 0.5 });
    expect(asciiOpacityMultipliers({ ...settings, asciiLabelOpacityEnabled: true })).toEqual({ aura: 0.5, label: 1.25 });
    expect(asciiOpacityMultipliers({ ...settings, asciiOpacity: 0, asciiLabelOpacityEnabled: true }))
      .toEqual({ aura: 0, label: 1.25 });
    expect(asciiOpacityMultipliers({ ...settings, asciiLabelOpacity: 0, asciiLabelOpacityEnabled: true }))
      .toEqual({ aura: 0.5, label: 0 });
  });
  it.each([undefined, null, '0', NaN, Infinity, -Infinity, {}])('repairs invalid or missing values: %s', value => {
    expect(normalizeAsciiOpacity(value)).toBe(DEFAULT_ASCII_OPACITY);
  });
  it.each([[0, 0], [50, 50], [100, 100], [200, 200], [-10, 0], [500, 200], [123.6, 124]])(
    'normalizes %s to %s', (value, expected) => {
      expect(normalizeAsciiOpacity(value)).toBe(expected);
    },
  );
});
