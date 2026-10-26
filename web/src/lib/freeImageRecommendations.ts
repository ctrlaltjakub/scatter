import type {
  FreeImageAttribution,
  FreeImageRecommendation,
  FreeImageRecommendationSet,
  FreeImageSource,
  NodeVersion,
} from '@/store/types';
import { displayWikimediaCredit, displayWikimediaCreator } from './wikimediaApi';

export function freeImageSource(result: FreeImageRecommendation): FreeImageSource {
  return result.source ?? 'wikimedia';
}

export function freeImageSourceLabel(result: FreeImageRecommendation): string {
  return freeImageSource(result) === 'openverse' ? 'Openverse' : 'Wikimedia';
}

export function freeImageSourceId(result: FreeImageRecommendation): string {
  return result.sourceId
    ?? result.fileTitle
    ?? (result.pageId != null ? String(result.pageId) : result.originalUrl);
}

export function freeImageLandingPage(result: FreeImageRecommendation): string {
  return result.landingPageUrl ?? result.filePageUrl ?? result.originalUrl;
}

/** Stable display fallbacks. Older Openverse captures can contain the legacy
 * `/v1/thumbs/:id` route or a provider image that later stopped hot-linking.
 * The current Openverse thumbnail endpoint is the preferred repair, followed
 * by the original asset. Wikimedia records simply fall back to their original. */
export function freeImageDisplayCandidates(result: FreeImageRecommendation): string[] {
  const candidates = [result.thumbnailUrl];
  if (freeImageSource(result) === 'openverse') {
    const id = freeImageSourceId(result);
    candidates.push(`https://api.openverse.org/v1/images/${encodeURIComponent(id)}/thumb/`);
    candidates.push(`https://api.openverse.org/v1/images/${encodeURIComponent(id)}/thumb/?full_size=true`);
  }
  candidates.push(result.originalUrl);
  return [...new Set(candidates.map((url) => url.trim()).filter(Boolean))];
}

export function displayFreeImageCreator(result: FreeImageRecommendation): string | undefined {
  return freeImageSource(result) === 'wikimedia'
    ? displayWikimediaCreator(result)
    : result.creator?.replace(/\s+/g, ' ').trim() || undefined;
}

export function displayFreeImageCredit(result: FreeImageRecommendation): string {
  if (freeImageSource(result) === 'wikimedia') return displayWikimediaCredit(result);
  return result.creditLine?.replace(/\s+/g, ' ').trim()
    || [result.caption, result.creator].filter(Boolean).join(' — ')
    || 'See Openverse for attribution';
}

export function getFreeImageRecommendationSet(
  version: NodeVersion | undefined,
): FreeImageRecommendationSet | undefined {
  if (!version) return undefined;
  if (version.imageRecommendations) return version.imageRecommendations;
  if (!version.wikimediaImages) return undefined;
  return {
    ...version.wikimediaImages,
    schemaVersion: 2,
    sourceOutcomes: [{ source: 'wikimedia', status: 'success' }],
    results: version.wikimediaImages.results.map((result) => ({
      ...result,
      source: 'wikimedia',
      sourceId: result.fileTitle ?? String(result.pageId ?? result.originalUrl),
      landingPageUrl: result.filePageUrl ?? result.originalUrl,
    })),
  };
}

export function freeImageAttribution(result: FreeImageRecommendation): FreeImageAttribution {
  const creator = displayFreeImageCreator(result);
  return {
    source: freeImageSource(result),
    sourceId: freeImageSourceId(result),
    landingPageUrl: freeImageLandingPage(result),
    originalUrl: result.originalUrl,
    creator,
    creatorUrl: creator ? result.creatorUrl : undefined,
    license: result.license,
    licenseUrl: result.licenseUrl,
    creditLine: displayFreeImageCredit(result),
  };
}
