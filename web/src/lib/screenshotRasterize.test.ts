import { describe, expect, it } from 'vitest';
import { normalizeScreenshotControls, rasterizeScreenshotSvg } from './screenshotRasterize';

describe('screenshot control rendering', () => {
  it.each(['0', '-1', 'NaN', 'Infinity'])('identifies invalid dimensions (%s) without claiming memory exhaustion', async width => {
    const svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="720"/>`)}`;
    await expect(rasterizeScreenshotSvg(svg, 1, normalizeScreenshotControls)).rejects.toThrow('screenshot dimensions are invalid');
  });
  it('renders native controls as vectors and preserves custom CSS indicators', () => {
    const doc = new DOMParser().parseFromString('<div><input id="native" type="checkbox" checked style="appearance:auto;accent-color:rgb(10, 100, 200);width:24px;height:24px"><input id="custom" type="checkbox" style="appearance:none"><input id="mixed" type="checkbox" data-sc-capture-mixed><input id="radio" type="radio"></div>', 'text/html');
    normalizeScreenshotControls(doc);
    expect(doc.querySelector('svg#native path')).not.toBeNull();
    expect(doc.querySelector('svg#native rect')?.getAttribute('fill')).toBe('rgb(10, 100, 200)');
    expect(doc.querySelector('input#custom')).not.toBeNull();
    expect(doc.querySelector('svg#mixed path')?.getAttribute('d')).toBe('M5 10H15');
    expect(doc.querySelector('svg#radio rect')?.getAttribute('rx')).toBe('9');
  });
});
