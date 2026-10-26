import { configuredPrompt } from '@/lib/configuredPrompt';
import { GenerationOutputLimitError, isOutputLimit, secondaryOutputTokens } from './generationLimits';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import type { ChatMessage } from './promptBuilder';
import { friendlyErrorMessage } from '@/providers/errors';
import { getActiveProvider, getProviderById } from '@/store/providerSelectors';
import { useGraphStore } from '@/store/useGraphStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useWikimediaTaskStore, wikimediaTaskKey } from '@/store/useWikimediaTaskStore';
import type {
  FreeImageRecommendation,
  FreeImageRecommendationSet,
  FreeImageSource,
  FreeImageSourceOutcome,
  NodeVersion,
  ScatterNode,
} from '@/store/types';
import { factCheckBodyFingerprint } from './factCheckCore';
import { enrichWikimediaFiles, searchCommonsImages, searchCommonsImagePage, searchWikipediaLeadImages, type WikimediaCandidate } from './wikimediaApi';
import { searchOpenverseImages, searchOpenverseImagePage } from './openverseApi';
import { ImageCatalogError } from './imageCatalogErrors';
import { freeImageDisplayCandidates, freeImageLandingPage, freeImageSource, freeImageSourceId, getFreeImageRecommendationSet } from './freeImageRecommendations';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { modelSupportsTextOutput, modelSupportsVision } from './modelMeta';
import type { ChatImageInput } from '@/providers/types';
import { visionImageDataUrl } from './visionImageInput';
import { stripChips } from './bulletParse';
import { stripTermMarkers } from './termMarking';
import { versionLanguage } from './languages';
import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

const MAX_ACTIVE_DISCOVERIES = 2;
const MAX_SEARCH_ROUNDS = 3;
const MAX_QUERY_LENGTH = 200;
const CANDIDATES_PER_SOURCE_PER_ROUND = 12;
const MAX_CANDIDATES_PER_SOURCE = MAX_SEARCH_ROUNDS * CANDIDATES_PER_SOURCE_PER_ROUND;
const MAX_MODEL_CANDIDATES = CANDIDATES_PER_SOURCE_PER_ROUND * 2;
const MAX_RESULT_LIMIT = 24;
const MANUAL_PAGE_SIZE = 20;
const DISCOVERY_TIMEOUT_MS = 180_000;
const STATUS_PROCESS = 'wikimedia-images';

class DiscoveryQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const enter = () => {
        signal.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(enter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (this.active < MAX_ACTIVE_DISCOVERIES) enter();
      else this.waiting.push(enter);
    });
    try { return await work(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const queue = new DiscoveryQueue();
const controllers = new Map<string, AbortController>();
const catalogCooldowns = new Map<FreeImageSource, { until: number; reportedRetryAt?: number }>();

export function versionSupportsWikimedia(version: NodeVersion): boolean {
  return version.contentType !== 'media' && version.contentType !== 'chat'
    && (!version.chat || version.contentType === 'answer') && !version.media;
}

/** Automatic enrichment is narrower than the explicit search action. Use
 * each version's format, including the node-type fallback for old projects. */
export function versionSupportsAutomaticFreeImages(node: Pick<ScatterNode, 'type' | 'chat'>, version: NodeVersion): boolean {
  const type = version.contentType ?? node.type;
  return versionSupportsWikimedia(version) && !version.markdownNote && !node.chat
    && type !== 'explain' && type !== 'interactive' && type !== 'media' && type !== 'chat';
}

/** Image discovery is allowed to overlap the term-marking pass. Chips are
 * presentation markup, not source text, so they must not invalidate a search
 * that started from the same prose a moment earlier. Substantive edits still
 * produce a different fingerprint and are rejected at commit time. */
export function imageDiscoveryBodyFingerprint(version: NodeVersion): string {
  const internalKeys = new Set(version.internalSources?.map(source => source.n));
  const literals: string[] = [];
  const visit = (node: ChatMdNode) => {
    if (['code', 'inlineCode', 'math', 'inlineMath', 'html', 'link', 'image', 'definition'].includes(node.type)) {
      literals.push(version.body.slice(node.position?.start.offset, node.position?.end.offset));
    } else node.children?.forEach(visit);
  };
  visit(parseChatMarkdown(version.body));
  const body = stripTermMarkers(version.body).replace(/⟦\d+⟧/g, '')
    .replace(/\((\d+)\)/g, (marker, n: string) => internalKeys.has(Number(n)) ? '' : marker)
    .replace(/\s+/g, ' ').replace(/\s+([.!?。！？])/gu, '$1').replace(/([.!?。！？])\s+/gu, '$1').trim();
  // Titles and citation numbering can finish after the prose, in parallel
  // with discovery. Neither changes which images illustrate that prose.
  return factCheckBodyFingerprint({ ...version, header: versionLanguage(version), chat: undefined, body: body + '\0' + literals.join('\0') });
}
export const versionSupportsFreeImages = versionSupportsWikimedia;

function configuredSecondaryModel() {
  const settings = useSettingsStore.getState();
  const dedicated = !settings.secondaryUseSameModel ? settings.secondaryModelRef : undefined;
  const provider = dedicated ? getProviderById(settings, dedicated.providerId) : getActiveProvider(settings);
  const model = dedicated?.model ?? settings.activeModelRef?.model;
  if (!provider?.apiKey || !model) return null;
  const info = useModelCatalogStore.getState().getModel(provider.id, model);
  const bypass = settings.modelCompatibilityOverrides?.[dedicated ? 'secondary' : 'main'];
  if (!bypass && (!modelSupportsTextOutput(provider.preset, model, info)
    || !modelSupportsVision(provider.preset, model, info))) return null;
  return { provider, model };
}

async function modelJson(
  system: string,
  user: string,
  signal: AbortSignal,
  imageInputs?: ChatImageInput[],
  outputTokens = 900,
): Promise<Record<string, unknown>> {
  const config = configuredSecondaryModel();
  if (!config) throw new Error('Choose a vision-capable secondary tasks model first.');
  const adapter = getAdapter(config.provider.preset);
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let raw = '';
  for await (const chunk of adapter.streamChat(config.provider.apiKey, {
    model: config.model,
    modelInfo: useModelCatalogStore.getState().getModel(config.provider.id, config.model),
    messages,
    maxOutputTokens: secondaryOutputTokens(useSettingsStore.getState(), outputTokens),
    signal,
    webSearch: false,
    reasoningEffort: 'low',
    imageInputs,
  }, resolveBaseUrl(config.provider.preset, config.provider.baseUrl))) {
    raw += chunk.delta;
    if (isOutputLimit(chunk.finishReason)) throw new GenerationOutputLimitError('secondary');
    if (chunk.done) break;
  }
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last < first) throw new Error('The secondary model returned no usable image-search instruction.');
  return JSON.parse(text.slice(first, last + 1)) as Record<string, unknown>;
}

function cleanNodeContext(version: NodeVersion): string {
  return version.body.replace(/\[\[|\]\]/g, '').replace(/⟦\d+⟧/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function oneSentence(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const bounded = normalized.length > 240
    ? `${normalized.slice(0, 237).replace(/[\s,;:–—-]+$/g, '')}...`
    : normalized;
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`;
}

function compactQuery(value: unknown, fallback: string): string {
  const query = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (query || fallback).slice(0, MAX_QUERY_LENGTH).trim();
}

interface ModelSelection { candidateId: string; relevance: string }

function outputSelections(value: unknown): ModelSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: ModelSelection[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const candidateId = typeof record.candidateId === 'string' ? record.candidateId.trim() : '';
    const relevance = typeof record.relevance === 'string' ? oneSentence(record.relevance) : '';
    if (candidateId && relevance) selections.push({ candidateId, relevance });
  }
  return selections;
}

function candidateId(candidate: FreeImageRecommendation): string {
  return `${freeImageSource(candidate)}:${freeImageSourceId(candidate)}`;
}

function wikimediaCandidate(candidate: WikimediaCandidate): FreeImageRecommendation {
  const landingPageUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(candidate.fileTitle.replace(/ /g, '_'))}`;
  return {
    source: 'wikimedia', sourceId: candidate.fileTitle,
    pageId: candidate.pageId, fileTitle: candidate.fileTitle, filePageUrl: landingPageUrl,
    landingPageUrl, thumbnailUrl: candidate.thumbnailUrl, originalUrl: candidate.originalUrl,
    caption: candidate.caption ?? candidate.fileTitle.replace(/^File:/i, ''),
    description: candidate.description, creator: candidate.creator,
    license: candidate.license ?? 'See license on Wikimedia Commons',
    creditLine: candidate.creditLine ?? candidate.creator ?? 'Wikimedia Commons', mime: candidate.mime,
    licenseUrl: candidate.licenseUrl, creatorUrl: candidate.creatorUrl,
    width: candidate.width, height: candidate.height,
    articleTitle: candidate.articleTitle, articleUrl: candidate.articleUrl,
  };
}

interface CatalogAttempt {
  outcome: FreeImageSourceOutcome;
  candidates: FreeImageRecommendation[];
}

function discoveryDiagnostic(stage: string, data: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test') return;
  console.debug(`[scatter:image-discovery] ${stage}`, data);
}

async function attemptCatalog(
  source: FreeImageSource,
  search: () => Promise<FreeImageRecommendation[]>,
): Promise<CatalogAttempt> {
  const cooldown = catalogCooldowns.get(source);
  if (cooldown != null && cooldown.until > Date.now()) {
    return { outcome: { source, status: 'rate-limited', retryAt: cooldown.reportedRetryAt }, candidates: [] };
  }
  if (cooldown != null) catalogCooldowns.delete(source);
  try {
    return { outcome: { source, status: 'success' }, candidates: await search() };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    if (error instanceof ImageCatalogError) {
      if (error.kind === 'rate-limited') {
        catalogCooldowns.set(source, {
          until: error.retryAt ?? Date.now() + 60_000,
          reportedRetryAt: error.retryAt,
        });
      }
      return {
        outcome: { source, status: error.kind, retryAt: error.retryAt, message: error.message },
        candidates: [],
      };
    }
    return {
      outcome: {
        source, status: 'unavailable',
        message: `${source === 'openverse' ? 'Openverse' : 'Wikimedia'} is temporarily unavailable.`,
      },
      candidates: [],
    };
  }
}

function addCandidates(
  pool: Map<string, FreeImageRecommendation>,
  sourceCounts: Map<FreeImageSource, number>,
  candidates: FreeImageRecommendation[],
): void {
  const canonicalUrls = new Set([...pool.values()].flatMap((item) =>
    [item.originalUrl, freeImageLandingPage(item)].map((url) => url.toLowerCase())));
  let added = 0;
  for (const candidate of candidates) {
    if (added >= CANDIDATES_PER_SOURCE_PER_ROUND) break;
    const source = freeImageSource(candidate);
    if ((sourceCounts.get(source) ?? 0) >= MAX_CANDIDATES_PER_SOURCE) continue;
    const id = candidateId(candidate);
    const urls = [candidate.originalUrl, freeImageLandingPage(candidate)].map((url) => url.toLowerCase());
    if (pool.has(id) || urls.some((url) => canonicalUrls.has(url))) continue;
    pool.set(id, candidate);
    urls.forEach((url) => canonicalUrls.add(url));
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    added += 1;
  }
}

function modelCandidatePool(pool: Map<string, FreeImageRecommendation>): FreeImageRecommendation[] {
  // Keep each catalog's ranking; interleave so one catalog cannot displace the other.
  const commons = [...pool.values()].filter(item => freeImageSource(item) === 'wikimedia');
  const openverse = [...pool.values()].filter(item => freeImageSource(item) === 'openverse');
  return Array.from({ length: Math.max(commons.length, openverse.length) }, (_, index) =>
    [commons[index], openverse[index]].filter((item): item is FreeImageRecommendation => !!item))
    .flat().slice(0, MAX_MODEL_CANDIDATES);
}

interface VisualCandidateSet {
  inputs: ChatImageInput[];
  byOpaqueId: Map<string, FreeImageRecommendation>;
}

function compactMetadataValue(value: string | undefined, maxLength: number): string | undefined {
  const clean = value?.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).replace(/[\s,;:–—-]+$/g, '')}...`;
}

/** Keep the vision prompt informative but bounded. Catalog fields are sent as
 * JSON so the model can clearly distinguish untrusted metadata from
 * instructions and match each record to its attached image ID. */
export function visualCandidateMetadata(
  candidates: ReadonlyMap<string, FreeImageRecommendation>,
): Array<Record<string, string | string[]>> {
  return [...candidates].map(([id, candidate]) => {
    const dimensions = candidate.width && candidate.height
      ? `${candidate.width} x ${candidate.height}`
      : undefined;
    const record: Record<string, string | string[]> = {
      candidateId: id,
      catalog: freeImageSource(candidate) === 'openverse' ? 'Openverse' : 'Wikimedia Commons',
      title: compactMetadataValue(candidate.caption, 240) ?? 'Untitled image',
    };
    const optional: Array<[string, string | undefined]> = [
      ['filename', compactMetadataValue(candidate.fileTitle, 240)],
      ['catalogDescription', compactMetadataValue(candidate.description, 600)],
      ['creator', compactMetadataValue(candidate.creator, 240)],
      ['provider', compactMetadataValue(candidate.provider, 120)],
      ['format', compactMetadataValue(candidate.mime, 80)],
      ['dimensions', dimensions],
      ['license', compactMetadataValue(candidate.license, 160)],
      ['wikipediaArticle', compactMetadataValue(candidate.articleTitle, 240)],
    ];
    for (const [key, value] of optional) if (value) record[key] = value;
    const tags = candidate.tags?.map((tag) => compactMetadataValue(tag, 80))
      .filter((tag): tag is string => !!tag).slice(0, 20);
    if (tags?.length) record.tags = tags;
    return record;
  });
}

async function visualCandidateSet(
  pool: Map<string, FreeImageRecommendation>,
  signal: AbortSignal,
  dataUrlCache: Map<string, string | null>,
): Promise<VisualCandidateSet> {
  const candidates = modelCandidatePool(pool);
  const byOpaqueId = new Map<string, FreeImageRecommendation>();
  const prepared = await Promise.all(candidates.map(async (candidate) => {
    const key = candidateId(candidate);
    let url = dataUrlCache.get(key);
    if (url === undefined) {
      url = null;
      // A dead thumbnail must not consume the entire discovery deadline.
      for (const thumbnail of freeImageDisplayCandidates(candidate).slice(0, 2)) {
        signal.throwIfAborted();
        try {
          url = await visionImageDataUrl(thumbnail, AbortSignal.any([signal, AbortSignal.timeout(8_000)]));
          break;
        } catch {
          signal.throwIfAborted();
        }
      }
      dataUrlCache.set(key, url);
    }
    return url ? { candidate, url } : null;
  }));
  const inputs: ChatImageInput[] = [];
  for (const item of prepared) {
    if (!item) continue;
    const id = `image-${inputs.length + 1}`;
    byOpaqueId.set(id, item.candidate);
    inputs.push({ id, url: item.url, detail: 'low' });
  }
  return { inputs, byOpaqueId };
}

interface DiscoveryResult {
  results: FreeImageRecommendation[];
  sourceOutcomes: FreeImageSourceOutcome[];
  committable: boolean;
  next?: FreeImageRecommendationSet['next'];
}

/** No model, query rewriting, fallback keywords, or AI result filtering. */
async function directSearch(query: string, signal: AbortSignal, previous?: FreeImageRecommendationSet): Promise<DiscoveryResult> {
  const next: NonNullable<FreeImageRecommendationSet['next']> = {};
  const attempts = await Promise.all((['wikimedia', 'openverse'] as const).map(async source => {
    const cursor = previous ? previous.next?.[source] : source === 'wikimedia' ? 0 : 1;
    if (cursor == null) return null;
    const attempt = await attemptCatalog(source, async () => {
      if (source === 'wikimedia') {
        const page = await searchCommonsImagePage(query, signal, { limit: MANUAL_PAGE_SIZE, offset: cursor });
        if (page.nextOffset != null) next.wikimedia = page.nextOffset;
        return page.results.map(wikimediaCandidate);
      }
      const page = await searchOpenverseImagePage(query, signal, { pageSize: MANUAL_PAGE_SIZE, page: cursor });
      if (page.nextPage != null) next.openverse = page.nextPage;
      return page.results;
    });
    // Keep a failed source's continuation available for an explicit retry.
    if (attempt.outcome.status !== 'success') next[source] = cursor;
    return attempt;
  }));
  const completed = attempts.filter((attempt): attempt is CatalogAttempt => !!attempt);
  const results = new Map<string, FreeImageRecommendation>();
  const urls = new Set<string>();
  const append = (candidate: FreeImageRecommendation) => {
    const id = candidateId(candidate);
    if (results.has(id) || urls.has(candidate.originalUrl)) return;
    results.set(id, candidate); urls.add(candidate.originalUrl);
  };
  previous?.results.forEach(append);
  // Fair interleaving retains relevance order inside each catalog.
  const length = Math.max(0, ...completed.map(attempt => attempt.candidates.length));
  for (let index = 0; index < length; index++) for (const attempt of completed) {
    const candidate = attempt.candidates[index]; if (candidate) append(candidate);
  }
  const outcomes = new Map(previous?.sourceOutcomes.map(outcome => [outcome.source, outcome]));
  completed.forEach(attempt => outcomes.set(attempt.outcome.source, attempt.outcome));
  return { results: [...results.values()], sourceOutcomes: [...outcomes.values()], next,
    committable: completed.some(attempt => attempt.outcome.status === 'success') };
}

async function discover(
  version: NodeVersion,
  resultLimit: number,
  signal: AbortSignal,
): Promise<DiscoveryResult> {
  const context = `HEADER:\n${version.header}\n\nCOMPLETE NODE:\n${cleanNodeContext(version)}`;
  const pool = new Map<string, FreeImageRecommendation>();
  const sourceCounts = new Map<FreeImageSource, number>();
  const outcomeMap = new Map<FreeImageSource, FreeImageSourceOutcome>();
  const successfulSources = new Set<FreeImageSource>();
  const usedPairs = new Set<string>();
  const visionDataUrls = new Map<string, string | null>();
  const reviewed = new Set<string>();
  const selected = new Map<string, { candidate: FreeImageRecommendation; relevance: string }>();
  let lastVisual: VisualCandidateSet = { inputs: [], byOpaqueId: new Map() };
  let instruction = await modelJson(
      configuredPrompt('imageDiscovery'),
      `${context}\n\nNo searches have run yet. RESULT LIMIT: ${resultLimit}`,
      signal,
    );
  const primarySubject = compactQuery(instruction.wikipediaQuery ?? instruction.query, version.header);

  for (let round = 0; round < MAX_SEARCH_ROUNDS; round++) {
    const wikimediaQuery = round === 0 && instruction.wikipediaQuery ? primarySubject
      : compactQuery(instruction.wikimediaQuery ?? instruction.query, version.header);
    const openverseQuery = round === 0 && instruction.wikipediaQuery ? primarySubject
      : compactQuery(instruction.openverseQuery ?? instruction.query, version.header);
    const wikipediaQuery = compactQuery(instruction.wikipediaQuery, openverseQuery);
    const pairKey = `${wikimediaQuery.toLocaleLowerCase()}\n${openverseQuery.toLocaleLowerCase()}\n${wikipediaQuery.toLocaleLowerCase()}`;
    // Repeating a query is not a reason to append unrelated generic keywords.
    if (usedPairs.has(pairKey)) break;
    usedPairs.add(pairKey);

    const [wikimedia, openverse] = await Promise.all([
      attemptCatalog('wikimedia', async () => {
        const [commons, lead] = await Promise.all([
          searchCommonsImages(wikimediaQuery, signal),
          searchWikipediaLeadImages(wikipediaQuery, version.language ?? 'en', signal).catch(error => {
            signal.throwIfAborted(); discoveryDiagnostic('Wikipedia lead lookup unavailable', { message: String(error) }); return [];
          }),
        ]);
        return [...lead, ...commons].map(wikimediaCandidate);
      }),
      attemptCatalog('openverse', () => searchOpenverseImages(openverseQuery, signal, {
        // Preserve exact subject identity rather than relaxing to abstract prose.
        fallbackQuery: wikipediaQuery,
        minimumCandidates: 3,
      })),
    ]);
    for (const attempt of [wikimedia, openverse]) {
      outcomeMap.set(attempt.outcome.source, attempt.outcome);
      if (attempt.outcome.status === 'success') successfulSources.add(attempt.outcome.source);
      addCandidates(pool, sourceCounts, attempt.candidates);
    }

    discoveryDiagnostic('catalog round', {
      round: round + 1,
      returned: { wikimedia: wikimedia.candidates.length, openverse: openverse.candidates.length },
      admitted: {
        wikimedia: sourceCounts.get('wikimedia') ?? 0,
        openverse: sourceCounts.get('openverse') ?? 0,
      },
      outcomes: [...outcomeMap.values()].map(({ source, status }) => ({ source, status })),
    });

    if (!successfulSources.size) break;
    const fresh = new Map([...pool].filter(([id]) => !reviewed.has(id)));
    if (!fresh.size) {
      if (round === MAX_SEARCH_ROUNDS - 1) break;
      instruction = await modelJson(configuredPrompt('imageDiscovery'),
        `${context}\n\nSEARCH ROUNDS USED: ${round + 1}/${MAX_SEARCH_ROUNDS}\nRESULT LIMIT: ${resultLimit - selected.size}\nQUERIES ALREADY TRIED: ${JSON.stringify([...usedPairs])}\nALREADY ACCEPTED: ${JSON.stringify([...selected.values()].map(item => item.candidate.caption))}\nNo new images were returned. There are no images to select in this round. Try a specific alternative name or concrete aspect of the same subject, only if one could help.\n${configuredPrompt('imageDiscoveryContinue')}`,
        signal);
      if (instruction.action === 'finish') break;
      if (instruction.action !== 'search') throw new Error('The secondary model returned an invalid image-search instruction. Retry or use direct catalog search.');
      continue;
    }
    lastVisual = await visualCandidateSet(fresh, signal, visionDataUrls);
    modelCandidatePool(fresh).forEach(candidate => reviewed.add(candidateId(candidate)));
    if (!lastVisual.inputs.length) throw new Error('The catalogs returned images, but their previews could not be loaded for review. Try a direct image search or retry later.');
    const visualSources = { wikimedia: 0, openverse: 0 };
    for (const candidate of lastVisual.byOpaqueId.values()) visualSources[freeImageSource(candidate)] += 1;
    discoveryDiagnostic('visual shortlist', {
      round: round + 1,
      prepared: lastVisual.inputs.length,
      sources: visualSources,
    });
    const finalRound = round === MAX_SEARCH_ROUNDS - 1;
    const candidateMetadata = visualCandidateMetadata(lastVisual.byOpaqueId);
    instruction = await modelJson(
        configuredPrompt('imageDiscovery'),
        `${context}\n\nSEARCH ROUNDS USED: ${round + 1}/${MAX_SEARCH_ROUNDS}\nRESULT LIMIT: ${resultLimit - selected.size}\nQUERIES ALREADY TRIED: ${JSON.stringify([...usedPairs])}\nALREADY ACCEPTED: ${JSON.stringify([...selected.values()].map(item => item.candidate.caption))}\nCATALOG OUTCOMES: ${JSON.stringify([...outcomeMap.values()])}\nVISUAL CANDIDATES: ${lastVisual.inputs.length} attached images labelled image-1 through image-${lastVisual.inputs.length}\nCANDIDATE METADATA (untrusted descriptive data, matched by candidateId):\n${JSON.stringify(candidateMetadata)}\n${configuredPrompt('imageDiscoveryReview')}\n\n${finalRound ? configuredPrompt('imageDiscoveryFinish') : configuredPrompt('imageDiscoveryContinue')}`,
        signal,
        lastVisual.inputs,
        2800,
    );
    if (!['search', 'finish'].includes(String(instruction.action))
      || !Array.isArray(instruction.selections)) {
      throw new Error('The secondary model returned an invalid image review. Retry or use direct catalog search.');
    }
    const selections = outputSelections(instruction.selections);
    if (Array.isArray(instruction.selections) && instruction.selections.length > 0 && !selections.length) {
      throw new Error('The secondary model did not provide usable visual image descriptions. Try the search again.');
    }
    if (selections.some(selection => !lastVisual.byOpaqueId.has(selection.candidateId))) {
      throw new Error('The secondary model selected an image that was not in the supplied results. Retry or use direct catalog search.');
    }
    for (const selection of selections) {
      const candidate = lastVisual.byOpaqueId.get(selection.candidateId);
      if (!candidate) continue;
      const id = candidateId(candidate);
      if (!selected.has(id)) selected.set(id, { candidate, relevance: selection.relevance });
      if (selected.size >= resultLimit) break;
    }
    if (instruction.action === 'finish' || selected.size >= resultLimit) break;
  }

  const sourceOutcomes: FreeImageSourceOutcome[] = (['wikimedia', 'openverse'] as const).map((source) =>
    outcomeMap.get(source) ?? { source, status: 'unavailable', message: 'The catalog was not reached.' });
  if (!successfulSources.size) return { results: [], sourceOutcomes, committable: false };

  const selectedCandidates = [...selected.values()].map((entry) => entry.candidate);
  const wikimediaTitles = selectedCandidates
    .filter((item) => freeImageSource(item) === 'wikimedia')
    .map((item) => item.fileTitle).filter((title): title is string => !!title);
  const enrichedWikimedia = await enrichWikimediaFiles(wikimediaTitles, signal);
  const enrichedById = new Map(enrichedWikimedia.map((item) => [candidateId(item), item]));
  const normalizeSubject = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[_"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
  const subject = normalizeSubject(primarySubject);
  const identityRank = (candidate: FreeImageRecommendation) => subject ?
    (normalizeSubject(candidate.caption).includes(subject) ? 10 : 0)
      + (normalizeSubject(candidate.fileTitle ?? '').includes(subject) ? 6 : 0)
      + (normalizeSubject(candidate.articleTitle ?? '').includes(subject) ? 4 : 0) : 0;
  const results = [...selected.values()].map(({ candidate, relevance }) => ({
    ...candidate,
    ...(enrichedById.get(candidateId(candidate)) ?? candidate),
    relevance,
  })).sort((a, b) => identityRank(b) - identityRank(a));
  discoveryDiagnostic('selection complete', {
    selected: results.length,
    sources: {
      wikimedia: results.filter((item) => freeImageSource(item) === 'wikimedia').length,
      openverse: results.filter((item) => freeImageSource(item) === 'openverse').length,
    },
  });
  return { results, sourceOutcomes, committable: true };
}

function targetVersion(nodeId: string, createdAt: number, fingerprint: string) {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node) return null;
  const index = node.versions.findIndex((version) =>
    version.createdAt === createdAt && imageDiscoveryBodyFingerprint(version) === fingerprint);
  return index >= 0 ? { node, index, version: node.versions[index]! } : null;
}

function commitResults(
  nodeId: string,
  createdAt: number,
  fingerprint: string,
  result: FreeImageRecommendationSet,
): boolean {
  const target = targetVersion(nodeId, createdAt, fingerprint);
  if (!target) return false;
  const versions = [...target.node.versions];
  versions[target.index] = { ...target.version, imageRecommendations: result };
  useGraphStore.temporal.getState().pause();
  try { useGraphStore.getState().updateNode(nodeId, { versions }); }
  finally { useGraphStore.temporal.getState().resume(); }
  return true;
}

export interface WikimediaDiscoveryOptions {
  /** Automatic enrichment obeys the preference; explicit searches do not. */
  automatic?: boolean;
  manualQuery?: string;
  loadMore?: boolean;
  rerun?: boolean;
  /** Generation owns this escape hatch and calls it only after the complete
   * prose is available, while the independent chip pass is still running. */
  allowDuringGeneration?: boolean;
}

export async function startWikimediaDiscovery(
  nodeId: string,
  versionCreatedAt: number,
  options: WikimediaDiscoveryOptions = {},
): Promise<void> {
  if (options.automatic && !useSettingsStore.getState().autoFreeImages) return;
  const currentProject = useGraphStore.getState().project;
  const projectId = currentProject?.id;
  const node = currentProject?.nodes[nodeId];
  const versionIndex = node?.versions.findIndex((candidate) => candidate.createdAt === versionCreatedAt) ?? -1;
  const version = versionIndex >= 0 ? node?.versions[versionIndex] : undefined;
  if (!projectId || !node || !version || !versionSupportsWikimedia(version)) return;
  if (options.automatic && !versionSupportsAutomaticFreeImages(node, version)) return;
  const generatingThisVersion = !!node.generating
    && (node.generatingVersionIndex ?? node.currentVersionIndex) === versionIndex;
  const manualQuery = options.manualQuery?.trim().slice(0, MAX_QUERY_LENGTH) || undefined;
  if ((generatingThisVersion && !options.allowDuringGeneration) || (!version.body.trim() && !manualQuery)) return;
  const key = wikimediaTaskKey(nodeId, versionCreatedAt);
  if (controllers.has(key)) return;
  const searchVersion = { ...version, body: stripTermMarkers(version.body) };
  const fingerprint = imageDiscoveryBodyFingerprint(version);
  const previous = getFreeImageRecommendationSet(version);
  const resultLimit = manualQuery ? MANUAL_PAGE_SIZE * 2 : MAX_RESULT_LIMIT;
  const continuation = options.loadMore && previous?.mode === 'manual' && previous.manualQuery === manualQuery ? previous : undefined;
  if (options.loadMore && (!continuation || !Object.keys(continuation.next ?? {}).length)) return;
  const config = configuredSecondaryModel();
  if (!config && !manualQuery) {
    useWikimediaTaskStore.getState().setTask(key, {
      running: false, error: 'Choose a vision-capable secondary tasks model first.', startedAt: Date.now(),
    });
    return;
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, DISCOVERY_TIMEOUT_MS);
  controllers.set(key, controller);
  const unsubscribe = useGraphStore.subscribe((state) => {
    const current = state.project;
    const currentNode = current?.nodes[nodeId];
    const currentVersion = currentNode?.versions.find((candidate) => candidate.createdAt === versionCreatedAt);
    if (current?.id !== projectId
      || !currentNode || !currentVersion
      || (options.automatic && !versionSupportsAutomaticFreeImages(currentNode, currentVersion))) {
      controller.abort();
    }
  });
  const unsubscribeSettings = useSettingsStore.subscribe(state => {
    if (options.automatic && !state.autoFreeImages) controller.abort();
  });
  useWikimediaTaskStore.getState().setTask(key, { running: true, loadingMore: !!continuation, startedAt: Date.now() });
  useNodeStatusStore.getState().setProcessStatus(nodeId, STATUS_PROCESS, 'FINDING IMAGES');
  try {
    const discovered = manualQuery ? await directSearch(manualQuery, controller.signal, continuation)
      : await queue.run(controller.signal, () => discover(searchVersion, resultLimit, controller.signal));
    if (controller.signal.aborted) return;
    if (!discovered.committable) {
      useWikimediaTaskStore.getState().patchTask(key, {
        running: false, sourceOutcomes: discovered.sourceOutcomes, error: undefined,
      });
      return;
    }
    const committed = commitResults(nodeId, versionCreatedAt, fingerprint, {
      schemaVersion: 2,
      bodyFingerprint: fingerprint,
      providerId: manualQuery ? undefined : config?.provider.id,
      model: manualQuery ? undefined : config?.model,
      mode: manualQuery ? 'manual' : 'automatic',
      searchedAt: Date.now(),
      resultLimit,
      manualQuery,
      next: discovered.next,
      sourceOutcomes: discovered.sourceOutcomes,
      results: discovered.results,
    });
    if (committed) {
      useWikimediaTaskStore.getState().patchTask(key, {
        running: false, results: discovered.results,
        sourceOutcomes: discovered.sourceOutcomes, error: undefined,
      });
    } else {
      useWikimediaTaskStore.getState().patchTask(key, {
        running: false,
        error: 'The node changed before image discovery finished. Search again to use its current text.',
        sourceOutcomes: discovered.sourceOutcomes,
      });
    }
  } catch (error) {
    if (controllers.get(key) !== controller) return;
    if (timedOut) {
      useWikimediaTaskStore.getState().patchTask(key, {
        running: false, error: 'Image discovery took too long. Try again or use a more specific search.',
      });
    } else if ((error as Error)?.name !== 'AbortError') {
      useWikimediaTaskStore.getState().patchTask(key, { running: false, error: friendlyErrorMessage(error) });
    }
  } finally {
    window.clearTimeout(timeout);
    unsubscribe();
    unsubscribeSettings();
    // A stopped request may finish unwinding after a new direct query starts.
    if (controllers.get(key) === controller) {
      controllers.delete(key);
      useWikimediaTaskStore.getState().patchTask(key, { running: false });
      useNodeStatusStore.getState().clearProcessStatus(nodeId, STATUS_PROCESS);
    }
  }
}

export const startFreeImageDiscovery = startWikimediaDiscovery;

export function stopWikimediaDiscovery(nodeId: string, versionCreatedAt: number): void {
  const key = wikimediaTaskKey(nodeId, versionCreatedAt);
  controllers.get(key)?.abort();
  controllers.delete(key);
  useWikimediaTaskStore.getState().patchTask(key, { running: false });
  useNodeStatusStore.getState().clearProcessStatus(nodeId, STATUS_PROCESS);
}

export function wikimediaSearchAvailability(): { available: boolean; reason?: string } {
  return configuredSecondaryModel()
    ? { available: true }
    : { available: false, reason: 'Choose a vision-capable secondary tasks model first.' };
}
export const freeImageSearchAvailability = wikimediaSearchAvailability;
