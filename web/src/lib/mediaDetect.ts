/**
 * Pure classification for the single media link field + the file picker.
 *
 * No DOM, no network — fully unit-testable. The one link field auto-detects
 * whether a pasted URL is an image, a video file, or a YouTube/Vimeo video, so
 * the user never has to pick a category. The file picker / drag / paste route
 * through classifyFile.
 */

export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg'] as const;
export const VIDEO_EXT = ['mp4', 'webm'] as const;
export const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml'];
export const VIDEO_MIME = ['video/mp4', 'video/webm'];

/** Local videos above this size get a gentle "this'll make the project heavy"
 *  heads-up (never a hard block). */
export const LARGE_VIDEO_BYTES = 50 * 1024 * 1024;

/** Human-readable list of what's accepted — shown in the "unsupported" card. */
export const SUPPORTED_SUMMARY =
  'Works with image files (JPG, PNG, GIF, WebP, AVIF, SVG) and video files (MP4, WebM), ' +
  'plus YouTube and Vimeo links. For other video sites, use a direct file link.';

export type MediaProvider = 'youtube' | 'vimeo';

export type LinkClass =
  | { kind: 'image'; url: string }
  | { kind: 'video'; url: string }
  | { kind: 'embed'; provider: MediaProvider; embedId: string; url: string }
  | { kind: 'unsupported'; reason: string };

export type FileClass =
  | { kind: 'image' }
  | { kind: 'video' }
  | { kind: 'unsupported'; reason: string };

/** Lowercase file extension of a URL or filename, ignoring query/hash. Returns
 *  null when there's no extension. */
export function extensionOf(urlOrName: string): string | null {
  let path = urlOrName;
  try {
    // Parse as a URL to drop query/hash and host; fall back to the raw string
    // for bare filenames.
    path = new URL(urlOrName).pathname;
  } catch {
    path = urlOrName.split('?')[0]!.split('#')[0]!;
  }
  const seg = path.split('/').pop() ?? '';
  const dot = seg.lastIndexOf('.');
  if (dot < 0 || dot === seg.length - 1) return null;
  return seg.slice(dot + 1).toLowerCase();
}

export function parseYouTubeId(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
    if (m) return m[2] ?? null;
  }
  return null;
}

export function parseVimeoId(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'vimeo.com') {
    const m = u.pathname.match(/^\/(\d+)\b/);
    return m ? m[1]! : null;
  }
  if (host === 'player.vimeo.com') {
    const m = u.pathname.match(/^\/video\/(\d+)\b/);
    return m ? m[1]! : null;
  }
  return null;
}

export function classifyLink(raw: string): LinkClass {
  const url = raw.trim();
  if (!url) return { kind: 'unsupported', reason: 'Enter a link first.' };

  const yt = parseYouTubeId(url);
  if (yt) return { kind: 'embed', provider: 'youtube', embedId: yt, url };
  const vm = parseVimeoId(url);
  if (vm) return { kind: 'embed', provider: 'vimeo', embedId: vm, url };

  // Past this point we need a real http(s) URL pointing at a file.
  let valid = false;
  try {
    const u = new URL(url);
    valid = u.protocol === 'http:' || u.protocol === 'https:';
  } catch { valid = false; }
  if (!valid) {
    return { kind: 'unsupported', reason: "That doesn't look like a valid link." };
  }

  const ext = extensionOf(url);
  if (ext && (IMAGE_EXT as readonly string[]).includes(ext)) return { kind: 'image', url };
  if (ext && (VIDEO_EXT as readonly string[]).includes(ext)) return { kind: 'video', url };

  return {
    kind: 'unsupported',
    reason: ext
      ? `Links to ".${ext}" files aren't supported.`
      : "That link isn't a direct image/video file or a YouTube/Vimeo video.",
  };
}

export function classifyFile(file: { name: string; type: string }): FileClass {
  const mime = (file.type || '').toLowerCase();
  if (IMAGE_MIME.includes(mime)) return { kind: 'image' };
  if (VIDEO_MIME.includes(mime)) return { kind: 'video' };

  // MIME missing or unrecognised → fall back to the extension.
  const ext = extensionOf(file.name);
  if (ext && (IMAGE_EXT as readonly string[]).includes(ext)) return { kind: 'image' };
  if (ext && (VIDEO_EXT as readonly string[]).includes(ext)) return { kind: 'video' };

  const label = ext ? `.${ext}` : (mime || 'this');
  return { kind: 'unsupported', reason: `${label} files aren't supported.` };
}

export function isLargeVideo(byteSize: number): boolean {
  return byteSize > LARGE_VIDEO_BYTES;
}
