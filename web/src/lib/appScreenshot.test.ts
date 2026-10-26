import { describe, expect, it } from 'vitest';
import { screenshotDimensions } from './appScreenshot';
describe('screenshot export geometry', () => {
  it.each([[800, 450, 2560, 1440], [450, 800, 1440, 2560], [300, 300, 2560, 2560], [5120, 2880, 2560, 1440]])(
    'preserves %s×%s proportions at the actual export density', (width, height, outWidth, outHeight) => {
      expect(screenshotDimensions({ x: 20, y: 30, width, height })).toEqual({ width: outWidth, height: outHeight, pixelRatio: 2560 / Math.max(width, height) });
    });
  it('rejects invalid bounds', () => {
    expect(() => screenshotDimensions({ x: 0, y: 0, width: 0, height: 300 })).toThrow();
  });
});
