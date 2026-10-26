import type { FreeImageRecommendation } from '@/store/types';
import { catalogResponseError } from './imageCatalogErrors';

const OPENVERSE_IMAGES_API = 'https://api.openverse.org/v1/images/';
const MAX_QUERY_LENGTH = 200;
export const OPENVERSE_CANDIDATES_PER_QUERY = 14;

interface OpenverseTag { name?: string }
interface OpenverseImage {
  id?: string;
  title?: string | null;
  description?: string | null;
  foreign_landing_url?: string | null;
  url?: string | null;
  creator?: string | null;
  creator_url?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  provider?: string | null;
  source?: string | null;
  category?: string | null;
  filetype?: string | null;
  tags?: OpenverseTag[] | null;
  attribution?: string | null;
  fields_matched?: string[] | null;
  mature?: boolean;
  height?: number | null;
  width?: number | null;
  thumbnail?: string | null;
}

interface OpenverseResponse { results?: OpenverseImage[]; page_count?: number; next?: string | null }

export interface OpenverseSearchOptions {
  /** A simple topic query used when an agent-authored compound query becomes
   * so restrictive that it cannot fill the visual-review shortlist. */
  fallbackQuery?: string;
  minimumCandidates?: number;
}

function clean(value: string | null | undefined): string | undefined {
  return value?.replace(/\s+/g, ' ').trim() || undefined;
}

function normalize(item: OpenverseImage): FreeImageRecommendation | null {
  const sourceId = clean(item.id);
  const thumbnailUrl = clean(item.thumbnail);
  const originalUrl = clean(item.url);
  const landingPageUrl = clean(item.foreign_landing_url);
  if (!sourceId || !thumbnailUrl || !originalUrl || !landingPageUrl || item.mature) return null;
  const caption = clean(item.title) ?? 'Untitled image';
  const licenseName = [clean(item.license)?.toUpperCase(), clean(item.license_version)]
    .filter(Boolean).join(' ');
  return {
    source: 'openverse',
    sourceId,
    landingPageUrl,
    thumbnailUrl,
    originalUrl,
    caption,
    description: clean(item.description),
    creator: clean(item.creator),
    creatorUrl: clean(item.creator_url),
    license: licenseName || 'See license on Openverse',
    licenseUrl: clean(item.license_url),
    creditLine: clean(item.attribution) ?? 'See Openverse for attribution',
    mime: clean(item.filetype) ? `image/${clean(item.filetype)}` : undefined,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
    provider: clean(item.provider) ?? clean(item.source),
    tags: (item.tags ?? []).map((tag) => clean(tag.name)).filter((tag): tag is string => !!tag).slice(0, 20),
    fieldsMatched: (item.fields_matched ?? []).filter((field): field is string => typeof field === 'string'),
  };
}

/** Anonymous Openverse search. Wikimedia-origin records are excluded because
 * Scatter queries Commons directly in the paired request. The normalized
 * metadata accompanies the thumbnail during the later vision review. */
async function requestOpenverseImages(
  query: string,
  signal?: AbortSignal,
): Promise<FreeImageRecommendation[]> {
  return (await searchOpenverseImagePage(query, signal, { pageSize: OPENVERSE_CANDIDATES_PER_QUERY })).results;
}

/** Direct catalog query: preserve the user's text and the service's ranking. */
export async function searchOpenverseImagePage(
  query: string,
  signal?: AbortSignal,
  { page = 1, pageSize = 20 }: { page?: number; pageSize?: number } = {},
): Promise<{ results: FreeImageRecommendation[]; nextPage?: number }> {
  const params = new URLSearchParams({
    q: query.trim().slice(0, MAX_QUERY_LENGTH),
    // Scatter uses the anonymous API; larger pages require authentication.
    page_size: String(Math.max(1, Math.min(20, pageSize))),
    page: String(Math.max(1, page)),
    mature: 'false',
    filter_dead: 'true',
    excluded_source: 'wikimedia',
  });
  const response = await fetch(`${OPENVERSE_IMAGES_API}?${params}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw await catalogResponseError('openverse', response);
  const json = await response.json() as OpenverseResponse;
  return { results: (json.results ?? []).map(normalize).filter((item): item is FreeImageRecommendation => item != null),
    nextPage: (json.page_count != null ? page < json.page_count : !!json.next) ? page + 1 : undefined };
}

/** Search Openverse with the agent-authored query. Exact quoted phrases can
 * legitimately yield no records even when the simple topic has hundreds of
 * useful images, so discovery may provide a conservative fallback query. */
export async function searchOpenverseImages(
  query: string,
  signal?: AbortSignal,
  options: OpenverseSearchOptions = {},
): Promise<FreeImageRecommendation[]> {
  const primary = await requestOpenverseImages(query, signal);
  const minimum = Math.max(0, options.minimumCandidates ?? 0);
  const fallback = options.fallbackQuery?.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
  if (primary.length >= minimum || !fallback
    || fallback.toLocaleLowerCase() === query.replace(/\s+/g, ' ').trim().toLocaleLowerCase()) {
    return primary;
  }

  const relaxed = await requestOpenverseImages(fallback, signal);
  const merged = new Map<string, FreeImageRecommendation>();
  for (const candidate of [...primary, ...relaxed]) {
    const id = candidate.sourceId ?? candidate.originalUrl;
    if (!merged.has(id)) merged.set(id, candidate);
    if (merged.size >= OPENVERSE_CANDIDATES_PER_QUERY) break;
  }
  return [...merged.values()];
}
