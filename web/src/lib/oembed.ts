/**
 * Fetch a YouTube/Vimeo video's real title (+ thumbnail) via their
 * CORS-friendly oEmbed endpoints — no API key, works from the browser.
 *
 * A failed/blocked fetch degrades gracefully: YouTube still gets a thumbnail
 * (the predictable i.ytimg.com URL) so the play-poster shows; Vimeo returns
 * null and the caller keeps a generic header.
 */
import type { MediaProvider } from './mediaDetect';

export interface OEmbedResult {
  title: string;
  thumbnailUrl?: string;
}

export function youtubeOEmbedUrl(embedId: string): string {
  const target = `https://www.youtube.com/watch?v=${embedId}`;
  return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target)}`;
}

export function vimeoOEmbedUrl(embedId: string): string {
  const target = `https://vimeo.com/${embedId}`;
  return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(target)}`;
}

/** Keyless YouTube thumbnail (no oEmbed needed). */
export function youtubeThumbnail(embedId: string): string {
  return `https://i.ytimg.com/vi/${embedId}/hqdefault.jpg`;
}

export async function fetchOEmbed(provider: MediaProvider, embedId: string): Promise<OEmbedResult | null> {
  const ytFallback = (): OEmbedResult | null =>
    provider === 'youtube' ? { title: '', thumbnailUrl: youtubeThumbnail(embedId) } : null;
  try {
    const url = provider === 'youtube' ? youtubeOEmbedUrl(embedId) : vimeoOEmbedUrl(embedId);
    const res = await fetch(url);
    if (!res.ok) return ytFallback();
    const data = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
    const title = typeof data.title === 'string' ? data.title : '';
    const thumbnailUrl =
      typeof data.thumbnail_url === 'string'
        ? data.thumbnail_url
        : provider === 'youtube'
          ? youtubeThumbnail(embedId)
          : undefined;
    return { title, thumbnailUrl };
  } catch {
    return ytFallback();
  }
}
