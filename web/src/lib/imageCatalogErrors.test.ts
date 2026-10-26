import { describe, expect, it } from 'vitest';
import { retryAtFromHeaders } from './imageCatalogErrors';

describe('image catalog retry headers', () => {
  it('parses Retry-After seconds and dates', () => {
    expect(retryAtFromHeaders(new Headers({ 'Retry-After': '60' }), 1_000)).toBe(61_000);
    expect(retryAtFromHeaders(new Headers({ 'Retry-After': 'Thu, 01 Jan 1970 00:02:00 GMT' }), 1_000))
      .toBe(120_000);
  });

  it('distinguishes relative RateLimit-Reset from absolute X-RateLimit-Reset', () => {
    expect(retryAtFromHeaders(new Headers({ 'RateLimit-Reset': '30' }), 10_000)).toBe(40_000);
    expect(retryAtFromHeaders(new Headers({ 'X-RateLimit-Reset': '200' }), 10_000)).toBe(200_000);
  });
});
