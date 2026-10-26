import { describe, it, expect } from 'vitest';
import {
  classifyLink, classifyFile, parseYouTubeId, parseVimeoId, isLargeVideo, LARGE_VIDEO_BYTES,
} from './mediaDetect';

describe('parseYouTubeId', () => {
  it('reads the watch?v= form (ignoring extra params)', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ');
  });
  it('reads the youtu.be short form', () => {
    expect(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc')).toBe('dQw4w9WgXcQ');
  });
  it('reads /embed/ and /shorts/ forms', () => {
    expect(parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });
  it('returns null for non-YouTube urls', () => {
    expect(parseYouTubeId('https://example.com/watch?v=nope')).toBeNull();
    expect(parseYouTubeId('https://vimeo.com/12345')).toBeNull();
  });
});

describe('parseVimeoId', () => {
  it('reads vimeo.com/<digits>', () => {
    expect(parseVimeoId('https://vimeo.com/123456789')).toBe('123456789');
  });
  it('reads player.vimeo.com/video/<digits>', () => {
    expect(parseVimeoId('https://player.vimeo.com/video/123456789?h=abc')).toBe('123456789');
  });
  it('returns null for non-Vimeo urls', () => {
    expect(parseVimeoId('https://youtube.com/watch?v=x')).toBeNull();
    expect(parseVimeoId('https://vimeo.com/channels/staff')).toBeNull();
  });
});

describe('classifyLink', () => {
  it('classifies YouTube as an embed', () => {
    const r = classifyLink('https://youtu.be/dQw4w9WgXcQ');
    expect(r).toMatchObject({ kind: 'embed', provider: 'youtube', embedId: 'dQw4w9WgXcQ' });
  });
  it('classifies Vimeo as an embed', () => {
    const r = classifyLink('https://vimeo.com/123456789');
    expect(r).toMatchObject({ kind: 'embed', provider: 'vimeo', embedId: '123456789' });
  });
  it('classifies image urls by extension (case + query insensitive)', () => {
    expect(classifyLink('https://x.com/a/b/photo.JPG')).toMatchObject({ kind: 'image' });
    expect(classifyLink('https://x.com/p.png?w=200')).toMatchObject({ kind: 'image' });
    expect(classifyLink('https://x.com/p.webp#frag')).toMatchObject({ kind: 'image' });
  });
  it('classifies video urls by extension', () => {
    expect(classifyLink('https://x.com/clip.mp4')).toMatchObject({ kind: 'video' });
    expect(classifyLink('https://x.com/clip.webm?t=1')).toMatchObject({ kind: 'video' });
  });
  it('rejects unsupported extensions and non-urls', () => {
    expect(classifyLink('https://x.com/photo.heic')).toMatchObject({ kind: 'unsupported' });
    expect(classifyLink('https://x.com/movie.mkv')).toMatchObject({ kind: 'unsupported' });
    expect(classifyLink('not a url')).toMatchObject({ kind: 'unsupported' });
    expect(classifyLink('')).toMatchObject({ kind: 'unsupported' });
  });
});

describe('classifyFile', () => {
  it('uses the MIME type first', () => {
    expect(classifyFile({ name: 'a.bin', type: 'image/png' })).toMatchObject({ kind: 'image' });
    expect(classifyFile({ name: 'a.bin', type: 'video/mp4' })).toMatchObject({ kind: 'video' });
  });
  it('falls back to the extension when MIME is empty', () => {
    expect(classifyFile({ name: 'pic.gif', type: '' })).toMatchObject({ kind: 'image' });
    expect(classifyFile({ name: 'clip.webm', type: '' })).toMatchObject({ kind: 'video' });
  });
  it('rejects unsupported types (HEIC, MKV)', () => {
    expect(classifyFile({ name: 'p.heic', type: 'image/heic' })).toMatchObject({ kind: 'unsupported' });
    expect(classifyFile({ name: 'm.mkv', type: 'video/x-matroska' })).toMatchObject({ kind: 'unsupported' });
  });
});

describe('isLargeVideo', () => {
  it('is true strictly above the threshold', () => {
    expect(isLargeVideo(LARGE_VIDEO_BYTES + 1)).toBe(true);
    expect(isLargeVideo(LARGE_VIDEO_BYTES)).toBe(false);
    expect(isLargeVideo(1024)).toBe(false);
  });
});
