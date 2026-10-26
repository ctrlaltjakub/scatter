import { describe, it, expect, vi, afterEach } from 'vitest';
import { youtubeOEmbedUrl, vimeoOEmbedUrl, youtubeThumbnail, fetchOEmbed } from './oembed';

afterEach(() => { vi.unstubAllGlobals(); });

describe('oEmbed url builders', () => {
  it('builds the YouTube oEmbed endpoint', () => {
    expect(youtubeOEmbedUrl('abc123')).toBe(
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=abc123'),
    );
  });
  it('builds the Vimeo oEmbed endpoint', () => {
    expect(vimeoOEmbedUrl('123')).toBe(
      'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent('https://vimeo.com/123'),
    );
  });
  it('builds a YouTube thumbnail url', () => {
    expect(youtubeThumbnail('abc123')).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  });
});

describe('fetchOEmbed', () => {
  it('returns title + thumbnail on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ title: 'A Video', thumbnail_url: 'https://t/x.jpg' }),
    })));
    const r = await fetchOEmbed('youtube', 'abc');
    expect(r).toEqual({ title: 'A Video', thumbnailUrl: 'https://t/x.jpg' });
  });

  it('falls back to a YouTube thumbnail when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const r = await fetchOEmbed('youtube', 'abc');
    expect(r).toEqual({ title: '', thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' });
  });

  it('returns null when a Vimeo fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    const r = await fetchOEmbed('vimeo', '123');
    expect(r).toBeNull();
  });
});
