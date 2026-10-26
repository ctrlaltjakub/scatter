import type { WikimediaImageRecommendation } from '@/store/types';
import { catalogResponseError } from './imageCatalogErrors';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const MAX_CANDIDATES_PER_QUERY = 14;

interface CommonsImageInfo {
  url?: string;
  thumburl?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: Record<string, { value?: string }>;
}

interface CommonsPage {
  pageid?: number;
  index?: number;
  title?: string;
  imageinfo?: CommonsImageInfo[];
}

export interface WikimediaCandidate {
  pageId: number;
  fileTitle: string;
  thumbnailUrl: string;
  originalUrl: string;
  mime?: string;
  width?: number;
  height?: number;
  caption?: string;
  description?: string;
  creator?: string;
  license?: string;
  licenseUrl?: string;
  creatorUrl?: string;
  creditLine?: string;
  articleTitle?: string;
  articleUrl?: string;
}

const TAG_RE = /<[^>]*>/g;
const SPACE_RE = /\s+/g;
const IMAGE_FILE_TOKEN_RE = /(?:\bFile\s*:|[^\s]+\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)\b)/gi;
const MAX_CREDIT_LENGTH = 240;

export function plainMetadata(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const doc = typeof document !== 'undefined' ? document.createElement('textarea') : null;
  if (doc) doc.innerHTML = value.replace(TAG_RE, ' ');
  const text = (doc?.value ?? value.replace(TAG_RE, ' '))
    .replace(SPACE_RE, ' ')
    .trim();
  return text || undefined;
}

/** Commons' `Credit` field is not guaranteed to be a short attribution. Some
 * files use it for an entire gallery of related filenames. Never surface or
 * persist those gallery dumps as a credit line. */
export function isConciseWikimediaCredit(value: string | undefined): boolean {
  const text = plainMetadata(value);
  if (!text || text.length > MAX_CREDIT_LENGTH) return false;
  const fileTokens = text.match(IMAGE_FILE_TOKEN_RE)?.length ?? 0;
  return fileTokens <= 1;
}

export function chooseWikimediaCredit(
  values: { attribution?: string; creator?: string; credit?: string },
): string {
  for (const value of [values.attribution, values.creator, values.credit]) {
    const text = plainMetadata(value);
    if (text && isConciseWikimediaCredit(text)) return text;
  }
  return 'Wikimedia Commons';
}

export function displayWikimediaCreator(
  result: Pick<WikimediaImageRecommendation, 'creator'>,
): string | undefined {
  const creator = plainMetadata(result.creator);
  return creator && isConciseWikimediaCredit(creator) ? creator : undefined;
}

/** Also normalizes recommendations already stored by older Scatter builds. */
export function displayWikimediaCredit(
  result: Pick<WikimediaImageRecommendation, 'creditLine' | 'creator'>,
): string {
  const storedCredit = plainMetadata(result.creditLine);
  if (storedCredit && isConciseWikimediaCredit(storedCredit)) return storedCredit;
  return chooseWikimediaCredit({ creator: result.creator });
}

function metadata(info: CommonsImageInfo, key: string): string | undefined {
  return plainMetadata(info.extmetadata?.[key]?.value);
}

function metadataLink(info: CommonsImageInfo, key: string): string | undefined {
  const value = info.extmetadata?.[key]?.value;
  const href = value?.match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return undefined;
  try { return new URL(href, 'https://commons.wikimedia.org').toString(); }
  catch { return undefined; }
}

function filePageUrl(title: string): string {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function cleanFileName(title: string): string {
  return title.replace(/^File:/i, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

function pageToCandidate(page: CommonsPage): WikimediaCandidate | null {
  const info = page.imageinfo?.[0];
  const title = page.title;
  if (!info?.url || !info.thumburl || !title || page.pageid == null) return null;
  if (info.mime && !/^image\//i.test(info.mime)) return null;
  const caption = metadata(info, 'ObjectName') ?? metadata(info, 'ImageDescription');
  return {
    pageId: page.pageid,
    fileTitle: title,
    thumbnailUrl: info.thumburl,
    originalUrl: info.url,
    mime: info.mime,
    width: info.width,
    height: info.height,
    caption: caption ?? cleanFileName(title),
    description: metadata(info, 'ImageDescription'),
    creator: displayWikimediaCreator({ creator: metadata(info, 'Artist') }),
    license: metadata(info, 'LicenseShortName') ?? metadata(info, 'UsageTerms'),
    licenseUrl: info.extmetadata?.LicenseUrl?.value,
    creatorUrl: metadataLink(info, 'Artist'),
    creditLine: chooseWikimediaCredit({ attribution: metadata(info, 'Attribution'), creator: metadata(info, 'Artist'), credit: metadata(info, 'Credit') }),
  };
}

async function commonsPageRequest(params: URLSearchParams, signal?: AbortSignal): Promise<{ pages: CommonsPage[]; nextOffset?: number }> {
  params.set('origin', '*');
  params.set('format', 'json');
  params.set('formatversion', '2');
  if (!params.has('uselang') && typeof navigator !== 'undefined') {
    params.set('uselang', (navigator.language || 'en').split('-')[0] || 'en');
  }
  const response = await fetch(`${COMMONS_API}?${params}`, { signal });
  if (!response.ok) throw await catalogResponseError('wikimedia', response);
  const json = await response.json() as { query?: { pages?: CommonsPage[] }; error?: { info?: string }; continue?: { gsroffset?: number } };
  if (json.error) throw new Error(json.error.info || 'Wikimedia search failed.');
  // Generator results are commonly serialized by page ID, not relevance.
  return { pages: (json.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)), nextOffset: json.continue?.gsroffset };
}

async function commonsRequest(params: URLSearchParams, signal?: AbortSignal): Promise<CommonsPage[]> {
  return (await commonsPageRequest(params, signal)).pages;
}

/** Search Commons files directly. Scatter later gives both the thumbnail and
 * this normalized catalog metadata to the configured vision model. */
export async function searchCommonsImages(
  query: string,
  signal?: AbortSignal,
): Promise<WikimediaCandidate[]> {
  return (await searchCommonsImagePage(query, signal, { limit: MAX_CANDIDATES_PER_QUERY })).results;
}

export async function searchCommonsImagePage(
  query: string,
  signal?: AbortSignal,
  { limit = 24, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ results: WikimediaCandidate[]; nextOffset?: number }> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: query.trim(),
    gsrlimit: String(Math.max(1, Math.min(50, limit))),
    gsroffset: String(Math.max(0, offset)),
    gsrsort: 'relevance',
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '720',
  });
  const page = await commonsPageRequest(params, signal);
  return { results: page.pages.map(pageToCandidate).filter((candidate): candidate is WikimediaCandidate => candidate != null),
    nextOffset: page.nextOffset };
}

/** Resolve the lead images of relevant Wikipedia articles. Commons-hosted
 * files are then normalized through the same metadata endpoint. */
export async function searchWikipediaLeadImages(
  query: string,
  language: string,
  signal?: AbortSignal,
): Promise<WikimediaCandidate[]> {
  const lang = /^[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(language) ? language.toLowerCase() : 'en';
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrnamespace: '0', gsrsearch: query.trim(), gsrlimit: '5',
    prop: 'pageimages', piprop: 'name', pilicense: 'free',
  });
  const response = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, { signal });
  if (!response.ok) return [];
  const json = await response.json() as { query?: { pages?: Array<{ pageimage?: string; title?: string; index?: number }> } };
  const articles = (json.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const titles = articles
    .map((page) => page.pageimage ? `File:${page.pageimage}` : '')
    .filter(Boolean);
  if (titles.length === 0) return [];
  const commonsParams = new URLSearchParams({
    action: 'query', titles: titles.join('|'), prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata', iiurlwidth: '720',
  });
  const fileKey = (title: string) => title.replace(/_/g, ' ').normalize('NFC');
  const files = new Map((await commonsRequest(commonsParams, signal)).map(page => [fileKey(page.title ?? ''), pageToCandidate(page)]));
  return articles.flatMap(article => {
    const candidate = files.get(fileKey(`File:${article.pageimage}`));
    return candidate ? [{ ...candidate, articleTitle: article.title,
      articleUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(article.title?.replace(/ /g, '_') ?? '')}` }] : [];
  });
}

export async function enrichWikimediaFiles(
  fileTitles: readonly string[],
  signal?: AbortSignal,
): Promise<WikimediaImageRecommendation[]> {
  if (fileTitles.length === 0) return [];
  const pages = await commonsRequest(new URLSearchParams({
    action: 'query',
    titles: [...new Set(fileTitles)].slice(0, 50).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|mime|size|extmetadata',
    iiurlwidth: '1600',
  }), signal);
  const out: WikimediaImageRecommendation[] = [];
  for (const page of pages) {
    const candidate = pageToCandidate(page);
    const info = page.imageinfo?.[0];
    if (!candidate || !info) continue;
    const license = metadata(info, 'LicenseShortName') ?? metadata(info, 'UsageTerms') ?? 'See license on Wikimedia Commons';
    const creator = displayWikimediaCreator({ creator: metadata(info, 'Artist') });
    const credit = chooseWikimediaCredit({
      attribution: metadata(info, 'Attribution'),
      creator,
      credit: metadata(info, 'Credit'),
    });
    out.push({
      source: 'wikimedia',
      sourceId: candidate.fileTitle,
      landingPageUrl: filePageUrl(candidate.fileTitle),
      pageId: candidate.pageId,
      fileTitle: candidate.fileTitle,
      filePageUrl: filePageUrl(candidate.fileTitle),
      thumbnailUrl: candidate.thumbnailUrl,
      originalUrl: candidate.originalUrl,
      caption: metadata(info, 'ObjectName') ?? candidate.caption ?? cleanFileName(candidate.fileTitle),
      description: metadata(info, 'ImageDescription'),
      creator,
      creatorUrl: creator ? metadataLink(info, 'Artist') : undefined,
      license,
      licenseUrl: info.extmetadata?.LicenseUrl?.value,
      creditLine: credit,
      mime: candidate.mime,
      width: candidate.width,
      height: candidate.height,
    });
  }
  return out;
}
