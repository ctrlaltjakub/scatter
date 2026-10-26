import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAVICON_URL, FAVICON_S_PATH, projectFaviconSvg, projectFaviconUrl } from './favicon';

describe('project favicon', () => {
  it('ships the same font outline as the dynamic favicon, black on transparency', () => {
    expect(readFileSync('public/favicon.svg', 'utf8').trim()).toBe(projectFaviconSvg('#000000'));
  });
  it('defaults to black without a project', () => {
    expect(projectFaviconUrl(null)).toBe(DEFAULT_FAVICON_URL);
    expect(projectFaviconUrl(undefined)).toBe(DEFAULT_FAVICON_URL);
  });
  it('uses the project color with no background', () => {
    const svg = decodeURIComponent(projectFaviconUrl('#e7298a').split(',')[1]!);
    expect(svg).toContain('fill="#e7298a"');
    expect(svg.match(/<path\b/g)).toHaveLength(1);
    expect(svg).toContain('viewBox="0 0 7 7" shape-rendering="crispEdges"');
    expect(svg).not.toContain('<text');
  });
  it('fits the full letter exactly inside the favicon without clipping or padding', () => {
    const svg = projectFaviconSvg('#000000');
    expect(svg).toContain('transform="translate(0 8) scale(.008 -.008)"');
    // Original glyph bounds: x = 0..875, y = 125..1000.
    expect([0 * .008, 875 * .008, 8 - 1000 * .008, 8 - 125 * .008]).toEqual([0, 7, 0, 7]);
    expect([...FAVICON_S_PATH.matchAll(/\d+/g)].every(([n]) => Number(n) % 125 === 0)).toBe(true);
    expect(svg).not.toMatch(/<(?:circle|rect)\b/);
  });
  it('does not interpolate malformed colors into SVG markup', () => {
    const svg = projectFaviconSvg('"/><script>bad</script>');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('fill="#000000"');
  });
});
