import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chooseWikimediaCredit,
  displayWikimediaCredit,
  displayWikimediaCreator,
  enrichWikimediaFiles,
  plainMetadata,
  searchCommonsImages,
  searchCommonsImagePage,
  searchWikipediaLeadImages,
} from './wikimediaApi';

afterEach(() => vi.restoreAllMocks());

describe('Wikimedia API normalization', () => {
  it('preserves relevance order rather than MediaWiki page-id order and exposes pagination', async () => {
    const page = (pageid: number, index: number) => ({ pageid, index, title: `File:${pageid}.png`, imageinfo: [{
      url: `https://upload.wikimedia.org/${pageid}.png`, thumburl: `https://upload.wikimedia.org/thumb-${pageid}.png`, mime: 'image/png',
    }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [page(1, 3), page(500, 1), page(2, 2)] }, continue: { gsroffset: 48 },
    })));
    const result = await searchCommonsImagePage('House of Leaves', undefined, { offset: 24, limit: 24 });
    expect(result.results.map(item => item.pageId)).toEqual([500, 2, 1]);
    expect(result.nextOffset).toBe(48);
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get('gsroffset')).toBe('24');
    expect(url.searchParams.get('gsrlimit')).toBe('24');
  });
  it('keeps Wikipedia article identity while excluding non-free images from free search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: { pages: [{ title: 'Neuron', pageimage: 'Neuron_diagram.svg', index: 1 }] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: { pages: [{ pageid: 8, title: 'File:Neuron diagram.svg', imageinfo: [{
        url: 'https://upload.wikimedia.org/neuron.svg', thumburl: 'https://upload.wikimedia.org/neuron.png', mime: 'image/svg+xml',
      }] }] } })));
    const [result] = await searchWikipediaLeadImages('Neuron', 'en');
    expect(result).toMatchObject({ articleTitle: 'Neuron', articleUrl: 'https://en.wikipedia.org/wiki/Neuron' });
    expect(new URL(String(fetchSpy.mock.calls[0]![0])).searchParams.get('pilicense')).toBe('free');
  });
  it('turns Commons HTML metadata into readable text', () => {
    expect(plainMetadata('<b>Jane Doe</b><br>Public domain')).toBe('Jane Doe Public domain');
  });

  it('filters non-images and retains metadata-only candidates', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [
        { pageid: 1, title: 'File:Diagram.svg', imageinfo: [{
          url: 'https://upload.wikimedia.org/original.svg',
          thumburl: 'https://upload.wikimedia.org/thumb.png',
          mime: 'image/svg+xml', width: 2000, height: 1000,
          extmetadata: { ObjectName: { value: 'Useful diagram' } },
        }] },
        { pageid: 2, title: 'File:Book.pdf', imageinfo: [{
          url: 'https://upload.wikimedia.org/book.pdf',
          thumburl: 'https://upload.wikimedia.org/book.png',
          mime: 'application/pdf',
        }] },
      ] },
    }), { status: 200 }));
    const results = await searchCommonsImages('diagram');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ fileTitle: 'File:Diagram.svg', caption: 'Useful diagram' });
  });

  it('builds persistent attribution from Commons metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{ pageid: 9, title: 'File:Cell.png', imageinfo: [{
        url: 'https://upload.wikimedia.org/cell.png',
        thumburl: 'https://upload.wikimedia.org/cell-1600.png',
        mime: 'image/png', width: 1600, height: 900,
        extmetadata: {
          ObjectName: { value: 'Cell structure' },
          Artist: { value: '<a>Researcher</a>' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0/' },
          Credit: { value: 'Researcher / Wikimedia Commons' },
        },
      }] }] },
    }), { status: 200 }));
    const [result] = await enrichWikimediaFiles(['File:Cell.png']);
    expect(result).toMatchObject({
      caption: 'Cell structure', creator: 'Researcher', license: 'CC BY-SA 4.0',
      creditLine: 'Researcher',
    });
    expect(result?.filePageUrl).toContain('commons.wikimedia.org/wiki/');
  });

  it('rejects gallery dumps in Commons Credit metadata and uses the creator', async () => {
    const galleryCredit = [
      '_US_Navy_100723-N-7214P-020_Physical_therapy.jpg',
      '_US_Navy_090508-F-7885G-021_Physical_therapy.jpg',
      '_US_Navy_070917-N-8704K-072_Physical_therapy.jpg',
      '_US_Navy_020128-N-6077T-008_Medical_treatment.jpg',
    ].join(' ');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      query: { pages: [{ pageid: 10, title: 'File:Physical Therapists at work.jpg', imageinfo: [{
        url: 'https://upload.wikimedia.org/physical-therapy.jpg',
        thumburl: 'https://upload.wikimedia.org/physical-therapy-1600.jpg',
        mime: 'image/jpeg', width: 1600, height: 1067,
        extmetadata: {
          ObjectName: { value: 'Physical Therapists at work' },
          Artist: { value: '<span>U.S. Navy</span>' },
          LicenseShortName: { value: 'Public domain' },
          Credit: { value: galleryCredit },
        },
      }] }] },
    }), { status: 200 }));

    const [result] = await enrichWikimediaFiles(['File:Physical Therapists at work.jpg']);
    expect(result?.creditLine).toBe('U.S. Navy');
    expect(result?.creditLine).not.toContain('.jpg');
  });

  it('compacts malformed credits already saved by older builds', () => {
    const oldResult = {
      creator: 'U.S. Navy',
      creditLine: Array.from({ length: 8 }, (_, index) => `_US_Navy_${index}_therapy.jpg`).join(' '),
    };
    expect(displayWikimediaCredit(oldResult)).toBe('U.S. Navy');
    expect(chooseWikimediaCredit({ credit: oldResult.creditLine })).toBe('Wikimedia Commons');
  });

  it('does not expose a gallery dump stored as the creator either', () => {
    const gallery = Array.from({ length: 8 }, (_, index) => `_US_Navy_${index}_therapy.jpg`).join(' ');
    const result = { creator: gallery, creditLine: gallery };
    expect(displayWikimediaCreator(result)).toBeUndefined();
    expect(displayWikimediaCredit(result)).toBe('Wikimedia Commons');
  });

  it('preserves Wikimedia rate-limit information for partial combined searches', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', {
      status: 429,
      headers: { 'Retry-After': '45' },
    }));
    await expect(searchCommonsImages('cell diagram')).rejects.toMatchObject({
      name: 'ImageCatalogError', source: 'wikimedia', kind: 'rate-limited',
      retryAt: expect.any(Number),
    });
  });
});
