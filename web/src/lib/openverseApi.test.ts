import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageCatalogError } from './imageCatalogErrors';
import { searchOpenverseImages, searchOpenverseImagePage } from './openverseApi';

afterEach(() => vi.restoreAllMocks());

describe('Openverse image API', () => {
  it('preserves direct queries, enforces the anonymous page-size limit, and follows catalog pages', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [], page_count: 4 })));
    const result = await searchOpenverseImagePage('"House of Leaves"', undefined, { page: 2, pageSize: 24 });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('q')).toBe('"House of Leaves"');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(result.nextPage).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('uses one bounded metadata-only query and normalizes attribution', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [{
        id: 'ov-1', title: 'Empty chair exercise',
        foreign_landing_url: 'https://example.org/work/1',
        url: 'https://example.org/original.jpg',
        thumbnail: 'https://api.openverse.org/thumb/1',
        creator: 'Jane Doe', creator_url: 'https://example.org/jane',
        license: 'by', license_version: '4.0',
        license_url: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: '“Empty chair exercise” by Jane Doe is licensed under CC BY 4.0.',
        provider: 'flickr', source: 'flickr', mature: false,
        width: 1200, height: 800,
        tags: [{ name: 'therapy' }, { name: 'chair' }],
        fields_matched: ['title', 'tags'],
      }],
    }), { status: 200 }));

    const [result] = await searchOpenverseImages('schema therapy | "empty chair"');
    const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(requested.searchParams.get('excluded_source')).toBe('wikimedia');
    expect(requested.searchParams.get('mature')).toBe('false');
    expect(requested.searchParams.get('q')).toBe('schema therapy | "empty chair"');
    expect(result).toMatchObject({
      source: 'openverse', sourceId: 'ov-1', caption: 'Empty chair exercise',
      landingPageUrl: 'https://example.org/work/1', creator: 'Jane Doe',
      license: 'BY 4.0', provider: 'flickr', tags: ['therapy', 'chair'],
    });
  });

  it('drops mature or unusable records', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      results: [
        { id: 'mature', mature: true, thumbnail: 'https://thumb', url: 'https://file', foreign_landing_url: 'https://page' },
        { id: 'missing-file', mature: false, thumbnail: 'https://thumb', foreign_landing_url: 'https://page' },
      ],
    }), { status: 200 }));
    expect(await searchOpenverseImages('test')).toEqual([]);
  });

  it('falls back to the simple topic when a restrictive compound query has too few candidates', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{
          id: 'kombucha-1', title: 'Kombucha jar', mature: false,
          foreign_landing_url: 'https://example.org/kombucha',
          url: 'https://example.org/kombucha.jpg',
          thumbnail: 'https://api.openverse.org/thumb/kombucha-1',
          license: 'by', license_version: '4.0',
        }],
      }), { status: 200 }));

    const results = await searchOpenverseImages(
      '"kombucha SCOBY" | "kombucha brewing"',
      undefined,
      { fallbackQuery: 'Kombucha', minimumCandidates: 3 },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchSpy.mock.calls[1]?.[0])).searchParams.get('q')).toBe('Kombucha');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ source: 'openverse', sourceId: 'kombucha-1' });
  });

  it('surfaces rate limits with the supplied retry time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));
    await expect(searchOpenverseImages('test')).rejects.toMatchObject({
      name: 'ImageCatalogError', source: 'openverse', kind: 'rate-limited',
    } satisfies Partial<ImageCatalogError>);
  });
});
