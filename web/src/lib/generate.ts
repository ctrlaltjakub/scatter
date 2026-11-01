import { normalizeLanguage, versionLanguage } from './languages';
import { generationLanguagePrompt } from './generationLanguage';
import { configuredPrompt } from '@/lib/configuredPrompt';
import { mergeGoogleSearchSuggestions } from './googleSearchSuggestions';
import { explicitFollowUpIntent } from './followUpIntent';
import { secondaryOutputTokens, mainOutputTokens } from './generationLimits';
import { checkFinishReason } from './generationValidation';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { markChatTerms } from './chat/termMarking';
import { markTerms, stripTermMarkers } from './termMarking';
import { generateTermPreviews } from './termPreviews';
import { generateImageQuestionTitle } from './generateImageQuestionTitle';
import {
  useRewriteStore,
  isPartialActiveOn,
  isWholeActive,
  targetsEqual,
} from '@/store/useRewriteStore';
import {
  endMarker,
  findMarkerBounds,
  insertMarkedSection,
  nextMarkerId,
  removeMarkers,
  replaceBetweenMarkers,
  startMarker,
  stripMarkers,
} from './rewriteMarkers';
import { getAdapter, modelSupportsWebSearch, resolveBaseUrl } from '@/providers/registry';
import { friendlyErrorMessage } from '@/providers/errors';
import type { Citation } from '@/providers/types';
import {
  buildSources, extractInlineCitations, hasIncompleteCitationTail,
  placeCitationMarkersReliable, placeVisibleCitationMarkers, renumberCitations,
  stripUnbackedCitationLabels,
} from '@/lib/citations';
import { getActiveProvider, getProviderById } from '@/store/providerSelectors';
import { renameScatter, isAutoScatterName } from '@/store/projectActions';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { trackGenerationVersions } from './generationVersionTracking';
import {
  beginGenerationSession,
  cancelGenerationSession,
  finishGenerationSession,
  getGenerationSession,
  markGenerationTextReceived,
  registerGenerationController,
} from './generationSession';
import {
  buildFollowUpClassifierPrompt,
  buildMessages,
  type TaskVariant,
  type PromptContext,
  type ChatMessage,
} from './promptBuilder';
import {
  currentContentType, currentMaxL1Bullets, DEFAULT_MAX_L1_BULLETS,
  formatExplainHeader, isExplainContentType, stripExplainHeaderSuffix, type ContentType,
} from './nodeContentType';
import {
  flattenHeaderParts,
  normalizeHeaderParts,
  resolveVersionHeaderParts,
  semanticHeaderText,
} from './nodeHeaderText';
import { newId } from './ids';
import { isValidStructure, separatorColonIndex, stripChips } from './bulletParse';
import { EmbeddedImageText } from './embeddedImageText';
import { unchipHeaders } from './parser';
import { makeBulletCommitGate, type CommitGate } from './streamCommitGate';
import { makeFrameCoalescer } from './frameCoalesce';
import { ROOT_NODE_W } from './nodeSize';
import type { ScatterNode, NodeVersion, NodeKind, Arrow, ReasoningEffort, NodeSource, HeaderParts, FactCheckReport, InternalNodeSource } from '@/store/types';
import type { NodeTextSelection, NodeTextSelectionPart } from '@/store/useNodeTextSelectionStore';
import { createArrowSourceSelection } from './sourceSelection';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import {
  formatSourceEvidenceBlock,
  retrieveProjectSources,
  snapshotSourcePolicy,
  type RetrievedSourcePassage,
} from './sourceRetrieval';
import { normalizeInternalCitationTokens, pruneInternalSources } from './internalCitations';
import { prepareSourceEmbeddingModel, waitForProjectSources } from './sourceProcessing';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { startWikimediaDiscovery } from './wikimediaDiscovery';
import type { ChatAnswerRef } from '@/store/chatTypes';
import type { ImageQuestionContext } from '@/store/types';
import { prepareImageQuestion } from './imageRegionInput';
import { modelSupportsVision } from './modelMeta';

import { spawnNearParent } from './spawnNearParent';
export { spawnNearParent } from './spawnNearParent';

// In-memory map of nodeId → last generation args, used by retryGeneration.
// Module-level state; not persisted.
interface RetryArgs { variant: TaskVariant; parentIdForContext: string | null; }
const retryArgs = new Map<string, RetryArgs>();

export function hasRetryArgs(nodeId: string): boolean {
  return retryArgs.has(nodeId);
}

function contextFor(parentId: string | null, childId?: string): PromptContext {
  if (!parentId) return { parent: null, grandparent: null };
  const proj = useGraphStore.getState().project!;
  const parent = proj.nodes[parentId];
  if (!parent) return { parent: null, grandparent: null };
  const sourceAnswer = childId ? Object.values(proj.arrows).find((arrow) =>
    arrow.toNodeId === childId && arrow.fromNodeId === parentId)?.sourceAnswer : undefined;
  const pv = sourceAnswer ? parent.versions.find((version) => version.createdAt === sourceAnswer.versionCreatedAt)
    : parent.versions[parent.currentVersionIndex];
  if (parent.chat) return {
    parent: pv ? { header: pv.chat?.title ?? pv.header,
      body: `Question: ${pv.chat?.question ?? ''}\n\nAnswer: ${pv.body}` } : null,
    grandparent: null,
  };
  const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === parentId);
  const grandparentId = incoming?.fromNodeId;
  const grand = grandparentId ? proj.nodes[grandparentId] : null;
  const gv = grand?.versions[grand.currentVersionIndex];
  return {
    parent: pv ? { header: pv.header, body: pv.body } : null,
    grandparent: gv ? { header: gv.header, body: gv.body } : null,
  };
}

// ───────────────────────────────────────────────────────────────────
// Low-level streaming
// ───────────────────────────────────────────────────────────────────

/**
 * Sleep (ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives one LLM stream call. For each accumulated chunk, sanitizes
 * the running accumulator and dispatches it through `onAcc`. The
 * caller owns what to DO with that string — write it into the version
 * body (spawn path), into the working body (whole rewrite), or into
 * the marker-delimited slice (partial rewrite).
 *
 * The `signal` parameter lets a concurrent whole rewrite abort an
 * in-flight partial: the streaming adapter's underlying fetch is
 * aborted, the for-await loop exits, control returns to the caller's
 * `finally` block.
 */
/**
 * Set the transient generation flags (`generating` / `generationError`)
 * WITHOUT recording an undo step. These fields are runtime-only (stripped
 * before save in projectIO) and toggling them is never something the user
 * should be able to undo — so the spawn/rewrite stays a single (or zero)
 * history entry instead of being bracketed by generating:true/false steps.
 */
function setGenFlags(nodeId: string, patch: Partial<ScatterNode>): void {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  const normalized = patch.generating === true && patch.generatingVersionIndex == null
    ? {
        ...patch,
        generatingVersionIndex: node?.generatingVersionIndex ?? node?.currentVersionIndex,
      }
    : patch.generating === false
      ? { ...patch, generatingVersionIndex: undefined }
      : patch;
  useGraphStore.temporal.getState().pause();
  try {
    useGraphStore.getState().updateNode(nodeId, normalized);
  } finally {
    useGraphStore.temporal.getState().resume();
  }
}

/** Part F — the short status the ASCII aura field spells out near the node
 *  while THIS kind of pass is streaming. Used as the default label when a
 *  caller doesn't pass a more specific `statusLabel` (e.g. EXPANDING WHOLE). */
function statusVerb(kind: TaskVariant['kind']): string {
  switch (kind) {
    case 'restructure': return 'CHECKING STRUCTURE';
    case 'add-chips': return 'MARKING TERMS';
    case 'modify': return 'MODIFYING';
    case 'elaborate': return 'ELABORATING';
    case 'expand-part': return 'EXPANDING';
    default: return 'GENERATING';
  }
}

/** Set the node's aura-field status, prefixed so it reads "STATUS: <LABEL>".
 *  Cleared by the caller (clearStatus) at the terminal generating:false. */
function setNodeStatus(nodeId: string, label: string, processId?: string): void {
  if (processId) useNodeStatusStore.getState().setProcessStatus(nodeId, processId, label);
  else useNodeStatusStore.getState().setStatus(nodeId, `STATUS: ${label}`);
}

/** Search tools are model-controlled on OpenRouter and Anthropic. Put strong,
 *  provider-neutral grounding guidance in the user request—the location
 *  Gemini 3.1 follows best—without returning to brittle per-model tool forcing. */
function addWebSearchGuidance(messages: ChatMessage[]): ChatMessage[] {
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  if (userIndex < 0) return messages;
  return messages.map((message, index) => index === userIndex
    ? { ...message, content: `${message.content}\n\n${configuredPrompt('nodeWebSearch')}` }
    : message);
}

function appendSourceEvidence(messages: ChatMessage[], evidence: string): ChatMessage[] {
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  if (userIndex < 0) return messages;
  return messages.map((message, index) => index === userIndex
    ? { ...message, content: `${message.content}\n\n${evidence}` }
    : message);
}

function stripKnownInternalMarkers(messages: ChatMessage[], nodeId: string): ChatMessage[] {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  const internal = node?.versions[node.currentVersionIndex]?.internalSources ?? [];
  if (!internal.length) return messages;
  const numbers = new Set(internal.map((source) => source.n));
  return messages.map((message) => ({
    ...message,
    content: message.content.replace(/\((\d+)\)/g, (token, digits: string) => (
      numbers.has(Number(digits)) ? '' : token
    )),
  }));
}

export function strictSourceUnits(body: string): string[] {
  const lines = body.replace(/\r/g, '').split('\n');
  const firstBullet = lines.findIndex((line) => /^-\s+/.test(line));
  // Generation supplies sentence source lines. Do not reinterpret punctuation:
  // abbreviated names, decimal values and CJK text are valid factual units.
  const sentences = lines.slice(0, firstBullet < 0 ? lines.length : firstBullet)
    .filter((line) => !/^\s*#/.test(line)).map(line => line.trim()).filter(Boolean);
  const subBullets = lines.filter((line) => /^\s{2,}-\s+/.test(line)).map((line) => line.trim());
  return [...sentences, ...subBullets];
}

export function hasStrictSourceCoverage(body: string, passages: readonly RetrievedSourcePassage[]): boolean {
  const valid = new Set(passages.map((passage) => passage.evidenceId));
  const units = strictSourceUnits(body);
  return units.length > 0 && units.every((unit) => (
    [...unit.matchAll(/SOURCE_(\d+)/g)].some((match) => valid.has(`SOURCE_${Number(match[1])}`))
  ));
}

/** One bounded citation-only repair for Sources only. The answer and evidence
 * stay fixed; this does not retrieve again or regenerate from scratch. */
async function repairStrictSourceCitations(options: {
  nodeId: string;
  body: string;
  passages: readonly RetrievedSourcePassage[];
  signal: AbortSignal;
  onAcc: (normalized: string) => void;
}): Promise<string> {
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings);
  const model = settings.activeModelRef?.model;
  if (!provider?.apiKey || !model) return options.body;
  setNodeStatus(options.nodeId, 'REPAIRING SOURCE CITATIONS');
  const evidence = formatSourceEvidenceBlock('only', options.passages);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${configuredPrompt('sourceCitationRepair')}\n\n${configuredPrompt('proseLineBoundaries')}`,
    },
    {
      role: 'user',
      content: configuredPrompt('sourceCitationRepairTask', { body: options.body, evidence }),
    },
  ];
  let repaired = '';
  const adapter = getAdapter(provider.preset);
  for await (const chunk of adapter.streamChat(provider.apiKey, {
    model,
    messages,
    maxOutputTokens: settings.outputTokenCap,
    signal: options.signal,
    webSearch: false,
    reasoningEffort: settings.reasoningEffort,
    modelInfo: useModelCatalogStore.getState().getModel(provider.id, model),
  }, resolveBaseUrl(provider.preset, provider.baseUrl))) {
    if (options.signal.aborted) break;
    checkFinishReason(chunk.finishReason, 'main');
    if (chunk.delta) {
      repaired += chunk.delta;
      options.onAcc(normalizeInternalCitationTokens(repaired, options.passages).body);
    }
    if (chunk.done) break;
  }
  return repaired.replace(/^```(?:markdown)?\s*|\s*```$/gi, '').trim();
}

const SOURCE_POLICY_EXCLUDED_KINDS = new Set<TaskVariant['kind']>([
  'add-chips', 'restructure', 'fact-rewrite',
]);

/** Some tool-capable models occasionally print their attempted hosted-search
 *  call as ordinary answer text instead of sending a structured tool request.
 *  That text is not a usable node and must never enter structure repair. */
function looksLikeLeakedWebSearchToolCall(text: string): boolean {
  return /<tool_call>[\s\S]*?openrouter[_:]web[_-]search/i.test(text);
}

function generationCompletionError(
  body: string,
  finishReason: string | null | undefined,
  citations: Citation[],
): string | null {
  try { checkFinishReason(finishReason, 'main'); }
  catch (error) { return (error as Error).message; }
  if (hasIncompleteCitationTail(body, citations)) {
    return 'The search provider ended the answer inside a source link. Retry the generation; the incomplete text was not saved.';
  }
  return null;
}

async function streamChunks(opts: {
  nodeId: string;
  variant: TaskVariant;
  parentIdForContext: string | null;
  signal: AbortSignal;
  onAcc: (sanitizedAcc: string) => void;
  sanitize?: (acc: string) => string;
  maxOutputTokens?: number;
  imageContext?: ImageQuestionContext;
  /** Override the request-time web-search flag (chip pass forces this false). */
  webSearch?: boolean;
  /** Run on a specific (provider, model) instead of the active one (used by the
   *  dedicated chip-marking model). Falls back to the active model if the id no
   *  longer resolves. */
  modelOverride?: { providerId: string; model: string };
  /** Reasoning-effort hint. Omitted by the main pass (falls back to the user's
   *  settings dial); the chip pass forces 'low'. */
  reasoningEffort?: ReasoningEffort;
  /** Part F — status label shown in the aura field for this pass; falls back
   *  to statusVerb(variant.kind) when omitted. */
  statusLabel?: string;
  /** Encyclopedic level-1 bullet cap → the `base` prompt's {maxLevel1}. Undefined
   *  = default 10. Only encyclopedic generations pass it (see buildMessages). */
  maxLevel1?: number;
  /** Bullet-boundary commit gate (fresh instance per call): when set, `onAcc`
   *  fires only for gate-approved commits — intro live, then whole L1 bullets —
   *  instead of every frame, and is guaranteed one final call with the FULL
   *  text when the stream completes. Used by pass-1 spawn/restructure/whole-
   *  rewrite; the chip pass and expand-part (indented fragments never hit an
   *  L1 boundary) stream ungated. */
  commitGate?: CommitGate;
}): Promise<{
  finishReason?: string | null;
  citations: Citation[];
  rawText: string;
  webSearchRequested: boolean;
  webSearchUsed: boolean;
  webSearchRequests: number;
  googleSearchSuggestions?: string[];
  webSearchError?: string;
  /** Provider text after opaque internal evidence IDs become visible `(n)` keys. */
  normalizedText: string;
  internalSources: InternalNodeSource[];
  sourcePassages: RetrievedSourcePassage[];
  sourceOnlyInsufficient?: boolean;
  limitedSourceSearchReason?: string;
  sourceMode: 'ignore' | 'use' | 'only';
}> {
  const { nodeId, variant, parentIdForContext, signal, onAcc, sanitize, maxOutputTokens } = opts;
  retryArgs.set(nodeId, { variant, parentIdForContext });
  const settings = useSettingsStore.getState();
  const projectId = useGraphStore.getState().activeProjectId;
  let sourcePassages: RetrievedSourcePassage[] = [];
  let sourceMode: 'ignore' | 'use' | 'only' = 'ignore';
  let sourceOnlyInsufficient = false;
  let limitedSourceSearchReason: string | undefined;
  let sourceProcessVisible = false;
  const override = opts.modelOverride
    ? getProviderById(settings, opts.modelOverride.providerId)
    : undefined;
  const provider = override ?? getActiveProvider(settings);
  const model = override ? opts.modelOverride!.model : settings.activeModelRef?.model;
  const embeddedImages = new EmbeddedImageText();
  const languageNode = projectId ? getGenProject(projectId)?.nodes[nodeId] : undefined;
  const language = versionLanguage(languageNode?.versions[languageNode.generatingVersionIndex ?? languageNode.currentVersionIndex]);
  const initialMessages = buildMessages({ variant, context: contextFor(parentIdForContext, nodeId), maxLevel1: opts.maxLevel1 })
    .map(message => message.role === 'system' && variant.kind !== 'add-chips'
      ? { ...message, content: message.content + '\n\n' + generationLanguagePrompt(language) } : message)
    .map(message => ({ ...message, content: embeddedImages.protect(message.content) }));
  if (projectId && !SOURCE_POLICY_EXCLUDED_KINDS.has(variant.kind)) {
    const project = getGenProject(projectId) ?? useGraphStore.getState().project;
    if (project?.id === projectId) {
      const skipPendingSources = variant.kind === 'root' && variant.skipPendingSources === true;
      const snapshot = snapshotSourcePolicy(project, { includePending: !skipPendingSources });
      sourceMode = snapshot.mode;
      if (sourceMode !== 'ignore') {
        setNodeStatus(nodeId, 'WAITING FOR SOURCES');
        await waitForProjectSources(projectId, snapshot.pendingJobIds, signal);
        const fresh = getGenProject(projectId) ?? useGraphStore.getState().project;
        if (fresh?.id === projectId) {
          const afterWait = snapshotSourcePolicy(fresh, { includePending: !skipPendingSources });
          const refreshedSnapshot = {
            ...afterWait,
            // The source policy itself is captured at click time. Sources that
            // were already checked stay fixed; newly completed imports that the
            // click explicitly waited for are added, but later mode toggles do
            // not rewrite this request underneath the user.
            mode: snapshot.mode,
            sourceIds: [...new Set([...snapshot.sourceIds, ...afterWait.sourceIds.filter((id) => {
              const source = fresh.sourceLibrary?.sources[id];
              return !!source && (
                snapshot.pendingSourceIds.includes(id)
                || (!!source.originalUrl && snapshot.pendingUrls.includes(source.originalUrl))
              );
            })])],
          };
          refreshedSnapshot.revisionIds = refreshedSnapshot.sourceIds.map((id) => (
            fresh.sourceLibrary?.sources[id]?.activeRevisionId ?? ''
          ));
          sourceMode = snapshot.mode;
          if (refreshedSnapshot.sourceIds.length > 0) {
            const query = initialMessages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
            const updateEmbeddingStatus = () => {
              const embedding = useSourceRuntimeStore.getState();
              if (embedding.embeddingStatus !== 'downloading' && embedding.embeddingStatus !== 'loading') return;
              sourceProcessVisible = true;
              const label = embedding.embeddingStatus === 'loading'
                ? 'LOADING SOURCE SEARCH LOCALLY'
                : embedding.embeddingProgress > 0
                  ? `DOWNLOADING SOURCE SEARCH ${Math.round(embedding.embeddingProgress)}%`
                  : 'DOWNLOADING SOURCE SEARCH';
              setNodeStatus(
                nodeId,
                label,
                'source-search',
              );
            };
            updateEmbeddingStatus();
            const unsubscribeEmbedding = useSourceRuntimeStore.subscribe(updateEmbeddingStatus);
            await prepareSourceEmbeddingModel();
            unsubscribeEmbedding();
            if (sourceProcessVisible) {
              useNodeStatusStore.getState().clearProcessStatus(nodeId, 'source-search');
              sourceProcessVisible = false;
            }
            setNodeStatus(nodeId, 'SEARCHING SOURCES');
            const retrieval = await retrieveProjectSources({
              project: fresh,
              snapshot: refreshedSnapshot,
              query,
              signal,
            });
            sourcePassages = retrieval.passages;
            limitedSourceSearchReason = retrieval.limitedReason;
            if (limitedSourceSearchReason) {
              sourceProcessVisible = true;
              setNodeStatus(nodeId, 'SEARCHING SOURCES — KEYWORDS ONLY', 'source-search');
            }
          }
          sourceOnlyInsufficient = sourceMode === 'only' && sourcePassages.length === 0;
        }
      }
    }
  }
  const wantsWebSearch = sourceMode === 'only' ? false : (opts.webSearch ?? settings.webSearch);
  const didWebSearch = !!provider && !!model && wantsWebSearch
    && modelSupportsWebSearch(provider.preset, model,
      useModelCatalogStore.getState().getModel(provider.id, model), provider.webSearchEndpoint, provider.serverSearch, settings.modelCompatibilityOverrides?.main);
  if (!provider || !provider.apiKey || !model) {
    if (sourceProcessVisible) useNodeStatusStore.getState().clearProcessStatus(nodeId, 'source-search');
    setGenFlags(nodeId, {
      generating: false,
      generationError: 'Configure API key and model first',
    });
    return {
      citations: [], rawText: '', webSearchRequested: didWebSearch,
      webSearchUsed: false, webSearchRequests: 0, normalizedText: '', internalSources: [], sourcePassages, sourceMode,
    };
  }
  if (sourceOnlyInsufficient) {
    if (sourceProcessVisible) useNodeStatusStore.getState().clearProcessStatus(nodeId, 'source-search');
    return {
      citations: [], rawText: '', normalizedText: '', internalSources: [], sourcePassages,
      webSearchRequested: false, webSearchUsed: false, webSearchRequests: 0,
      sourceOnlyInsufficient: true,
      limitedSourceSearchReason,
      sourceMode,
    };
  }
  const sourceMessages = sourceMode !== 'ignore' && sourcePassages.length
    ? appendSourceEvidence(initialMessages, formatSourceEvidenceBlock(sourceMode, sourcePassages))
    : initialMessages;
  const citationCleanMessages = sourceMode !== 'ignore'
    ? stripKnownInternalMarkers(sourceMessages, nodeId)
    : sourceMessages;
  let messages = didWebSearch ? addWebSearchGuidance(citationCleanMessages) : citationCleanMessages;
  let imageInputs;
  if (opts.imageContext && projectId) {
    const info = useModelCatalogStore.getState().catalog[provider.id]?.find((entry) => entry.id === model);
    if (!settings.modelCompatibilityOverrides?.main && !modelSupportsVision(provider.preset, model, info)) {
      throw new Error('Choose a main model that supports image input to ask about this image.');
    }
    const prepared = await prepareImageQuestion(projectId, opts.imageContext, signal);
    imageInputs = prepared.images;
    messages = appendSourceEvidence(messages, prepared.instructions);
  }
  let acc = '';
  const citations: Citation[] = [];
  let finishReason: string | null | undefined;
  let webSearchUsed = false;
  let webSearchRequests = 0;
  let googleSearchSuggestions: string[] | undefined;
  let webSearchError: string | undefined;
  let normalizedText = '';
  let internalSources: InternalNodeSource[] = [];
  setGenFlags(nodeId, { generating: true, generationError: undefined });
  // Part F — surface the current phase in the ASCII aura field (cleared by
  // the caller at the terminal generating:false).
  setNodeStatus(nodeId, opts.statusLabel ?? statusVerb(variant.kind));
  const adapter = getAdapter(provider.preset);
  const baseUrl = resolveBaseUrl(provider.preset, provider.baseUrl);
  // PERF: SSE deltas arrive far faster than the screen paints (often 20–60/s).
  // Every onAcc dispatch re-runs the whole downstream pipeline (store write →
  // canvas re-render → body re-parse → re-measure → aura/physics wake), so
  // dispatching per delta burns main-thread time on states that could never
  // be painted. The coalescer delivers the LATEST accumulator at most once
  // per displayed frame; sanitization also moves inside so it runs per frame,
  // not per delta. With a `commitGate`, per-frame deliveries additionally
  // collapse to bullet-boundary commits (intro live, then whole L1 bullets) —
  // on long nodes the per-frame pipeline was O(total text) per frame. The
  // finally block guarantees callers observe the FINAL text (gate.finalize /
  // flush) — or, on abort, that a delivery scheduled just before the abort
  // can never write after it (cancel).
  const prepare = (raw: string): string => {
    const safeAcc = embeddedImages.restore(raw).replace(/<<<EXPAND>>>|<<<END>>>/g, '');
    const citationSafe = didWebSearch ? placeVisibleCitationMarkers(safeAcc, embeddedImages.restoreCitations(raw, citations)) : safeAcc;
    const internal = normalizeInternalCitationTokens(citationSafe, sourcePassages);
    normalizedText = internal.body;
    internalSources = internal.sources;
    return sanitize ? sanitize(internal.body) : internal.body;
  };
  const gate = opts.commitGate;
  const coalesced = makeFrameCoalescer<string>((raw) => {
    const prepared = prepare(raw);
    if (!gate) {
      onAcc(prepared);
      return;
    }
    const commit = gate.next(prepared);
    if (commit !== null) onAcc(commit);
  });
  try {
    for await (const chunk of adapter.streamChat(provider.apiKey, {
      model,
      messages,
      imageInputs,
      maxOutputTokens: mainOutputTokens(settings.outputTokenCap, maxOutputTokens),
      signal,
      webSearch: didWebSearch,
      webSearchEndpoint: provider.webSearchEndpoint,
      serverSearch: provider.serverSearch,
      allowUnverifiedCapabilities: settings.modelCompatibilityOverrides?.main,
      // Main generation honors the user's reasoning dial; the chip pass and
      // one-shots pass 'low' explicitly, which wins over the default here.
      reasoningEffort: opts.reasoningEffort ?? settings.reasoningEffort,
      modelInfo: useModelCatalogStore.getState().getModel(provider.id, model),
    }, baseUrl)) {
      if (signal.aborted) return {
        finishReason, citations: embeddedImages.restoreCitations(acc, citations), rawText: embeddedImages.restore(acc),
        normalizedText, internalSources, sourcePassages,
        webSearchRequested: didWebSearch, webSearchUsed, webSearchRequests, webSearchError, googleSearchSuggestions,
        limitedSourceSearchReason,
        sourceMode,
      };
      if (chunk.finishReason) finishReason = chunk.finishReason;
      googleSearchSuggestions = mergeGoogleSearchSuggestions(googleSearchSuggestions, chunk.googleSearchSuggestions);
      if (chunk.citations) {
        citations.push(...chunk.citations);
        if (chunk.citations.length) webSearchUsed = true;
      }
      if (chunk.webSearch) {
        webSearchUsed ||= chunk.webSearch.used;
        webSearchRequests = Math.max(webSearchRequests, chunk.webSearch.requestCount ?? 0);
        if (chunk.webSearch.error) webSearchError = chunk.webSearch.error;
      }
      if (chunk.delta) {
        acc += chunk.delta;
        coalesced.push(acc);
      }
      if (chunk.done) break;
    }
    // Some gateways omit structured annotations while the model still writes
    // valid source links into its answer. Recover those links before deciding
    // that the response has no usable citation catalog.
    if (didWebSearch) {
      const known = new Set(citations.map((citation) => citation.url));
      for (const citation of extractInlineCitations(acc)) {
        if (!known.has(citation.url)) {
          citations.push(citation);
          known.add(citation.url);
        }
      }
    }
    // An optional search-capable model may decline the tool yet print citation-
    // looking `[1]` or `[domain]` text from memory. With no structured source
    // behind it, remove that misleading notation before the final paint. This
    // is intentionally limited to requests where the user enabled web search.
    if (didWebSearch && citations.length === 0) {
      const cleaned = stripUnbackedCitationLabels(acc);
      if (cleaned !== acc) {
        acc = cleaned;
        coalesced.push(acc);
      }
    }
    return {
      finishReason, citations: embeddedImages.restoreCitations(acc, citations), rawText: embeddedImages.restore(acc),
      normalizedText: normalizeInternalCitationTokens(embeddedImages.restore(acc), sourcePassages).body,
      internalSources: normalizeInternalCitationTokens(embeddedImages.restore(acc), sourcePassages).sources,
      sourcePassages,
      webSearchRequested: didWebSearch, webSearchUsed, webSearchRequests, webSearchError, googleSearchSuggestions,
      limitedSourceSearchReason,
      sourceMode,
    };
  } finally {
    if (sourceProcessVisible) useNodeStatusStore.getState().clearProcessStatus(nodeId, 'source-search');
    if (signal.aborted) {
      coalesced.cancel();
    } else if (gate) {
      // A pending frame delivery would only re-enter the gate; cancel it and
      // hand the caller the FULL text (the withheld in-progress bullet and
      // any trailing prose included) in one final call.
      coalesced.cancel();
      onAcc(gate.finalize(prepare(acc)));
    } else {
      coalesced.flush();
    }
  }
}

/**
 * Spawn-path streaming: writes each chunk directly into the new
 * node's current version body. Used by `generateRoot`,
 * `spawnTermClick`, `spawnFollowUp`, and `retryGeneration` — none of
 * which are rewrites of an existing body.
 */
/** Variant kinds that produce a full fresh node body and should pass the
 *  two-level structure self-check. 'restructure' is deliberately absent so the
 *  corrective pass runs at most once (it is the loop guard). modify / elaborate
 *  / expand-part are excluded — they're edits, not fresh generations. */
const STRUCTURE_CHECK_KINDS = new Set<TaskVariant['kind']>([
  'root', 'term-click', 'follow-up', 'pop-rework',
]);

// ───────────────────────────────────────────────────────────────────
// Pass 2 — chip marking (the second AI call that turns plain text into chips)
// ───────────────────────────────────────────────────────────────────

/** Spawn kinds that, after producing a plain body, get a pass-2 chip-marking
 *  step in `streamIntoVersion`. (The rewrite paths run it explicitly.) */
const CHIP_PASS_KINDS = new Set<TaskVariant['kind']>([
  'root', 'term-click', 'follow-up', 'pop-rework', 'explain',
]);

/** Term selection is shared with chat: the model returns names, and local
 * Markdown-aware insertion preserves the source. No mid-stream body writes;
 * the aura's status is the progress signal. The caller owns generation flags. */
async function streamChipPass(opts: {
  nodeId: string;
  projId: string | null;
  plainBody: string;
  signal: AbortSignal;
}): Promise<string> {
  const { nodeId, projId, plainBody, signal } = opts;
  setNodeStatus(nodeId, 'MARKING TERMS');
  const result = await markTerms(plainBody, signal);
  if (signal.aborted) return plainBody;
  return unchipHeaders(result.body, redundantChipHeaders(projId, nodeId));
}

/** Own/parent/sibling titles are redundant on non-root nodes. */
function redundantChipHeaders(projId: string | null, nodeId: string): string[] {
  if (!projId) return [];
  const proj = getGenProject(projId);
  if (!proj) return [];
  const node = proj.nodes[nodeId];
  if (!node) return [];
  if (node.type === 'root' || proj.rootNodeId === nodeId) return [];

  const headerOf = (id: string): string | undefined => {
    const n = proj.nodes[id];
    return n?.versions[n.currentVersionIndex]?.header;
  };
  const headers: string[] = [];
  const own = headerOf(nodeId);
  if (own) headers.push(own);

  const incoming = Object.values(proj.arrows).find(
    (a) => a.kind === 'auto' && a.toNodeId === nodeId,
  );
  const parentId = incoming?.fromNodeId;
  if (parentId) {
    const ph = headerOf(parentId);
    if (ph) headers.push(ph);
    for (const a of Object.values(proj.arrows)) {
      if (a.kind === 'auto' && a.fromNodeId === parentId && a.toNodeId !== nodeId) {
        const sh = headerOf(a.toNodeId);
        if (sh) headers.push(sh);
      }
    }
  }
  return headers;
}

/** Write a node version's body in place (undo-paused, follows the captured
 *  project even across project switches). Used to stream chips into an
 *  already-committed rewrite version without adding a new version/undo step. */
function writeVersionBodyInPlace(
  projId: string,
  nodeId: string,
  versionIndex: number,
  body: string,
): void {
  const node = getGenProject(projId)?.nodes[nodeId];
  if (!node) return;
  const versions = [...node.versions];
  const cur = versions[versionIndex];
  if (!cur) return;
  versions[versionIndex] = { ...cur, body };
  updateGenNode(projId, nodeId, { versions });
}

/**
 * Rewrite-path chip pass: mark chips on the node's CURRENT (just-committed,
 * plain) version body, in place. Keeps `generating` true throughout (header
 * keeps pulsing, node keeps tracking size), then clears it. Adds no new version
 * or undo step (writes go through updateGenNode, which is undo-paused). Restores
 * `retryArgs` so the Retry button replays the user's action, not the chip pass.
 */
async function addChipsToCurrentVersion(nodeId: string, targetVersionIndex?: number, retryPreviews = false): Promise<void> {
  const projId = useGraphStore.getState().activeProjectId;
  if (!projId) return;
  const node = getGenProject(projId)?.nodes[nodeId];
  if (!node) return;
  const idx = getGenerationSession(projId, nodeId)?.draftVersionIndex ?? targetVersionIndex ?? node.currentVersionIndex;
  const plainBody = node.versions[idx]?.body ?? '';
  if (!plainBody.trim()) return;
  const imageVersion = node.versions[idx];
  if (imageVersion && !imageVersion.imageRecommendations && !imageVersion.wikimediaImages) {
    // Image selection reads the complete plain prose and does not depend on
    // term chips. Start it now so both secondary tasks run in parallel.
    void startWikimediaDiscovery(nodeId, imageVersion.createdAt, {
      automatic: true,
      allowDuringGeneration: true,
    });
  }
  const savedRetry = retryArgs.get(nodeId);
  const ctrl = new AbortController();
  const generationSession = getGenerationSession(projId, nodeId);
  const unregisterController = generationSession
    ? registerGenerationController(generationSession.id, ctrl)
    : () => undefined;
  setGenFlags(nodeId, { generating: true, generatingVersionIndex: idx, generationError: undefined });
  if (imageVersion?.contentType === 'answer') setNodeStatus(nodeId, 'MARKING TERMS');
  try {
    const chipped = imageVersion?.contentType === 'answer'
      ? (await markChatTerms(plainBody, ctrl.signal)).body
      : await streamChipPass({
      nodeId,
      projId,
      plainBody,
      signal: ctrl.signal,
    });
    const targetIndex = getGenProject(projId)?.nodes[nodeId]?.versions.findIndex(version => version.createdAt === imageVersion?.createdAt) ?? -1;
    if (!ctrl.signal.aborted && targetIndex >= 0) writeVersionBodyInPlace(projId, nodeId, targetIndex, chipped);
  } catch {
    // Leave the plain body — never worse than today's chip-free text.
  } finally {
    unregisterController();
    if (savedRetry) retryArgs.set(nodeId, savedRetry);
    setGenFlags(nodeId, { generating: false });
    useNodeStatusStore.getState().clearStatus(nodeId);
    if (!ctrl.signal.aborted && imageVersion && useGraphStore.getState().activeProjectId === projId) {
      void generateTermPreviews(nodeId, imageVersion.createdAt, retryPreviews);
    }
  }
}

/**
 * "Redo terms marking" (side-panel button): clone the current version with its
 * chips stripped into a NEW version — one undoable step, mirroring
 * finishRewrite's commit — advance to it, then run the chip pass over it in
 * place. The text is identical modulo [[chip]] markup, so every per-version
 * sizing field carries over (no card-size jump); a failed/aborted chip pass
 * leaves the plain body, same fallback as every other chip pass.
 */
function nextTextVersionTimestamp(node: ScatterNode): number {
  return node.versions.reduce((next, version) => Math.max(next, version.createdAt + 1), Date.now());
}

export async function redoTermMarking(nodeId: string): Promise<void> {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node || node.generating) return;              // belt & braces with the disabled button
  if (currentContentType(node) === 'media') return;  // text panels only
  const cur = node.versions[node.currentVersionIndex];
  if (!cur) return;
  const plain = stripTermMarkers(cur.body);
  if (!plain.trim()) return;

  const { media: _media, ...rest } = cur;            // never carry a MediaRef
  const newVersion: NodeVersion = { ...rest, answerEnrichmentId: undefined, body: plain, createdAt: nextTextVersionTimestamp(node) };
  const versions = [...node.versions, newVersion];
  const projectId = activeGenerationProjectId();
  const generationSession = projectId ? beginGenerationSession({
    projectId,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex: node.currentVersionIndex,
    draftVersionIndex: versions.length - 1,
  }) : undefined;
  useGraphStore.getState().updateNode(nodeId, {      // the ONE undoable step
    versions,
    currentVersionIndex: versions.length - 1,
  });
  if (generationSession) trackGenerationVersions(generationSession);
  await addChipsToCurrentVersion(nodeId, undefined, true); // undo-paused in-place writes; retry missing previews
  if (projectId && generationSession) {
    finishGenerationSession(projectId, nodeId, generationSession.id);
  }
}

async function streamIntoVersion(
  nodeId: string,
  variant: TaskVariant,
  parentIdForContext: string | null,
  targetVersionIndex?: number,
  expectedVersionCreatedAt?: number,
): Promise<void> {
  // The project this generation belongs to, captured at start. If the user
  // switches to another project mid-stream, writes follow THIS id into the
  // background registry (bgGen.ts) instead of leaking into — or being dropped
  // by — whatever project is active when each chunk arrives.
  const genProjectId = useGraphStore.getState().activeProjectId;
  const initialStreamVersionIndex = targetVersionIndex
    ?? (genProjectId ? getGenProject(genProjectId)?.nodes[nodeId]?.currentVersionIndex : undefined)
    ?? useGraphStore.getState().project?.nodes[nodeId]?.currentVersionIndex
    ?? 0;
  let generationSession = genProjectId
    ? getGenerationSession(genProjectId, nodeId)
    : undefined;
  const ownsGenerationSession = !!genProjectId && !generationSession;
  if (genProjectId && !generationSession) {
    generationSession = beginGenerationSession({
      projectId: genProjectId,
      nodeId,
      kind: 'spawn',
      sourceVersionIndex: null,
      draftVersionIndex: initialStreamVersionIndex,
    });
  }
  const streamVersionIndex = () => generationSession?.draftVersionIndex ?? initialStreamVersionIndex;
  if (generationSession) trackGenerationVersions(generationSession);
  // A retry reuses the same version object. Clear provenance from the previous
  // attempt before the new request starts so switching search off (or receiving
  // a different source set) can never leave a stale success label/sources.
  if (genProjectId) {
    const node = getGenProject(genProjectId)?.nodes[nodeId];
    const current = node?.versions[streamVersionIndex()];
    if (node && current) {
      const versions = [...node.versions];
      versions[streamVersionIndex()] = {
        ...current,
        language: current.language ?? normalizeLanguage(useSettingsStore.getState().generationLanguage),
        ...(current.imageQuestion && current.imageTitleState === 'failed' ? { imageTitleState: 'pending' as const } : {}),
        sources: undefined,
        googleSearchSuggestions: undefined,
        internalSources: undefined,
        sourceLimitation: undefined,
        webSearched: undefined,
        webSearchFailed: undefined,
      };
      updateGenNode(genProjectId, nodeId, { versions });
    }
  }
  const ctrl = new AbortController();
  const unregisterController = generationSession
    ? registerGenerationController(generationSession.id, ctrl)
    : () => undefined;
  let finalBody = '';
  let imageTitleTask: Promise<void> | undefined;
  const targetPresent = () => expectedVersionCreatedAt == null || (genProjectId
    ? getGenProject(genProjectId)?.nodes[nodeId]?.versions[streamVersionIndex()]?.createdAt === expectedVersionCreatedAt
    : false);
  // In-place first generation leaves the blank card behind when undone.
  // Cancel its request and refuse late writes into that restored version.
  const unsubscribeTarget = expectedVersionCreatedAt == null ? () => {} : useGraphStore.subscribe(state => {
    if (state.project?.id !== genProjectId || targetPresent()) return;
    ctrl.abort();
    if (genProjectId && getGenerationSession(genProjectId, nodeId)?.id === generationSession?.id) {
      cancelGenerationSession(genProjectId, nodeId);
      useNodeStatusStore.getState().clearStatus(nodeId);
    }
  });
  const superseded = () => {
    const current = genProjectId ? getGenerationSession(genProjectId, nodeId) : undefined;
    return !targetPresent() || (!!current && !!generationSession && current.id !== generationSession.id);
  };
  const onAcc = (sanitizedAcc: string) => {
    if (superseded()) return;
    finalBody = sanitizedAcc;
    if (sanitizedAcc.trim() && generationSession) {
      markGenerationTextReceived(generationSession.id);
    }
    if (!genProjectId) return;
    const proj = getGenProject(genProjectId);
    const node = proj?.nodes[nodeId];
    if (!node) return;
    const versions = [...node.versions];
    const cur = versions[streamVersionIndex()];
    if (!cur) return;
    versions[streamVersionIndex()] = { ...cur, body: sanitizedAcc };
    updateGenNode(genProjectId, nodeId, { versions });
  };
  try {
    // Pass-1 TEXT is streaming → the tail skeleton (ghost bullet) shows and
    // the body cap carries its sizing reserve. Cleared below once the text
    // (incl. any corrective restructure) is complete — the chip pass runs
    // with `generating` still true but no skeleton.
    if (genProjectId) updateGenNode(genProjectId, nodeId, { streamingText: true });
    let pass1 = await streamChunks({
      nodeId, variant, parentIdForContext, signal: ctrl.signal, onAcc,
      imageContext: genProjectId ? getGenProject(genProjectId)?.nodes[nodeId]?.versions[streamVersionIndex()]?.imageContext : undefined,
      commitGate: makeBulletCommitGate(),
    });
    if (superseded()) return;
    // `onAcc` is presentation-safe (provider citation syntax is normalized or
    // hidden). Validation and final placement must use the untouched provider
    // text so an incomplete source URL cannot be mistaken for a complete body.
    finalBody = pass1.normalizedText;

    if (
      !ctrl.signal.aborted
      && pass1.sourceMode === 'only'
      && pass1.rawText.trim()
      && !hasStrictSourceCoverage(pass1.rawText, pass1.sourcePassages)
    ) {
      const repairedRaw = await repairStrictSourceCitations({
        nodeId,
        body: pass1.rawText,
        passages: pass1.sourcePassages,
        signal: ctrl.signal,
        onAcc,
      });
      if (!hasStrictSourceCoverage(repairedRaw, pass1.sourcePassages)) {
        if (genProjectId) updateGenNode(genProjectId, nodeId, {
          generating: false,
          streamingText: false,
          generationError: 'Sources only could not trace every factual passage to the active sources. The untraceable answer was not saved.',
        });
        useNodeStatusStore.getState().clearStatus(nodeId);
        return;
      }
      const repaired = normalizeInternalCitationTokens(repairedRaw, pass1.sourcePassages);
      pass1 = { ...pass1, rawText: repairedRaw, normalizedText: repaired.body, internalSources: repaired.sources };
      finalBody = repaired.body;
      onAcc(finalBody);
    }

    if (!ctrl.signal.aborted && pass1.sourceOnlyInsufficient) {
      if (genProjectId) {
        const proj = getGenProject(genProjectId);
        const node = proj?.nodes[nodeId];
        const cur = node?.versions[streamVersionIndex()];
        if (node && cur) {
          const versions = [...node.versions];
          versions[streamVersionIndex()] = {
            ...cur,
            body: '',
            internalSources: undefined,
            sourceLimitation: {
              kind: 'not-enough-information',
              message: 'Sources only: Not enough information in active sources.',
              action: 'whole',
            },
          };
          updateGenNode(genProjectId, nodeId, {
            versions,
            generating: false,
            streamingText: false,
            generationError: undefined,
          });
        }
      }
      useNodeStatusStore.getState().clearStatus(nodeId);
      return;
    }

    // Validate that pass 1 produced an answer BEFORE citation placement or the
    // corrective structure pass. Previously an empty/tool-call-only response
    // was fed into "CHECKING STRUCTURE", creating a second doomed request and
    // hiding the real provider failure behind a misleading status.
    if (!ctrl.signal.aborted && pass1.rawText.trim() === '') {
      if (genProjectId) updateGenNode(genProjectId, nodeId, {
        generating: false,
        streamingText: false,
        generationError:
          'The model returned no text. If you picked an image or other non-text model, switch to a text model (e.g. a *-flash chat model) and retry.',
      });
      useNodeStatusStore.getState().clearStatus(nodeId);
      return;
    }
    if (!ctrl.signal.aborted && looksLikeLeakedWebSearchToolCall(finalBody)) {
      if (genProjectId) updateGenNode(genProjectId, nodeId, {
        generating: false,
        streamingText: false,
        generationError:
          'The model returned a raw web search tool call instead of an answer. Retry, or turn off web search for this model.',
      });
      useNodeStatusStore.getState().clearStatus(nodeId);
      return;
    }
    const completionError = generationCompletionError(
      pass1.rawText,
      pass1.finishReason,
      pass1.citations,
    );
    if (!ctrl.signal.aborted && completionError) {
      if (genProjectId) {
        const proj = getGenProject(genProjectId);
        const node = proj?.nodes[nodeId];
        const cur = node?.versions[streamVersionIndex()];
        if (node && cur) {
          const versions = [...node.versions];
          // Never leave the provider's cut-off URL or half sentence visible.
          versions[streamVersionIndex()] = { ...cur, body: '' };
          updateGenNode(genProjectId, nodeId, {
            versions,
            generating: false,
            streamingText: false,
            generationError: completionError,
          });
        }
      }
      useNodeStatusStore.getState().clearStatus(nodeId);
      return;
    }
    const hasCitations = pass1.citations.length > 0;

    // Web-search citations → place inline ⟦n⟧ markers into the pass-1 body NOW,
    // while it IS the model content (pre-chip; local marker insertion preserves
    // these tokens, and we renumber + attach sources after).
    // PREFER the model's OWN inline citation links when it wrote them (correct
    // positions); else use the provider's char offsets (valid for Gemini; GLM
    // returns all-0 offsets that would cluster every marker at char 0).
    let citationSources: NodeSource[] = [];
    if (hasCitations && !ctrl.signal.aborted && finalBody.trim() !== '') {
      const internalCount = pass1.internalSources.length;
      citationSources = buildSources(pass1.citations).map((source) => ({
        ...source,
        n: source.n + internalCount,
      }));
      const citedProviderBody = placeCitationMarkersReliable(
        pass1.rawText,
        pass1.citations,
        citationSources,
      );
      finalBody = normalizeInternalCitationTokens(citedProviderBody, pass1.sourcePassages).body;
      onAcc(finalBody);
    }

    // Structure self-check: if a freshly-generated node doesn't have ≥2 level-1
    // bullets each with ≥2 level-2 children, re-generate ONCE in place with a
    // corrective instruction. We re-use streamChunks (not a recursive
    // streamIntoVersion) so genProjectId / onAcc stay captured even if the user
    // switched projects. 'restructure' is not in STRUCTURE_CHECK_KINDS, so this
    // can't loop. All writes go through updateGenNode (undo-paused), so the
    // whole generate→detect→regenerate stays a single undo entry.
    // Citation markers are already normalized before this point. The protected
    // restructure prompt preserves them, and the final safety net restores any
    // marker the corrective model accidentally drops.
    if (STRUCTURE_CHECK_KINDS.has(variant.kind) && !isValidStructure(finalBody)) {
      const malformed = finalBody;
      const restructure = await streamChunks({
        nodeId,
        variant: { kind: 'restructure', previousBody: malformed },
        parentIdForContext,
        signal: ctrl.signal,
        onAcc,
        // The original search already produced the evidence catalog. Searching
        // again would change the sources while this pass only fixes structure.
        webSearch: false,
        commitGate: makeBulletCommitGate(), // fresh gate — new stream, new state
      });
      const restructureError = generationCompletionError(
        restructure.rawText,
        restructure.finishReason,
        restructure.citations,
      );
      if (!ctrl.signal.aborted && (restructureError || !isValidStructure(finalBody))) {
        if (genProjectId) updateGenNode(genProjectId, nodeId, {
          generating: false,
          streamingText: false,
          generationError: restructureError
            ?? 'The model did not produce the required two-level outline, even after a structure-repair pass. Retry once; if this repeats, restore the relevant system prompt or choose a model with stronger structured output.',
        });
        useNodeStatusStore.getState().clearStatus(nodeId);
        return;
      }
      // Keep the manual Retry button replaying the ORIGINAL generation, not the
      // internal corrective pass (streamChunks overwrote retryArgs).
      retryArgs.set(nodeId, { variant, parentIdForContext });
    }

    // Sources become part of the live generating version as soon as pass 1 is
    // complete. The side panel can therefore expose them throughout the term-
    // marking pass instead of making them appear only after all generation ends.
    if (!ctrl.signal.aborted && genProjectId && (
      citationSources.length || pass1.webSearchRequested || pass1.internalSources.length || pass1.limitedSourceSearchReason
    )) {
      const proj = getGenProject(genProjectId);
      const node = proj?.nodes[nodeId];
      const cur = node?.versions[streamVersionIndex()];
      if (node && cur) {
        const versions = [...node.versions];
        versions[streamVersionIndex()] = {
          ...cur,
          sources: citationSources.length ? citationSources : cur.sources,
          googleSearchSuggestions: pass1.googleSearchSuggestions,
          internalSources: pass1.internalSources.length ? pass1.internalSources : undefined,
          sourceLimitation: pass1.limitedSourceSearchReason ? {
            kind: 'limited-search',
            message: 'Limited source search',
            reason: pass1.limitedSourceSearchReason,
          } : undefined,
          webSearched: pass1.webSearchUsed ? true : undefined,
          webSearchFailed: pass1.webSearchRequested && !pass1.webSearchUsed ? true : undefined,
        };
        updateGenNode(genProjectId, nodeId, { versions });
      }
    }

    // Text is final — drop the tail skeleton + its reserve before the chip
    // pass (the next measure tick returns the reserved height to the layout).
    if (genProjectId) updateGenNode(genProjectId, nodeId, { streamingText: false });
    if (genProjectId && !ctrl.signal.aborted) {
      // The main vision answer has identified the selected subject. Title work
      // can now run alongside term marking with any text-capable secondary model.
      imageTitleTask = generateImageQuestionTitle(genProjectId, nodeId, streamVersionIndex(), finalBody, ctrl.signal);
    }

    // Pass 2 — chip marking. Runs in place on the same version body (via the
    // existing undo-paused `onAcc` writer), AFTER any restructure, while
    // `generating` is still true — so the header keeps pulsing, the node keeps
    // tracking size, and the whole spawn stays one undo entry. `finalBody` here
    // is the plain post-restructure body.
    if (CHIP_PASS_KINDS.has(variant.kind) && !ctrl.signal.aborted) {
      if (genProjectId === useGraphStore.getState().activeProjectId) {
        const imageVersion = useGraphStore.getState().project?.nodes[nodeId]
          ?.versions[streamVersionIndex()];
        if (imageVersion && !imageVersion.imageRecommendations && !imageVersion.wikimediaImages) {
          // The complete prose is now stable. Image discovery can consume this
          // plain snapshot while term marking independently adds [[chips]].
          void startWikimediaDiscovery(nodeId, imageVersion.createdAt, {
            automatic: true,
            allowDuringGeneration: true,
          });
        }
      }
      const chipped = await streamChipPass({
        nodeId,
        projId: genProjectId,
        plainBody: finalBody,
        signal: ctrl.signal,
      });
      if (!ctrl.signal.aborted) onAcc(chipped);
      // Keep Retry tied to the user's generation, never to term selection.
      retryArgs.set(nodeId, { variant, parentIdForContext });
    }

    // Finalize: attach the (renumbered) citation sources and the web-searched
    // flag to the version. Markers were exact-placed pre-chip and preserved by
    // the chip pass; here we clean the numbering (1..k reading order) and, as a
    // safety net, tail-match re-place any marker the chip pass happened to drop.
    if (!ctrl.signal.aborted && genProjectId && (
      citationSources.length || pass1.webSearchRequested || pass1.internalSources.length || pass1.limitedSourceSearchReason
    )) {
      const proj = getGenProject(genProjectId);
      const node = proj?.nodes[nodeId];
      const cur = node?.versions[streamVersionIndex()];
      if (cur) {
        let body = cur.body;
        let sources = cur.sources;
        const availableInternal = new Map(pass1.internalSources.map((source) => [source.n, source]));
        const internalMap = new Map<number, number>();
        const internalSources: InternalNodeSource[] = [];
        body = body.replace(/\((\d+)\)/g, (token, digits: string) => {
          const oldN = Number(digits);
          const source = availableInternal.get(oldN);
          if (!source) return token;
          let n = internalMap.get(oldN);
          if (!n) {
            n = internalSources.length + 1;
            internalMap.set(oldN, n);
            internalSources.push({ ...source, n });
          }
          return `(${n})`;
        });
        if (citationSources.length) {
          const present = new Set([...body.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])));
          const missing = citationSources.filter((s) => !present.has(s.n));
          if (missing.length) {
            body = placeCitationMarkersReliable(
              body,
              pass1.citations
                .filter((c) => missing.some((s) => s.url === c.url))
                .map((c) => ({ ...c, startIndex: undefined, endIndex: undefined })),
              missing,
            );
          }
          const r = renumberCitations(body, citationSources, internalSources.length + 1);
          body = r.body;
          sources = r.sources;
        }
        const versions = [...node!.versions];
        versions[streamVersionIndex()] = {
          ...cur, body, sources,
          googleSearchSuggestions: pass1.googleSearchSuggestions,
          internalSources: internalSources.length ? internalSources : undefined,
          sourceLimitation: pass1.limitedSourceSearchReason ? {
            kind: 'limited-search',
            message: 'Limited source search',
            reason: pass1.limitedSourceSearchReason,
          } : undefined,
          webSearched: pass1.webSearchUsed ? true : undefined,
          webSearchFailed: pass1.webSearchRequested && !pass1.webSearchUsed ? true : undefined,
        };
        updateGenNode(genProjectId, nodeId, { versions });
      }
    }

    await imageTitleTask;
    if (superseded()) return;
    if (genProjectId) updateGenNode(genProjectId, nodeId, { generating: false, streamingText: false });
    useNodeStatusStore.getState().clearStatus(nodeId);
    if (!ctrl.signal.aborted && genProjectId === useGraphStore.getState().activeProjectId) {
      const version = useGraphStore.getState().project?.nodes[nodeId]?.versions[streamVersionIndex()];
      if (version) void generateTermPreviews(nodeId, version.createdAt);
    }
  } catch (e) {
    await imageTitleTask;
    if (superseded()) return;
    if (genProjectId) updateGenNode(genProjectId, nodeId, {
      generating: false,
      streamingText: false,
      generationError: friendlyErrorMessage(e),
    });
    useNodeStatusStore.getState().clearStatus(nodeId);
  } finally {
    unsubscribeTarget();
    // Empty answers, cancellation and provider errors cannot leave a spinner
    // behind. Retry can still regenerate the title from the original question.
    if (genProjectId && !superseded()) {
      const node = getGenProject(genProjectId)?.nodes[nodeId];
      const version = node?.versions[streamVersionIndex()];
      if (node && version?.imageTitleState === 'pending') {
        const versions = [...node.versions];
        versions[streamVersionIndex()] = { ...version, imageTitleState: 'failed' };
        updateGenNode(genProjectId, nodeId, { versions });
      }
    }
    unregisterController();
    if (ownsGenerationSession && genProjectId && generationSession) {
      finishGenerationSession(genProjectId, nodeId, generationSession.id);
    }
  }
}

/**
 * After a REGENERATION via the rewrite-burst path (regenerateNode /
 * regenerateHeader), run ONE in-place corrective restructure if the freshly
 * committed body fails the two-level structure check. Overwrites the
 * just-committed version body via the spawn streaming core, so it adds no extra
 * version and (writes being undo-paused) keeps the regenerate as one undo entry.
 * Skips on abort/error and when the kind isn't a fresh-generation kind.
 */
async function correctStructureAfterRegen(
  nodeId: string,
  kind: TaskVariant['kind'],
  parentIdForContext: string | null,
  targetVersionIndex: number,
): Promise<void> {
  if (!STRUCTURE_CHECK_KINDS.has(kind)) return;
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node || node.generationError) return;
  const projectId = activeGenerationProjectId();
  targetVersionIndex = (projectId ? getGenerationSession(projectId, nodeId)?.draftVersionIndex : undefined) ?? targetVersionIndex;
  const body = node.versions[targetVersionIndex]?.body ?? '';
  if (!body || isValidStructure(body)) return;
  setGenFlags(nodeId, { generating: true, generationError: undefined });
  await streamIntoVersion(
    nodeId,
    { kind: 'restructure', previousBody: body },
    parentIdForContext,
    targetVersionIndex,
  );
}

// ───────────────────────────────────────────────────────────────────
// One-shot completions (topic recommend) + project naming
// ───────────────────────────────────────────────────────────────────

/** Generic one-shot (non-streaming-to-UI) LLM call: send a system + user
 *  prompt, accumulate the streamed reply, return the trimmed text. Returns null
 *  when no provider/model is configured. Uses the active provider/model from
 *  settings; web search off. `maxOutputTokens` is a CEILING — the model stops
 *  when done, so a generous cap costs nothing but avoids mid-word truncation.
 *  Reused by scatter-naming and the topic-picker "recommend a topic" button. */
export async function oneShotCompletion(
  systemPrompt: string,
  userPrompt: string,
  maxOutputTokens = 256,
  modelOverride?: { providerId: string; model: string },
): Promise<string | null> {
  const settings = useSettingsStore.getState();
  const overrideProvider = modelOverride
    ? getProviderById(settings, modelOverride.providerId)
    : undefined;
  const usableOverride = !!overrideProvider
    && !!modelOverride
    && !!overrideProvider.apiKey.trim()
    && !!modelOverride.model.trim();
  if (modelOverride && !usableOverride) return null;
  const provider = usableOverride ? overrideProvider : getActiveProvider(settings);
  const model = usableOverride ? modelOverride!.model : settings.activeModelRef?.model;
  if (!provider || !provider.apiKey || !model) return null;
  const adapter = getAdapter(provider.preset);
  const baseUrl = resolveBaseUrl(provider.preset, provider.baseUrl);
  const embeddedImages = new EmbeddedImageText();
  const messages: ChatMessage[] = [
    { role: 'system', content: embeddedImages.protect(systemPrompt) },
    { role: 'user', content: embeddedImages.protect(userPrompt) },
  ];
  const ctrl = new AbortController();
  let acc = '';
  for await (const chunk of adapter.streamChat(provider.apiKey, {
    model, messages, maxOutputTokens: secondaryOutputTokens(settings, maxOutputTokens), signal: ctrl.signal, webSearch: false,
    // A one-shot phrase doesn't need deep reasoning; low effort keeps a reasoning
    // model from spending the budget thinking (and tacking on a rationale).
    reasoningEffort: 'low',
    modelInfo: useModelCatalogStore.getState().getModel(provider.id, model),
  }, baseUrl)) {
    if (chunk.delta) acc += chunk.delta;
    checkFinishReason(chunk.finishReason, 'secondary');
    if (chunk.done) break;
  }
  return embeddedImages.restore(acc.trim()) || null;
}

/** First pass for "Ask follow-up": choose an encyclopedic overview, a simple
 *  explanation, or a conversational response. A cheap one-shot.
 *  Defaults to `'explore'` on any error, missing
 *  model, or ambiguous reply, so the behaviour degrades to the previous
 *  always-encyclopedic follow-up. */
export async function classifyFollowUpIntent(
  parentId: string,
  question: string,
  userQuestion = question,
): Promise<'explore' | 'explain' | 'chat'> {
  const requested = explicitFollowUpIntent(userQuestion);
  if (requested) return requested;
  try {
    const settings = useSettingsStore.getState();
    const custom = settings.customPrompts;
    const prompt = buildFollowUpClassifierPrompt({
      question,
      context: contextFor(parentId),
      customPrompts: custom,
    });
    // Budget must clear the model's hidden reasoning, not just the one-word
    // answer. On a reasoning model (Gemini 3.x Flash, 2.5 Pro, …) the excluded
    // reasoning tokens STILL count against max_tokens, so a tight cap (this used
    // to be 16) gets fully consumed by thinking → empty `content` →
    // finish_reason:'length' → we parse '' → fall back to 'explore' EVERY time,
    // i.e. follow-ups silently never route to 'explain'. 512 leaves ample room
    // for low-effort reasoning + the single word (verified across Gemini 3.5
    // Flash / 2.5 Pro: 5/9 → 9/9, zero empty replies). Reasoning is billed
    // regardless of the ceiling, so the higher cap costs nothing extra.
    const routingOverride = settings.secondaryUseSameModel
      ? undefined
      : settings.secondaryModelRef;
    const reply = (await oneShotCompletion(prompt, question, 512, routingOverride)) ?? '';
    // The prompt asks for a single bare word; read the LAST word so a wrapped
    // reply still classifies. Anything unknown falls back to the legacy
    // `explore` behavior.
    const last = reply.trim().toLowerCase().replace(/[`"'.!]/g, '').split(/\s+/).pop() ?? '';
    return last === 'chat' ? 'chat' : last === 'explain' ? 'explain' : 'explore';
  } catch {
    return 'explore';
  }
}

/** Name the active project after the EXACT topic the user typed (no AI
 *  auto-naming). Only renames while the project still has a default auto-name,
 *  so a project the user renamed themselves is never clobbered. Fired by
 *  generateRoot. */
async function nameActiveScatterFromTopic(topic: string): Promise<void> {
  try {
    const scatterId = useGraphStore.getState().activeProjectId;
    if (!scatterId) return;
    const meta = useGraphStore.getState().projectList.find((m) => m.id === scatterId);
    if (meta && !isAutoScatterName(meta.name)) return;
    const name = topic.trim();
    if (name) await renameScatter(scatterId, name);
  } catch (e) {
    console.warn('[scatter] project naming failed:', e);
  }
}

// ───────────────────────────────────────────────────────────────────
// Rewrite burst infrastructure
// ───────────────────────────────────────────────────────────────────

interface RewriteCitationCtx {
  googleSearchSuggestions?: string[];
  /** Sources from the pre-rewrite version — carried over for markers the model
   *  preserved on unchanged sentences (modify/elaborate). */
  oldSources: NodeSource[];
  /** Fresh sources from THIS rewrite's web search, numbered after the surviving
   *  old ones so they don't collide before renumbering. */
  newSources: NodeSource[];
  internalSources: InternalNodeSource[];
  limitedSourceSearchReason?: string;
  webSearchRequested: boolean;
  webSearchUsed: boolean;
  webSearchError?: string;
}

type CommittedRewriteCitationCtx = RewriteCitationCtx & { versionIndex: number };

/** Citation metadata for every completed partial in the current rewrite burst.
 * Partial rewrites can overlap in time, so the last finisher must commit and
 * renumber the union instead of only its own provider response. */
const partialCitationContexts = new Map<string, Map<string, RewriteCitationCtx>>();

function setPartialCitationContext(nodeId: string, rewriteId: string, ctx: RewriteCitationCtx): void {
  const byRewrite = partialCitationContexts.get(nodeId) ?? new Map<string, RewriteCitationCtx>();
  byRewrite.set(rewriteId, ctx);
  partialCitationContexts.set(nodeId, byRewrite);
}

function aggregatePartialCitationContexts(nodeId: string): RewriteCitationCtx {
  const contexts = [...(partialCitationContexts.get(nodeId)?.values() ?? [])];
  const seenUrls = new Set<string>();
  const oldSources: NodeSource[] = [];
  const newSources: NodeSource[] = [];
  const internalSources: InternalNodeSource[] = [];
  const seenInternal = new Set<string>();
  for (const ctx of contexts) {
    for (const source of ctx.oldSources) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      oldSources.push(source);
    }
  }
  for (const ctx of contexts) {
    for (const source of ctx.newSources) {
      if (seenUrls.has(source.url)) continue;
      seenUrls.add(source.url);
      newSources.push(source);
    }
  }
  for (const ctx of contexts) {
    for (const source of ctx.internalSources) {
      const key = `${source.sourceId}\n${source.revisionId}\n${source.passageId}`;
      if (seenInternal.has(key)) continue;
      seenInternal.add(key);
      internalSources.push(source);
    }
  }
  return {
    oldSources,
    newSources,
    googleSearchSuggestions: mergeGoogleSearchSuggestions(...contexts.map(ctx => ctx.googleSearchSuggestions)),
    internalSources,
    limitedSourceSearchReason: contexts.find((ctx) => ctx.limitedSourceSearchReason)?.limitedSourceSearchReason,
    webSearchRequested: contexts.some((ctx) => ctx.webSearchRequested),
    webSearchUsed: contexts.some((ctx) => ctx.webSearchUsed),
    webSearchError: contexts.find((ctx) => ctx.webSearchError)?.webSearchError,
  };
}

/**
 * Initialize a burst snapshot for the node if one doesn't already
 * exist. Called by every rewrite at start. The first rewrite of the
 * burst seeds the snapshot from the current version; subsequent
 * rewrites in the same burst see the existing snapshot and reuse it.
 */
function beginBurst(
  nodeId: string,
  opts?: {
    replaceDraft?: ReturnType<typeof useRewriteStore.getState>['snapshot'][string];
    draftMeta?: RewriteVersionMeta;
  },
): void {
  const store = useRewriteStore.getState();
  // Reuse the existing burst snapshot ONLY while a rewrite is genuinely
  // in flight (≥1 active record). If a snapshot lingers with NO active
  // records, it's stale state left by a prior rewrite that didn't clean
  // up — discard it and re-capture from the current version, so a fresh
  // rewrite always starts from the real current body. (Previously this
  // guarded on `snapshot exists` alone, so stale state could make a new
  // partial read a stale working body, fail to locate its section, and
  // silently no-op — "expand never starts".)
  const hasActiveRecords = (store.activeByNode[nodeId]?.length ?? 0) > 0;
  if (hasActiveRecords) return;
  partialCitationContexts.delete(nodeId);
  const node = useGraphStore.getState().project!.nodes[nodeId]!;
  const replaceDraft = opts?.replaceDraft;
  const sourceVersionIndex = replaceDraft?.preBurstVersionIndex ?? node.currentVersionIndex;
  const cur = node.versions[sourceVersionIndex]!;
  const draftVersionIndex = replaceDraft?.draftVersionIndex ?? node.versions.length;
  const projectId = useGraphStore.getState().activeProjectId
    ?? useGraphStore.getState().project!.id;
  const generationSession = beginGenerationSession({
    projectId,
    nodeId,
    kind: 'rewrite',
    sourceVersionIndex,
    draftVersionIndex,
  });
  const {
    imageRecommendations: _oldImageRecommendations,
    wikimediaImages: _oldWikimediaImages,
    ...curWithoutImageRecommendations
  } = cur;
  const draft: NodeVersion = {
    ...curWithoutImageRecommendations,
    answerEnrichmentId: undefined,
    // A generated draft is a new factual state. Never make it look as though
    // the source version's evidence review still applies while text streams.
    factCheck: undefined,
    ...(opts?.draftMeta ? {
      header: opts.draftMeta.header,
      ...(opts.draftMeta.headerParts ? { headerParts: opts.draftMeta.headerParts } : {}),
      generatedBy: opts.draftMeta.generatedBy,
      maxL1Bullets: opts.draftMeta.maxL1Bullets,
      contentType: opts.draftMeta.contentType,
      language: opts.draftMeta.language ?? versionLanguage(cur),
    } : {}),
    ...(opts?.draftMeta?.selectedTextQuestion === null
      ? { selectedTextQuestion: undefined }
      : opts?.draftMeta?.selectedTextQuestion
        ? { selectedTextQuestion: opts.draftMeta.selectedTextQuestion }
        : {}),
    createdAt: nextTextVersionTimestamp(node),
  };
  const versions = [...node.versions];
  if (replaceDraft && versions[draftVersionIndex]) versions[draftVersionIndex] = draft;
  else versions.push(draft);
  // Size fields live on the version now.
  const wasAtMin =
    cur.bodyMaxHeight != null
    && cur.minBodyHeight != null
    && cur.bodyMaxHeight === cur.minBodyHeight;
  const selectorId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(nodeId)
    : nodeId.replace(/["\\]/g, '\\$&');
  const card = typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLElement>(`.node[data-node-id="${selectorId}"]`);
  const measuredSurface = card?.querySelector<HTMLElement>('.node-body');
  const measuredHeight = measuredSurface?.getBoundingClientRect().height ?? 0;
  const liveZoom = useLiveViewportStore.getState().zoom || 1;
  const visibleBodyHeight = measuredHeight > 0
    ? measuredHeight / liveZoom
    : null;
  // Measure the source before publishing the generating draft: an external
  // store update can synchronously repaint its subscribers.
  useGraphStore.getState().updateNode(nodeId, {
    versions,
    currentVersionIndex: draftVersionIndex,
    generating: true,
    generatingVersionIndex: draftVersionIndex,
    generationError: undefined,
  });
  store.setSnapshot(nodeId, {
    preBurstBody: cur.body,
    preBurstVersionIndex: sourceVersionIndex,
    draftVersionIndex,
    generationSessionId: generationSession.id,
    preBurstBodyMaxHeight: replaceDraft?.preBurstBodyMaxHeight ?? cur.bodyMaxHeight ?? null,
    preBurstMinBodyHeight: replaceDraft?.preBurstMinBodyHeight ?? cur.minBodyHeight ?? null,
    preBurstBodyHeightFloor:
      replaceDraft?.preBurstBodyHeightFloor
      ?? visibleBodyHeight
      ?? cur.bodyMaxHeight
      ?? cur.minBodyHeight
      ?? (cur.freeTextHeight != null ? cur.freeTextHeight + 11 : null),
    preBurstFreeTextHeight:
      replaceDraft?.preBurstFreeTextHeight ?? cur.freeTextHeight ?? null,
    preBurstHadBullets:
      replaceDraft?.preBurstHadBullets ?? /^[-*+]\s+/m.test(cur.body),
    preBurstWasAtMin: replaceDraft?.preBurstWasAtMin ?? wasAtMin,
  });
  store.setWorkingBody(nodeId, cur.body);
  trackGenerationVersions(generationSession);
}

/**
 * Abort every in-flight rewrite for the node AND synchronously remove
 * their records from the registry. Each rewrite's streaming loop sees
 * `signal.aborted === true` on its next tick and exits; its catch
 * path calls `finishRewrite` — which is idempotent: it bails out
 * early when the record is already gone, leaving the caller of
 * `abortAllActive` (the incoming whole rewrite) as the sole record
 * and therefore the sole commit owner.
 *
 * Without the synchronous remove, an aborted partial whose cleanup
 * fires AFTER the whole's `finishRewrite` would leave the whole's
 * remaining=[partial] check non-empty, the whole would defer commit,
 * the partial's late cleanup would see remaining=[] with outcome
 * 'aborted' (no commit) — and the whole's streamed content would be
 * silently discarded.
 */
function abortAllActive(nodeId: string): void {
  const store = useRewriteStore.getState();
  const records = store.activeByNode[nodeId] ?? [];
  for (const r of records) r.abortController.abort();
  for (const r of records) store.removeRecord(nodeId, r.id);
  partialCitationContexts.delete(nodeId);
}

function activeGenerationProjectId(): string | null {
  return useGraphStore.getState().activeProjectId
    ?? useGraphStore.getState().project?.id
    ?? null;
}

/** Stop every pass owned by a node before deleting its in-progress work.
 *  Aborts synchronously so a late provider chunk cannot race the version
 *  removal. Returns the stopped session kind, or null when the node has no
 *  tracked generation session. */
export function cancelNodeGeneration(
  nodeId: string,
  opts: { discardCurrentWork?: boolean } = {},
): 'spawn' | 'rewrite' | null {
  const projectId = activeGenerationProjectId();
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!projectId || !node) return null;
  const session = cancelGenerationSession(projectId, nodeId);
  if (!session) return null;

  abortAllActive(nodeId);
  useRewriteStore.getState().clearBurst(nodeId);
  useRewriteStore.getState().clearPendingSnapDown(nodeId);
  retryArgs.delete(nodeId);
  useNodeStatusStore.getState().clearStatus(nodeId);

  if (opts.discardCurrentWork && session.kind === 'rewrite') {
    const latest = useGraphStore.getState().project?.nodes[nodeId];
    if (!latest) return session.kind;
    const versions = [...latest.versions];
    // An automatic runtime repair works in place (source === draft). Cancelling
    // it must retain the last usable document rather than deleting that sole
    // version. Ordinary rewrites have a distinct provisional draft to remove.
    if (
      versions.length > 1
      && session.draftVersionIndex !== session.sourceVersionIndex
      && versions[session.draftVersionIndex]
    ) {
      versions.splice(session.draftVersionIndex, 1);
    }
    let currentVersionIndex = latest.currentVersionIndex;
    if (currentVersionIndex === session.draftVersionIndex) {
      currentVersionIndex = Math.max(0, Math.min(
        versions.length - 1,
        session.sourceVersionIndex ?? 0,
      ));
    } else if (currentVersionIndex > session.draftVersionIndex) {
      currentVersionIndex -= 1;
    }
    useGraphStore.getState().updateNode(nodeId, {
      versions,
      currentVersionIndex,
      generating: false,
      streamingText: false,
      generationError: undefined,
    });
  } else {
    setGenFlags(nodeId, {
      generating: false,
      streamingText: false,
      generationError: undefined,
    });
  }
  return session.kind;
}

/** Abort generation for a node and every auto-descendant before the graph
 *  store removes that subtree. */
export function cancelNodeGenerationCascade(rootNodeId: string): void {
  const project = useGraphStore.getState().project;
  if (!project) return;
  const ids = new Set<string>([rootNodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const arrow of Object.values(project.arrows)) {
      if (arrow.kind !== 'auto' || !ids.has(arrow.fromNodeId) || ids.has(arrow.toNodeId)) continue;
      ids.add(arrow.toNodeId);
      changed = true;
    }
  }
  for (const id of ids) cancelNodeGeneration(id);
}

function completeGenerationSession(nodeId: string): void {
  const projectId = activeGenerationProjectId();
  if (!projectId) return;
  const session = getGenerationSession(projectId, nodeId);
  if (session) finishGenerationSession(projectId, nodeId, session.id);
}

/** Persist model output into the already-created provisional row without
 *  creating undo entries. The rewrite store remains the live render source;
 *  this mirror makes version navigation/autosave truthful during generation. */
function mirrorRewriteDraft(nodeId: string, workingBody: string): void {
  const snapshot = useRewriteStore.getState().snapshot[nodeId];
  const node = useGraphStore.getState().project?.nodes[nodeId];
  const draft = snapshot ? node?.versions[snapshot.draftVersionIndex] : undefined;
  if (!snapshot || !node || !draft) return;
  const body = stripMarkers(workingBody);
  if (draft.body === body) return;
  const versions = [...node.versions];
  versions[snapshot.draftVersionIndex] = { ...draft, body };
  useGraphStore.temporal.getState().pause();
  try {
    useGraphStore.getState().updateNode(nodeId, { versions });
  } finally {
    useGraphStore.temporal.getState().resume();
  }
}

/** Whole actions supersede an unfinished draft, so their prompt must come from
 *  the version that was complete when the burst began—not its mirrored stream. */
function completedRewriteSource(node: ScatterNode): NodeVersion {
  const snapshot = useRewriteStore.getState().snapshot[node.id];
  return node.versions[snapshot?.preBurstVersionIndex ?? node.currentVersionIndex]
    ?? node.versions[node.currentVersionIndex]!;
}

/**
 * Generic deletion animator. Backspace-style — chars get sliced off
 * the end of `fullText` at a steady rate (total ~400 ms regardless of
 * length, 60 fps frame cadence). Each frame, the new shortened string
 * is handed to `writeBack`, which decides where to put it — into the
 * working body directly (whole rewrite) or between marker pairs
 * (partial rewrite).
 */
async function animateDeletionInto(
  fullText: string,
  writeBack: (currentText: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const TOTAL_MS = 400;
  const FRAME_MS = 1000 / 60;
  const frames = Math.max(1, Math.round(TOTAL_MS / FRAME_MS));
  const charsPerFrame = Math.max(1, Math.ceil(fullText.length / frames));
  let remaining = fullText;
  while (remaining.length > 0) {
    if (signal.aborted) return;
    remaining = remaining.slice(0, Math.max(0, remaining.length - charsPerFrame));
    writeBack(remaining);
    await sleep(FRAME_MS);
  }
}

type FinishOutcome = 'completed' | 'aborted' | 'errored';

type RewriteVersionMeta = {
  language?: NodeVersion['language'];
  googleSearchSuggestions?: string[];
  header: string;
  headerParts?: HeaderParts;
  generatedBy: NodeKind;
  maxL1Bullets?: number;
  contentType?: ContentType;
  /** Undefined inherits, a string stores/replaces, null explicitly clears. */
  selectedTextQuestion?: string | null;
  width?: number;
  /** Unrenumbered sources already represented by markers in the working body. */
  sources?: NodeSource[];
  internalSources?: InternalNodeSource[];
  sourceLimitation?: NodeVersion['sourceLimitation'];
  webSearched?: boolean;
  webSearchFailed?: boolean;
};

/**
 * Called at the end of every rewrite — successful, aborted, or
 * errored. Removes the rewrite's record from the registry, and:
 *
 *  - if other rewrites are still in flight → does nothing (the LAST
 *    to finish will commit);
 *  - if this WAS the last rewrite AND it completed → commits a new
 *    version on the node with the marker-stripped working body, sets
 *    the snap-down flag if the burst started at min size, clears the
 *    burst.
 *  - if this WAS the last rewrite but it didn't complete → just
 *    turns off the generating flag and clears the burst (which
 *    restores the displayed body to the pre-burst version since
 *    `workingBody[nodeId]` becomes undefined and `getDisplayBody`
 *    falls back to the version body).
 */
function finishRewrite(
  nodeId: string,
  rewriteId: string,
  outcome: FinishOutcome,
  newVersionMeta: RewriteVersionMeta,
  opts?: { deferGeneratingOff?: boolean },
): { committed: boolean; versionIndex: number } | null {
  // Idempotent: if this rewrite's record has already been removed
  // (e.g., a whole rewrite synchronously removed it via
  // `abortAllActive`), bail out. The whole that removed us is now the
  // sole commit owner — we must not touch generating/burst state.
  const activeBefore = useRewriteStore.getState().activeByNode[nodeId] ?? [];
  if (!activeBefore.some((r) => r.id === rewriteId)) return null;

  useRewriteStore.getState().removeRecord(nodeId, rewriteId);

  // CRITICAL: re-read state AFTER removeRecord with a FRESH getState().
  // Zustand replaces the state object on every set(), so a reference
  // captured BEFORE the mutation is stale and would STILL contain the
  // record we just removed — making this check spuriously believe a
  // rewrite is still running and skip the commit entirely. That was the
  // bug that left every rewrite hanging: no version committed,
  // `generating` never reset, cursor never cleared.
  const remaining = useRewriteStore.getState().activeByNode[nodeId] ?? [];
  if (remaining.length > 0) {
    // Other rewrites still in flight — the LAST to finish commits.
    return null;
  }

  const snapshot = useRewriteStore.getState().snapshot[nodeId];

  if (outcome === 'completed' && snapshot) {
    const workingBody = useRewriteStore.getState().workingBody[nodeId] ?? '';
    const node = useGraphStore.getState().project!.nodes[nodeId]!;
    // Navigation can change currentVersionIndex while the model is running.
    // Clone layout/model metadata from the version that began the burst, not
    // whichever historical version the user happens to be viewing at commit.
    const current = node.versions[snapshot.preBurstVersionIndex]
      ?? node.versions[node.currentVersionIndex]!;
    // Text rewrites inherit the current version's complete layout/model
    // metadata. Only the generated content identity and source set are
    // replaced. This prevents a newly-appended version from briefly snapping
    // back to default dimensions before its final measurements settle.
    const {
      media: _media,
      factCheck: _factCheck,
      imageRecommendations: _imageRecommendations,
      wikimediaImages: _wikimediaImages,
      ...currentTextMeta
    } = current;
    const newVersion: NodeVersion = {
      ...currentTextMeta,
      language: newVersionMeta.language ?? versionLanguage(current),
      answerEnrichmentId: undefined,
      header: newVersionMeta.header,
      headerParts: newVersionMeta.headerParts ?? current.headerParts,
      body: stripMarkers(workingBody),
      createdAt: node.versions[snapshot.draftVersionIndex]?.createdAt ?? Date.now(),
      generatedBy: newVersionMeta.generatedBy,
      maxL1Bullets: newVersionMeta.maxL1Bullets,
      contentType: newVersionMeta.contentType,
      chat: newVersionMeta.contentType === 'answer' && current.chat
        ? { ...current.chat, title: newVersionMeta.header, state: 'complete' } : undefined,
      selectedTextQuestion: newVersionMeta.selectedTextQuestion === null
        ? undefined
        : newVersionMeta.selectedTextQuestion ?? current.selectedTextQuestion,
      width: newVersionMeta.width ?? current.width,
      sources: newVersionMeta.sources,
      googleSearchSuggestions: newVersionMeta.googleSearchSuggestions,
      internalSources: newVersionMeta.internalSources,
      sourceLimitation: newVersionMeta.sourceLimitation,
      webSearched: newVersionMeta.webSearched,
      webSearchFailed: newVersionMeta.webSearchFailed,
    };
    const versions = [...node.versions];
    if (!versions[snapshot.draftVersionIndex]) {
      setGenFlags(nodeId, { generating: false });
      useNodeStatusStore.getState().clearStatus(nodeId);
      useRewriteStore.getState().clearBurst(nodeId);
      return { committed: false, versionIndex: -1 };
    }
    versions[snapshot.draftVersionIndex] = newVersion;
    useGraphStore.temporal.getState().pause();
    try {
      useGraphStore.getState().updateNode(nodeId, {
        versions,
        // Keep pulsing across a following chip pass when the caller asks; the
        // caller clears `generating` when the chip pass finishes.
        ...(opts?.deferGeneratingOff ? {} : { generating: false }),
      });
    } finally {
      useGraphStore.temporal.getState().resume();
    }
    // Part F — when generation ends here (no chip pass follows), wipe the
    // status. When deferred, the following chip pass owns the clear.
    if (!opts?.deferGeneratingOff) useNodeStatusStore.getState().clearStatus(nodeId);
    if (snapshot.preBurstWasAtMin && snapshot.preBurstMinBodyHeight != null) {
      useRewriteStore.getState().setPendingSnapDown(nodeId, {
        preBurstMinBodyHeight: snapshot.preBurstMinBodyHeight,
      });
    }
    useRewriteStore.getState().clearBurst(nodeId);
    return { committed: true, versionIndex: snapshot.draftVersionIndex };
  } else {
    // A provider error keeps any model text that arrived in the provisional
    // version. The deletion animation alone never counts as model output, so a
    // zero-text failure leaves the cloned source body intact.
    if (outcome === 'errored' && snapshot) {
      const projectId = activeGenerationProjectId();
      const session = projectId ? getGenerationSession(projectId, nodeId) : undefined;
      if (session?.modelTextReceived) {
        const node = useGraphStore.getState().project?.nodes[nodeId];
        const draft = node?.versions[snapshot.draftVersionIndex];
        if (node && draft) {
          const versions = [...node.versions];
          versions[snapshot.draftVersionIndex] = {
            ...draft,
            header: newVersionMeta.header,
            headerParts: newVersionMeta.headerParts ?? draft.headerParts,
            body: stripMarkers(useRewriteStore.getState().workingBody[nodeId] ?? ''),
            generatedBy: newVersionMeta.generatedBy,
            maxL1Bullets: newVersionMeta.maxL1Bullets,
            contentType: newVersionMeta.contentType,
            width: newVersionMeta.width ?? draft.width,
          };
          useGraphStore.temporal.getState().pause();
          try {
            useGraphStore.getState().updateNode(nodeId, { versions });
          } finally {
            useGraphStore.temporal.getState().resume();
          }
        }
      }
    }
    setGenFlags(nodeId, { generating: false });
    useNodeStatusStore.getState().clearStatus(nodeId);
    completeGenerationSession(nodeId);
  }

  useRewriteStore.getState().clearBurst(nodeId);
  return { committed: false, versionIndex: -1 };
}

/** Place NEW web-search citation markers from a rewrite pass into the working
 *  body by exact offset, numbered AFTER any old markers the model preserved (no
 *  collision), skipping a re-cited existing source (same URL). The chip pass
 *  then preserves all ⟦n⟧ tokens; `finalizeRewriteCitations` renumbers after. */
function placeRewriteCitations(
  nodeId: string,
  oldSources: NodeSource[],
  streamRes: {
    googleSearchSuggestions?: string[];
    citations: Citation[];
    rawText: string;
    sourcePassages: RetrievedSourcePassage[];
    webSearchRequested: boolean;
    webSearchUsed: boolean;
    webSearchError?: string;
  },
): RewriteCitationCtx {
  // Provider offsets refer to rawText. Internal SOURCE_n tokens are longer
  // than their visible `(n)` counterparts, so placing web markers into the
  // already-normalized working body shifts every later offset. Place web
  // citations first, then normalize the internal catalog in one direction.
  const present = new Set([...streamRes.rawText.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])));
  const survivingOld = oldSources.filter((s) => present.has(s.n));
  const survivingUrls = new Set(survivingOld.map((s) => s.url));
  const maxN = survivingOld.reduce((m, s) => Math.max(m, s.n), 0);
  const newCites = streamRes.citations.filter((c) => c.url && !survivingUrls.has(c.url));
  const newSources = buildSources(newCites).map((s) => ({ ...s, n: s.n + maxN }));
  const citedRaw = newSources.length
    ? placeCitationMarkersReliable(streamRes.rawText, newCites, newSources)
    : streamRes.rawText;
  useRewriteStore.getState().setWorkingBody(
    nodeId,
    normalizeInternalCitationTokens(citedRaw, streamRes.sourcePassages).body,
  );
  return {
    oldSources: survivingOld, newSources,
    googleSearchSuggestions: streamRes.googleSearchSuggestions,
    internalSources: [],
    webSearchRequested: streamRes.webSearchRequested,
    webSearchUsed: streamRes.webSearchUsed,
    webSearchError: streamRes.webSearchError,
  };
}

/** After a rewrite's chip pass: renumber all ⟦n⟧ markers 1..k (reading order),
 *  attach the combined surviving-old + new sources, and set the web-searched
 *  flag onto the just-committed version (finishRewrite drops `sources`). */
function finalizeRewriteCitations(nodeId: string, versionIndex: number, ctx: RewriteCitationCtx): void {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node) return;
  const projectId = activeGenerationProjectId();
  versionIndex = (projectId ? getGenerationSession(projectId, nodeId)?.draftVersionIndex : undefined) ?? versionIndex;
  const cur = node.versions[versionIndex];
  if (!cur) return;
  let body = cur.body;
  const availableInternal = new Map(ctx.internalSources.map((source) => [source.n, source]));
  const internalNumberMap = new Map<number, number>();
  const internalSources: InternalNodeSource[] = [];
  body = body.replace(/\((\d+)\)/g, (token, digits: string) => {
    const oldN = Number(digits);
    const source = availableInternal.get(oldN);
    if (!source) return token;
    let n = internalNumberMap.get(oldN);
    if (!n) {
      n = internalSources.length + 1;
      internalNumberMap.set(oldN, n);
      internalSources.push({ ...source, n });
    }
    return `(${n})`;
  });
  const present = new Set([...body.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])));
  const combined = [...ctx.oldSources, ...ctx.newSources].filter((s) => present.has(s.n));
  const renumbered = renumberCitations(body, combined, internalSources.length + 1);
  const versions = [...node.versions];
  versions[versionIndex] = {
    ...cur,
    body: renumbered.body,
    sources: renumbered.sources.length ? renumbered.sources : undefined,
    googleSearchSuggestions: ctx.googleSearchSuggestions,
    internalSources: internalSources.length ? internalSources : undefined,
    sourceLimitation: ctx.limitedSourceSearchReason ? {
      kind: 'limited-search',
      message: 'Limited source search',
      reason: ctx.limitedSourceSearchReason,
    } : undefined,
    webSearched: ctx.webSearchUsed ? true : undefined,
    webSearchFailed: ctx.webSearchRequested && !ctx.webSearchUsed ? true : undefined,
  };
  useGraphStore.temporal.getState().pause();
  try {
    useGraphStore.getState().updateNode(nodeId, { versions });
  } finally {
    useGraphStore.temporal.getState().resume();
  }
}

/**
 * Run a whole-body rewrite end to end.
 *
 *   1. Cancel every in-flight rewrite on this node — both partials
 *      (different sections) and any other whole. The cancelled
 *      rewrites' streaming loops exit on their next tick.
 *   2. Begin (or reuse) the burst snapshot.
 *   3. Reset working body to the pre-burst body so the visible card
 *      shows the version-equivalent state going into the deletion
 *      animation.
 *   4. Animate-delete the entire working body (~400ms backspace).
 *   5. Stream the new content into the working body — each chunk
 *      REPLACES the working body in full (it's the entire new body).
 *   6. Commit or clean up via `finishRewrite`.
 */
async function runWholeRewrite(opts: {
  nodeId: string;
  variant: TaskVariant;
  parentIdForContext: string | null;
  newVersionMeta: RewriteVersionMeta;
  maxOutputTokens?: number;
  /** Encyclopedic level-1 bullet cap for THIS generation's `base` prompt. */
  maxLevel1?: number;
  /** Run pass-2 chip marking on the committed body (default true). Callers that
   *  need a corrective restructure FIRST (regenerate) pass false and run the
   *  chip pass themselves afterward, so chips land on the final structure. */
  runChips?: boolean;
  /** Part F — aura status label for the pass-1 phase (e.g. EXPANDING WHOLE).
   *  Defaults to statusVerb(variant.kind). */
  statusLabel?: string;
  /** Explicit search override. Evidence-guided rewrites must not search again. */
  webSearch?: boolean;
  /** Prevalidated evidence sources cited through ⟪E1⟫ tokens in model output. */
  evidenceSources?: NodeSource[];
  evidenceGoogleSearchSuggestions?: string[];
}): Promise<CommittedRewriteCitationCtx | null> {
  const { nodeId, variant, parentIdForContext, newVersionMeta, maxOutputTokens } = opts;
  const runChips = opts.runChips ?? true;
  const statusLabel = opts.statusLabel ?? statusVerb(variant.kind);

  // Old sources from the pre-rewrite version — carried over for markers the model
  // preserves on unchanged text (read before finishRewrite appends a new version).
  const startNode = useGraphStore.getState().project?.nodes[nodeId];
  const supersededDraft = useRewriteStore.getState().snapshot[nodeId];
  const sourceIndex = supersededDraft?.preBurstVersionIndex ?? startNode?.currentVersionIndex;
  const oldSources: NodeSource[] = opts.evidenceSources
    ? []
    : sourceIndex == null
    ? []
    : startNode?.versions[sourceIndex]?.sources ?? [];
  const oldInternalSources: InternalNodeSource[] = sourceIndex == null
    ? []
    : startNode?.versions[sourceIndex]?.internalSources ?? [];

  abortAllActive(nodeId);
  beginBurst(nodeId, { replaceDraft: supersededDraft, draftMeta: newVersionMeta });

  const store = useRewriteStore.getState();
  const snapshot = store.snapshot[nodeId]!;
  // Reset the working body to the pre-burst state. Any partials that
  // had been mid-stream had their markers in workingBody; resetting
  // wipes those out (and any half-written text).
  store.setWorkingBody(nodeId, snapshot.preBurstBody);

  const rewriteId = nextMarkerId();
  const controller = new AbortController();
  registerGenerationController(snapshot.generationSessionId, controller);
  store.addRecord({
    id: rewriteId, nodeId, kind: 'whole', abortController: controller,
  });

  // Part F — set generating + status from the click, BEFORE the backspace
  // animation empties the body. Otherwise the body clears for ~400 ms (plus
  // the first-token wait) with no status — the "disappeared too soon, then
  // nothing" gap. streamChunks re-sets the same label below (deduped no-op).
  // streamingText also covers the backspace-chew: the tail skeleton shows
  // from the first frame of the rewrite until the new text is fully streamed.
  setGenFlags(nodeId, { generating: true, streamingText: true, generationError: undefined });
  setNodeStatus(nodeId, statusLabel);

  try {
    // Backspace-chew the whole body.
    await animateDeletionInto(
      snapshot.preBurstBody,
      (remaining) => useRewriteStore.getState().setWorkingBody(nodeId, remaining),
      controller.signal,
    );
    if (controller.signal.aborted) {
      setGenFlags(nodeId, { streamingText: false });
      finishRewrite(nodeId, rewriteId, 'aborted', newVersionMeta);
      return null;
    }
    // Then stream the new content in.
    const streamRes = await streamChunks({
      nodeId, variant, parentIdForContext,
      imageContext: sourceIndex == null ? undefined : startNode?.versions[sourceIndex]?.imageContext,
      signal: controller.signal,
      onAcc: (sanitizedAcc) => {
        if (sanitizedAcc.trim()) markGenerationTextReceived(snapshot.generationSessionId);
        useRewriteStore.getState().setWorkingBody(nodeId, sanitizedAcc);
        mirrorRewriteDraft(nodeId, sanitizedAcc);
      },
      maxOutputTokens,
      webSearch: opts.webSearch,
      statusLabel,
      maxLevel1: opts.maxLevel1,
      commitGate: variant.kind === 'answer' ? undefined : makeBulletCommitGate(),
    });
    // New text fully streamed — skeleton + reserve off (chips may follow, but
    // no further bullets are coming).
    setGenFlags(nodeId, { streamingText: false });
    if (controller.signal.aborted) {
      finishRewrite(nodeId, rewriteId, 'aborted', newVersionMeta);
      return null;
    }
    if (streamRes.sourceOnlyInsufficient) {
      store.setWorkingBody(nodeId, '');
      const result = finishRewrite(nodeId, rewriteId, 'completed', {
        ...newVersionMeta,
        sources: undefined,
        internalSources: undefined,
        sourceLimitation: {
          kind: 'not-enough-information',
          message: 'Sources only: Not enough information in active sources.',
          action: 'whole',
        },
      });
      completeGenerationSession(nodeId);
      return result?.committed ? {
        oldSources: [], newSources: [], internalSources: [],
        webSearchRequested: false, webSearchUsed: false,
        versionIndex: result.versionIndex,
      } : null;
    }
    const completionError = generationCompletionError(
      streamRes.rawText,
      streamRes.finishReason,
      streamRes.citations,
    );
    if (completionError) {
      // The errored provisional version may be retained for retry, but it must
      // never retain a half URL or half sentence from the provider.
      store.setWorkingBody(nodeId, snapshot.preBurstBody);
      mirrorRewriteDraft(nodeId, snapshot.preBurstBody);
      throw new Error(completionError);
    }
    let providerBody = streamRes.rawText;
    let normalizedInternal = {
      body: streamRes.normalizedText,
      sources: streamRes.internalSources,
    };
    if (
      streamRes.sourceMode === 'only'
      && providerBody.trim()
      && !hasStrictSourceCoverage(providerBody, streamRes.sourcePassages)
    ) {
      providerBody = await repairStrictSourceCitations({
        nodeId,
        body: providerBody,
        passages: streamRes.sourcePassages,
        signal: controller.signal,
        onAcc: (body) => {
          store.setWorkingBody(nodeId, body);
          mirrorRewriteDraft(nodeId, body);
        },
      });
      if (!hasStrictSourceCoverage(providerBody, streamRes.sourcePassages)) {
        throw new Error('Sources only could not trace every factual passage to the active sources. The untraceable answer was not saved.');
      }
      normalizedInternal = normalizeInternalCitationTokens(providerBody, streamRes.sourcePassages);
    }
    // Source-backed rewrites receive a fresh validated evidence catalog. When
    // sources are ignored, preserve only old internal markers that survived.
    const survivingInternal = streamRes.sourceMode === 'ignore'
      ? pruneInternalSources(normalizedInternal.body, oldInternalSources)
      : normalizedInternal.sources;
    store.setWorkingBody(nodeId, normalizedInternal.body);
    // Web-search citations: place NEW markers by exact offset into the working
    // body NOW (pre-commit, pre-chip) so the offsets are valid; the model already
    // preserved old markers on unchanged text.
    let citationCtx: RewriteCitationCtx;
    if (opts.evidenceSources) {
      const used = new Set<number>();
      const rewritten = (useRewriteStore.getState().workingBody[nodeId] ?? '')
        .replace(/⟪E(\d+)⟫/g, (_match, rawN: string) => {
          const n = Number(rawN);
          if (!opts.evidenceSources!.some((source) => source.n === n)) return '';
          used.add(n);
          return `⟦${n}⟧`;
        })
        // Never carry unsupported markers copied from the old body.
        .replace(/⟦(\d+)⟧/g, (match, rawN: string) =>
          used.has(Number(rawN)) ? match : '');
      useRewriteStore.getState().setWorkingBody(nodeId, rewritten);
      citationCtx = {
        oldSources: [],
        newSources: opts.evidenceSources.filter((source) => used.has(source.n)),
        googleSearchSuggestions: opts.evidenceGoogleSearchSuggestions,
        internalSources: [],
        webSearchRequested: false,
        webSearchUsed: false,
      };
    } else {
      citationCtx = placeRewriteCitations(nodeId, oldSources, {
        ...streamRes,
        rawText: providerBody,
      });
      citationCtx.internalSources = survivingInternal;
      citationCtx.limitedSourceSearchReason = streamRes.limitedSourceSearchReason;
      citationCtx.googleSearchSuggestions = mergeGoogleSearchSuggestions(
        citationCtx.oldSources.length && sourceIndex != null ? startNode?.versions[sourceIndex]?.googleSearchSuggestions : undefined,
        citationCtx.googleSearchSuggestions,
      );
    }
    const citedBody = useRewriteStore.getState().workingBody[nodeId] ?? '';
    const presentCitationNumbers = new Set(
      [...citedBody.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])),
    );
    const committedSources = [...citationCtx.oldSources, ...citationCtx.newSources]
      .filter((s) => presentCitationNumbers.has(s.n));
    // Commit the plain body. When chips follow, keep `generating` true so the
    // header keeps pulsing straight into the chip pass (no flicker).
    const res = finishRewrite(nodeId, rewriteId, 'completed', {
      ...newVersionMeta,
      sources: committedSources.length ? committedSources : undefined,
      googleSearchSuggestions: citationCtx.googleSearchSuggestions,
      internalSources: citationCtx.internalSources.length ? citationCtx.internalSources : undefined,
      sourceLimitation: citationCtx.limitedSourceSearchReason ? {
        kind: 'limited-search', message: 'Limited source search', reason: citationCtx.limitedSourceSearchReason,
      } : undefined,
      webSearched: citationCtx.webSearchUsed ? true : undefined,
      webSearchFailed: citationCtx.webSearchRequested && !citationCtx.webSearchUsed ? true : undefined,
    }, {
      deferGeneratingOff: runChips,
    });
    if (!res?.committed) return null;
    // Callers that pass runChips:false run their own restructure + chip pass, then
    // call finalizeRewriteCitations themselves (after chips). When we own the chip
    // pass, finalize here.
    if (runChips) {
      await addChipsToCurrentVersion(nodeId, res.versionIndex);
      finalizeRewriteCitations(nodeId, res.versionIndex, citationCtx);
      completeGenerationSession(nodeId);
    }
    return { ...citationCtx, versionIndex: res.versionIndex };
  } catch (e) {
    setGenFlags(nodeId, { streamingText: false }); // never strand the skeleton
    const outcome: FinishOutcome = controller.signal.aborted ? 'aborted' : 'errored';
    if (outcome === 'errored') {
      setGenFlags(nodeId, {
        generationError: friendlyErrorMessage(e),
      });
    }
    finishRewrite(nodeId, rewriteId, outcome, newVersionMeta);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────
// Public API: spawn paths
// ───────────────────────────────────────────────────────────────────

export async function generateRoot(
  topic: string,
  options: { skipPendingSources?: boolean } = {},
): Promise<string> {
  console.log('[scatter] generateRoot: topic=%s', topic);
  try {
    const id = newId();
    const INIT_ZOOM = 0.75;
    const CONFIG_BAR_H = 60;
    const winW = typeof window !== 'undefined' ? window.innerWidth : 800;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 600;
    const canvasH = winH - CONFIG_BAR_H;
    const headerScreenY = CONFIG_BAR_H + canvasH * 0.25;
    const centerScreenX = winW / 2;
    const cx = centerScreenX / INIT_ZOOM - ROOT_NODE_W / 2;
    const cy = headerScreenY / INIT_ZOOM;
    const node: ScatterNode = {
      id, type: 'root',
      position: { x: cx, y: cy }, frozen: true,
      // Width is per-version now; the root reads first so it's a touch wider.
      versions: [{ header: topic, headerParts: { subject: normalizeHeaderText(topic) }, body: '', createdAt: Date.now(), generatedBy: 'root', contentType: 'encyclopedic', width: ROOT_NODE_W }],
      currentVersionIndex: 0,
    };
    useGraphStore.getState().addNode(node);
    if (useGraphStore.getState().project) {
      useGraphStore.getState().setProject({ ...useGraphStore.getState().project!, rootNodeId: id });
    }
    useGraphStore.getState().setViewport({ x: 0, y: 0, zoom: INIT_ZOOM });
    // Name the project after the topic the user typed (no AI auto-naming).
    void nameActiveScatterFromTopic(topic);
    const generation = streamIntoVersion(id, {
      kind: 'root',
      topic,
      skipPendingSources: options.skipPendingSources,
    }, null);
    useGraphStore.getState().requestPanTo(id, undefined, 'rootGeneration');
    await generation;
    return id;
  } catch (e) {
    console.error('[scatter] generateRoot failed:', e);
    throw e;
  }
}

export async function spawnTermClick(
  parentId: string,
  term: string,
  opts?: { bulletsCollapsed?: boolean; sourceSelection?: NodeTextSelection; sourceAnswer?: ChatAnswerRef },
): Promise<string> {
  console.log('[scatter] spawnTermClick: parent=%s term=%s opts=%o', parentId, term, opts);
  try {
    const id = newId();
    const proj = useGraphStore.getState().project!;
    const parent = proj.nodes[parentId]!;
    const sourceSelection = sourceSelectionForParent(parent, opts?.sourceSelection);
    const newNode: ScatterNode = {
      id, type: 'term-click',
      position: spawnNearParent(parent, Object.values(proj.nodes)),
      frozen: false,
      // Inherit group membership from parent on spawn (B.5). A later
      // move of the parent out of the group leaves existing children
      // alone — inheritance is a one-time snapshot at creation, matching
      // user expectation that the spawn carries forward the parent's
      // current group identity but isn't a live link.
      groupId: parent.groupId,
      versions: [{ header: term, headerParts: { subject: normalizeHeaderText(term) }, body: '', createdAt: Date.now(), generatedBy: 'term-click', contentType: 'encyclopedic' }],
      currentVersionIndex: 0,
      bulletsCollapsed: opts?.bulletsCollapsed ? true : undefined,
    };
    // One undo entry for the whole spawn (node + arrow together).
    useGraphStore.getState().addNodeWithArrow(
      newNode,
      {
        id: newId(),
        fromNodeId: parentId,
        toNodeId: id,
        kind: 'auto',
        sourceAnswer: opts?.sourceAnswer ?? chatSelectionOrigin(parent, opts?.sourceSelection),
        ...(sourceSelection ? { sourceSelection } : { label: term }),
      },
    );
    useGraphStore.getState().requestPanTo(id, parentId, 'newNodes');
    await streamIntoVersion(id, { kind: 'term-click', term }, parentId);
    return id;
  } catch (e) {
    console.error('[scatter] spawnTermClick failed:', e);
    throw e;
  }
}

const normalizeHeaderText = (value: string): string => value.trim().replace(/\s+/g, ' ');

const SELECTED_QUESTION_EXCERPT_MIN = 96;
const SELECTED_QUESTION_HEADER_TARGET = 128;
const SELECTED_QUESTION_SEPARATOR = ': ';

function selectedQuestionExcerpt(value: string, maxLength: number): string {
  const normalized = normalizeHeaderText(value);
  if (normalized.length <= maxLength) return normalized;

  const available = maxLength - 1;
  const prefix = normalized.slice(0, available);
  const boundary = prefix.lastIndexOf(' ');
  const retained = boundary > 0 ? prefix.slice(0, boundary) : prefix;
  return `${retained.trimEnd()}…`;
}

export function selectedQuestionHeader(
  selectionText: string,
  question: string,
  opts?: { explain?: boolean },
): string {
  const normalizedQuestion = normalizeHeaderText(question);
  const suffixLength = opts?.explain ? formatExplainHeader('').length : 0;
  const excerptMax = Math.max(
    SELECTED_QUESTION_EXCERPT_MIN,
    SELECTED_QUESTION_HEADER_TARGET
      - SELECTED_QUESTION_SEPARATOR.length
      - normalizedQuestion.length
      - suffixLength,
  );
  return `${selectedQuestionExcerpt(selectionText, excerptMax)}${SELECTED_QUESTION_SEPARATOR}${normalizedQuestion}`;
}

interface SelectedQuestionContext {
  selectedText: string;
  question: string;
}

/** Recover old compact-question nodes without mistaking a manual title for
 * prompt context. A candidate is accepted only when rebuilding Scatter's
 * automatic header produces an exact match, and exactly one split matches. */
function recoverLegacySelectedTextQuestion(
  version: NodeVersion,
  selectedText: string,
  explain: boolean,
): string | null {
  if (version.generatedBy !== 'follow-up' && version.generatedBy !== 'explain') return null;
  const plainHeader = stripExplainHeaderSuffix(version.header);
  const matches: string[] = [];
  let delimiter = plainHeader.indexOf(SELECTED_QUESTION_SEPARATOR);
  while (delimiter >= 0) {
    const question = plainHeader.slice(delimiter + SELECTED_QUESTION_SEPARATOR.length).trim();
    if (
      question
      && selectedQuestionHeader(selectedText, question, { explain }) === plainHeader
    ) matches.push(question);
    delimiter = plainHeader.indexOf(SELECTED_QUESTION_SEPARATOR, delimiter + 1);
  }
  return matches.length === 1 ? matches[0]! : null;
}

function selectedQuestionContext(
  version: NodeVersion,
  incoming: Arrow | undefined,
  explain: boolean,
): SelectedQuestionContext | null {
  if (version.headerParts?.question?.trim() && version.headerParts.subject.trim()) {
    return {
      selectedText: normalizeHeaderText(version.headerParts.subject),
      question: normalizeHeaderText(version.headerParts.question),
    };
  }
  const selectedText = incoming?.sourceSelection?.text;
  if (!selectedText) return null;
  const storedQuestion = version.selectedTextQuestion?.trim();
  if (storedQuestion) return { selectedText, question: storedQuestion };
  const recoveredQuestion = recoverLegacySelectedTextQuestion(version, selectedText, explain);
  return recoveredQuestion ? { selectedText, question: recoveredQuestion } : null;
}

function selectedQuestionExplainTerm(context: SelectedQuestionContext): string {
  return `Selected passage: ${context.selectedText}\n\nQuestion: ${context.question}`;
}

function sourceSelectionForParent(
  parent: ScatterNode,
  selection: NodeTextSelection | undefined,
) {
  if (!selection || selection.nodeId !== parent.id) return undefined;
  const version = parent.versions[selection.versionIndex];
  if (!version || version.body !== selection.sourceBody) return undefined;
  return createArrowSourceSelection(selection, version.createdAt) ?? undefined;
}

function chatSelectionOrigin(parent: ScatterNode, selection?: NodeTextSelection): ChatAnswerRef | undefined {
  if (!parent.chat) return undefined;
  const version = parent.versions[selection?.versionIndex ?? parent.currentVersionIndex];
  return version?.chat ? { turnId: version.chat.turnId, versionCreatedAt: version.createdAt } : undefined;
}

/** Fill an explicitly created blank card in place; no routing or extra child. */
export async function generateEmptyTextNode(nodeId: string, prompt: string): Promise<void> {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  const current = node?.versions[node.currentVersionIndex];
  const question = prompt.trim();
  if (!node || !current?.emptyText || current.body.trim() || node.generating || !question) return;
  const settings = useSettingsStore.getState();
  if (!getActiveProvider(settings)?.apiKey || !settings.activeModelRef?.model) {
    setGenFlags(nodeId, { generationError: 'Choose a main model in Settings before generating.' });
    return;
  }
  const explain = currentContentType(node) === 'explain';
  const projectId = graph.project!.id;
  const createdAt = nextTextVersionTimestamp(node);
  const incoming = Object.values(graph.project!.arrows).find(arrow => arrow.kind === 'auto' && arrow.toNodeId === nodeId);
  const parentId = incoming?.fromNodeId ?? null;
  // Recover blanks created before selected image context was saved on versions.
  const imageContext = current.imageContext ?? incoming?.sourceImage;
  const headerParts: HeaderParts = { subject: question, ...(explain ? { suffix: 'explained' } : {}) };
  graph.updateNode(nodeId, { generationError: undefined, versions: node.versions.map((version, index) =>
    index === node.currentVersionIndex ? { ...version, emptyText: false, initialTextFrame: true, createdAt,
      ...(imageContext ? { imageContext: structuredClone(imageContext) } : {}),
      language: normalizeLanguage(settings.generationLanguage),
      header: flattenHeaderParts(headerParts), headerParts, generatedBy: explain ? 'explain' : 'follow-up' } : version) });
  await streamIntoVersion(nodeId, explain ? { kind: 'explain', term: question } : { kind: 'follow-up', question }, parentId,
    node.currentVersionIndex, createdAt);
  const completed = getGenProject(projectId)?.nodes[nodeId];
  if (completed?.versions[completed.currentVersionIndex]?.emptyText) useNodeStatusStore.getState().clearStatus(nodeId);
  if (completed) updateGenNode(projectId, nodeId, { versions: completed.versions.map(version => version.createdAt === createdAt
    ? { ...version, initialTextFrame: undefined, ...(version.body.trim() ? {} : { emptyText: true }) } : version) });
}

export async function spawnFollowUp(
  parentId: string,
  question: string,
  selectedText?: NodeTextSelection,
  imageContext?: ImageQuestionContext,
  onSpawn?: () => void,
): Promise<string> {
  console.log('[scatter] spawnFollowUp: parent=%s question=%s', parentId, question);
  const language = normalizeLanguage(useSettingsStore.getState().generationLanguage);
  try {
    const originProjectId = useGraphStore.getState().project?.id;
    // Route topic overviews, focused explanations, and conversational tasks.
    // Keep the user's question unchanged; selected context travels separately.
    setNodeStatus(parentId, 'ROUTING', 'routing');
    let intent: 'explore' | 'explain' | 'chat';
    try {
      const routingQuestion = selectedText
        ? `The user selected this exact passage:\n\n${selectedText.text}\n\nTheir question is: ${question}`
        : imageContext ? `The user selected a region of the parent image. Their question is: ${question}` : question;
      intent = await classifyFollowUpIntent(parentId, routingQuestion, question);
    } finally {
      useNodeStatusStore.getState().clearProcessStatus(parentId, 'routing');
    }
    if (!originProjectId || useGraphStore.getState().project?.id !== originProjectId
      || !useGraphStore.getState().project?.nodes[parentId]) {
      throw new Error('The source project changed before the follow-up could start.');
    }
    if (intent === 'chat') {
      const { startFollowUpChat } = await import('./chat/actions');
      // Importing is asynchronous too: never insert into a newly opened project.
      if (useGraphStore.getState().project?.id !== originProjectId) throw new Error('The source project changed before the follow-up could start.');
      return startFollowUpChat(parentId, question, { selectedText, imageContext, onSpawn, language });
    }
    const selectedHeader = selectedText
      ? selectedQuestionHeader(selectedText.text, question, { explain: intent !== 'explore' })
      : question;
    if (intent === 'explain') {
      return await spawnExplain(parentId, question, selectedText
        ? {
            language,
            promptTerm: `Selected passage: ${selectedText.text}\n\nQuestion: ${question}`,
            headerLabel: selectedHeader,
            sourceSelection: selectedText,
            selectedTextQuestion: normalizeHeaderText(question),
          }
        : { imageContext, onSpawn, language });
    }

    const id = newId();
    const proj = useGraphStore.getState().project!;
    const parent = proj.nodes[parentId]!;
    const sourceSelection = sourceSelectionForParent(parent, selectedText);
    const followupHeaderParts: HeaderParts = selectedText
      ? { subject: normalizeHeaderText(selectedText.text), question: normalizeHeaderText(question) }
      : { subject: normalizeHeaderText(question) };
    const newNode: ScatterNode = {
      id, type: 'follow-up',
      ...(imageContext?.regions.length ? { generating: true } : {}),
      position: spawnNearParent(parent, Object.values(proj.nodes), undefined, undefined, imageContext?.regions),
      frozen: false,
      // Inherit group membership from parent on spawn (B.5).
      groupId: parent.groupId,
      versions: [{
        header: flattenHeaderParts(followupHeaderParts),
        language,
        headerParts: followupHeaderParts,
        body: '',
        createdAt: Date.now(),
        generatedBy: 'follow-up',
        contentType: 'encyclopedic',
        ...(imageContext ? { imageContext } : {}),
        ...(imageContext?.regions.length ? { imageQuestion: question, imageTitleState: 'pending' as const } : {}),
        ...(selectedText ? { selectedTextQuestion: normalizeHeaderText(question) } : {}),
      }],
      currentVersionIndex: 0,
    };
    // One undo entry for the whole spawn (node + arrow together).
    useGraphStore.getState().addNodeWithArrow(
      newNode,
      {
        id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto',
        sourceAnswer: chatSelectionOrigin(parent, selectedText),
        ...(imageContext?.regions.length ? { sourceImage: structuredClone(imageContext) } : {}),
        ...(sourceSelection ? { sourceSelection } : {}),
      },
    );
    useGraphStore.getState().requestPanTo(id, parentId, 'newNodes');
    onSpawn?.();
    await streamIntoVersion(id, {
      kind: 'follow-up', question, selectedText: selectedText?.text,
    }, parentId);
    return id;
  } catch (e) {
    console.error('[scatter] spawnFollowUp failed:', e);
    throw e;
  }
}

/** "Explain" selection action: spawn an ELI5 child for an arbitrary selected
 *  string. Mirrors spawnFollowUp (arbitrary text, arrow has NO label so it
 *  isn't tracked as an "explored term"), but routes through the `explain`
 *  variant — plain free-text prose (no bullets). Pass 2 still marks clickable
 *  terms, so an explanation can be rabbit-holed from just like an encyclopedia node. */
export async function spawnExplain(parentId: string, text: string, opts?: {
  language?: NodeVersion['language'];
  promptTerm?: string;
  headerLabel?: string;
  sourceSelection?: NodeTextSelection;
  selectedTextQuestion?: string;
  imageContext?: ImageQuestionContext;
  onSpawn?: () => void;
}): Promise<string> {
  const label = normalizeHeaderText(text);
  const headerParts: HeaderParts = opts?.sourceSelection && opts.selectedTextQuestion
    ? {
        subject: normalizeHeaderText(opts.sourceSelection.text),
        question: normalizeHeaderText(opts.selectedTextQuestion),
        suffix: 'explained',
      }
    : opts?.imageContext?.regions.length ? { subject: label }
      : { subject: stripExplainHeaderSuffix(opts?.headerLabel ?? label), suffix: 'explained' };
  const header = flattenHeaderParts(headerParts);
  console.log('[scatter] spawnExplain: parent=%s text=%s', parentId, label);
  try {
    const id = newId();
    const proj = useGraphStore.getState().project!;
    const parent = proj.nodes[parentId]!;
    const sourceSelection = sourceSelectionForParent(parent, opts?.sourceSelection);
    const newNode: ScatterNode = {
      id, type: 'explain',
      ...(opts?.imageContext?.regions.length ? { generating: true } : {}),
      position: spawnNearParent(parent, Object.values(proj.nodes), undefined, undefined, opts?.imageContext?.regions),
      frozen: false,
      // Inherit group membership from parent on spawn (B.5).
      groupId: parent.groupId,
      versions: [{
        header,
        headerParts,
        body: '',
        language: opts?.language ?? normalizeLanguage(useSettingsStore.getState().generationLanguage),
        createdAt: Date.now(),
        generatedBy: 'explain',
        contentType: 'explain',
        ...(opts?.imageContext ? { imageContext: opts.imageContext } : {}),
        ...(opts?.imageContext?.regions.length ? { imageQuestion: text, imageTitleState: 'pending' as const } : {}),
        ...(opts?.selectedTextQuestion
          ? { selectedTextQuestion: opts.selectedTextQuestion }
          : {}),
      }],
      currentVersionIndex: 0,
    };
    // One undo entry for the whole spawn (node + arrow together).
    useGraphStore.getState().addNodeWithArrow(
      newNode,
      {
        id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto',
        sourceAnswer: chatSelectionOrigin(parent, opts?.sourceSelection),
        ...(opts?.imageContext?.regions.length ? { sourceImage: structuredClone(opts.imageContext) } : {}),
        ...(sourceSelection ? { sourceSelection } : {}),
      },
    );
    useGraphStore.getState().requestPanTo(id, parentId, 'newNodes');
    opts?.onSpawn?.();
    await streamIntoVersion(id, { kind: 'explain', term: opts?.promptTerm ?? label }, parentId);
    return id;
  } catch (e) {
    console.error('[scatter] spawnExplain failed:', e);
    throw e;
  }
}

type ExplainSpawnOptions = {
  promptTerm?: string;
  headerLabel?: string;
  sourceSelection?: NodeTextSelection;
  selectedTextQuestion?: string;
};

/** The selection toolbar always creates a text explanation. Interactive
 * generation is an explicit follow-up action on that explanation's side panel,
 * so a stochastic router can never surprise the user with executable content. */
export async function spawnRoutedExplain(
  parentId: string,
  text: string,
  opts?: ExplainSpawnOptions,
): Promise<string> {
  return spawnExplain(parentId, text, opts);
}

// ───────────────────────────────────────────────────────────────────
// Public API: whole-body rewrites
// ───────────────────────────────────────────────────────────────────

export async function modifyNode(nodeId: string, instruction: string): Promise<void> {
  const interactiveNode = useGraphStore.getState().project?.nodes[nodeId];
  if (interactiveNode && currentContentType(interactiveNode) === 'interactive') {
    await (await import('./interactiveActions')).buildInteractiveNode(nodeId, instruction, 'modify');
    return;
  }
  console.log('[scatter] modifyNode: node=%s instruction=%s', nodeId, instruction);
  try {
    const node = useGraphStore.getState().project!.nodes[nodeId]!;
    const cur = completedRewriteSource(node);
    const proj = useGraphStore.getState().project!;
    const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
    // Free-text nodes (explain) have no bullets and use `**bold**`, not chips —
    // modify them with the prose prompt and skip the chip pass, so they don't
    // turn into a bulleted normal node. The CURRENT version's content type is
    // the source of truth (the node may have been re-typed), not node.type.
    const ct = currentContentType(node);
    const isFreeText = isExplainContentType(ct);
    await runWholeRewrite({
      nodeId,
      // Pass-1 works on PLAIN text (chips stripped) so pass-2 can re-mark
      // cleanly without nesting brackets the model echoed back.
      variant: ct === 'answer'
        ? { kind: 'answer', previousBody: stripChips(cur.body), instruction, informationChunking: !!cur.chat?.informationChunking }
        : { kind: 'modify', previousBody: stripChips(cur.body), instruction, freeText: isFreeText },
      parentIdForContext: incoming?.fromNodeId ?? null,
      // Modify carries the bullet cap + content type forward unchanged.
      newVersionMeta: { header: cur.header, generatedBy: 'modify', maxL1Bullets: cur.maxL1Bullets, contentType: ct },
      // Mark terms for both encyclopedic and explain nodes (pass 2 adds the
      // clickable [[chips]]; explain's plain prose still gets them).
      runChips: true,
      maxLevel1: currentMaxL1Bullets(node),
    });
  } catch (e) {
    console.error('[scatter] modifyNode failed:', e);
    throw e;
  }
}

/** Create a corrected version from a completed, persisted evidence report.
 * The report already owns the web results, so this generation deliberately
 * receives no graph ancestors and performs no new search. */
export async function rewriteNodeWithEvidence(
  nodeId: string,
  report: FactCheckReport,
): Promise<void> {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  if (!project || !node || !report.complete) return;
  const cur = node.versions[node.currentVersionIndex];
  if (!cur || cur.createdAt !== report.versionCreatedAt) return;

  const byUrl = new Map<string, NodeSource>();
  for (const unit of report.units) {
    for (const evidence of unit.finding?.evidence ?? []) {
      if (byUrl.has(evidence.url)) continue;
      byUrl.set(evidence.url, {
        n: byUrl.size + 1,
        url: evidence.url,
        title: evidence.title,
        domain: evidence.domain,
      });
    }
  }
  const evidenceSources = [...byUrl.values()];
  const numberByUrl = new Map(evidenceSources.map((source) => [source.url, source.n]));
  const evidenceReport = report.units.map((unit) => {
    const finding = unit.finding;
    if (!finding) return `- ${unit.text}\n  Status: Unverified\n  Reason: check failed`;
    const sources = finding.evidence
      .map((evidence) => `E${numberByUrl.get(evidence.url)} ${evidence.stance}: ${evidence.excerpt ?? evidence.title ?? evidence.url}`)
      .join('\n  ');
    return `- ${unit.text}\n  Status: ${finding.verdict}\n  Explanation: ${finding.explanation}${sources ? `\n  ${sources}` : ''}`;
  }).join('\n');
  const sourceCatalog = evidenceSources
    .map((source) => `⟪E${source.n}⟫ ${source.title ?? source.domain ?? source.url} — ${source.url}`)
    .join('\n');
  const contentType = currentContentType(node);
  const headerParts = resolveVersionHeaderParts(node, cur, project.arrows);
  await runWholeRewrite({
    nodeId,
    variant: {
      kind: 'fact-rewrite',
      previousBody: stripChips(cur.body).replace(/⟦\d+⟧/g, ''),
      evidenceReport,
      sourceCatalog,
      freeText: isExplainContentType(contentType),
    },
    parentIdForContext: null,
    newVersionMeta: {
      header: cur.header,
      headerParts,
      generatedBy: 'modify',
      maxL1Bullets: cur.maxL1Bullets,
      contentType,
      selectedTextQuestion: cur.selectedTextQuestion,
      width: cur.width,
    },
    webSearch: false,
    evidenceSources,
    evidenceGoogleSearchSuggestions: mergeGoogleSearchSuggestions(...report.units.map(unit => unit.finding?.googleSearchSuggestions)),
    runChips: true,
    statusLabel: 'REWRITING WITH EVIDENCE',
    maxLevel1: currentMaxL1Bullets(node),
  });
}

export async function elaborateNode(nodeId: string): Promise<void> {
  console.log('[scatter] elaborateNode: node=%s', nodeId);
  try {
    const node = useGraphStore.getState().project!.nodes[nodeId]!;
    if (isExplainContentType(currentContentType(node))) {
      await expandPart(nodeId, { kind: 'freetext' });
      return;
    }
    const cur = completedRewriteSource(node);
    const proj = useGraphStore.getState().project!;
    const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
    // "Expand whole" raises THIS node's level-1 cap by one and regenerates with
    // the higher allowance — the only action that grows the cap.
    const nextMax = currentMaxL1Bullets(node) + 1;
    await runWholeRewrite({
      nodeId,
      variant: { kind: 'elaborate', previousBody: stripChips(cur.body) },
      parentIdForContext: incoming?.fromNodeId ?? null,
      newVersionMeta: { header: cur.header, generatedBy: 'modify', maxL1Bullets: nextMax, contentType: currentContentType(node) },
      statusLabel: 'EXPANDING WHOLE', // matches the "Expand whole" button
      maxLevel1: nextMax,
    });
  } catch (e) {
    console.error('[scatter] elaborateNode failed:', e);
    throw e;
  }
}

/** Re-run generation for a node into a new version. The variant is
 *  rebuilt from the node's CURRENT header (same branching as
 *  regenerateHeader); the parent for context is the auto-arrow source. */
export async function regenerateNode(nodeId: string): Promise<void> {
  const interactiveNode = useGraphStore.getState().project?.nodes[nodeId];
  if (interactiveNode && currentContentType(interactiveNode) === 'interactive') {
    await (await import('./interactiveActions')).buildInteractiveNode(nodeId);
    return;
  }
  console.log('[scatter] regenerateNode: node=%s', nodeId);
  try {
    const proj = useGraphStore.getState().project!;
    const node = proj.nodes[nodeId]!;
    const cur = completedRewriteSource(node);
    // An Explain node must regenerate AS an explanation — plain prose via the
    // `explain` variant (no bullets, no chip pass) — not a normal bulleted node.
    // The CURRENT version's content type is the source of truth.
    const ct = currentContentType(node);
    if (ct === 'answer') {
      await generateTextVersionFromHeader(nodeId, resolveVersionHeaderParts(node, cur, proj.arrows));
      return;
    }
    const isExplain = isExplainContentType(ct);
    const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
    const headerParts = resolveVersionHeaderParts(node, cur, proj.arrows);
    const selectedQuestion = selectedQuestionContext(cur, incoming, isExplain);
    const variant: TaskVariant = isExplain
      ? {
          kind: 'explain',
          term: cur.imageContext?.regions.length && cur.imageQuestion ? cur.imageQuestion : selectedQuestion
            ? selectedQuestionExplainTerm(selectedQuestion)
            : semanticHeaderText(headerParts),
        }
      : cur.imageContext?.regions.length && cur.imageQuestion ? { kind: 'follow-up', question: cur.imageQuestion }
      : selectedQuestion
        ? {
            kind: 'follow-up',
            question: selectedQuestion.question,
            selectedText: selectedQuestion.selectedText,
          }
        : semanticHeaderText(headerParts).includes('?')
          ? { kind: 'follow-up', question: semanticHeaderText(headerParts) }
          : { kind: 'term-click', term: semanticHeaderText(headerParts) };
    const parentIdForContext = incoming?.fromNodeId ?? null;
    const ctx = await runWholeRewrite({
      nodeId,
      variant,
      parentIdForContext,
      // Regenerate resets the level-1 cap back to the default; format preserved.
      newVersionMeta: {
        language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
        header: flattenHeaderParts(headerParts),
        headerParts,
        generatedBy: cur.generatedBy,
        contentType: ct,
        selectedTextQuestion: selectedQuestion?.question,
      },
      // Restructure (if needed) must run on the PLAIN body first; chips come after.
      runChips: false,
      maxLevel1: DEFAULT_MAX_L1_BULLETS,
    });
    // Skip the corrective restructure when web-search markers were exact-placed
    // (it regenerates from scratch and would wipe them).
    if (!ctx) return;
    if (!ctx.newSources.length) {
      await correctStructureAfterRegen(nodeId, variant.kind, parentIdForContext, ctx.versionIndex);
    }
    // Term-marking (pass 2) runs for BOTH encyclopedic and explain — explain
    // prose gets clickable terms too, matching a fresh explain spawn.
    await addChipsToCurrentVersion(nodeId, ctx.versionIndex);
    finalizeRewriteCitations(nodeId, ctx.versionIndex, ctx);
    completeGenerationSession(nodeId);
  } catch (e) {
    console.error('[scatter] regenerateNode failed:', e);
    throw e;
  }
}

/** Create a fresh AI text version from the complete structured header shown in
 * the editor. Visual-only prefix/suffix text is retained on the card but never
 * sent to the model. */
export async function generateTextVersionFromHeader(
  nodeId: string,
  rawParts: HeaderParts,
): Promise<void> {
  const parts = normalizeHeaderParts(rawParts);
  const subject = semanticHeaderText(parts);
  if (!subject) return;
  const proj = useGraphStore.getState().project;
  const node = proj?.nodes[nodeId];
  if (!proj || !node || node.generating || currentContentType(node) === 'media') return;

  const ct = currentContentType(node);
  if (ct === 'interactive') {
    await (await import('./interactiveActions')).buildInteractiveNode(nodeId, subject, 'regenerate');
    return;
  }
  const incoming = Object.values(proj.arrows).find(
    (arrow) => arrow.kind === 'auto' && arrow.toNodeId === nodeId,
  );
  const selectedQuestion = parts.question
    ? { selectedText: parts.subject, question: parts.question }
    : null;
  const variant: TaskVariant = ct === 'answer'
    ? { kind: 'answer', instruction: configuredPrompt('taskAnswerFromHeader', { subject }), informationChunking: !!node.versions[node.currentVersionIndex]?.chat?.informationChunking }
    : isExplainContentType(ct)
    ? {
        kind: 'explain',
        term: selectedQuestion
          ? selectedQuestionExplainTerm(selectedQuestion)
          : parts.subject,
      }
    : selectedQuestion
      ? { kind: 'follow-up', question: selectedQuestion.question, selectedText: selectedQuestion.selectedText }
      : subject.includes('?')
        ? { kind: 'follow-up', question: subject }
        : { kind: 'term-click', term: subject };
  const generatedBy: NodeKind = ct === 'explain'
      ? 'explain'
      : selectedQuestion || subject.includes('?') ? 'follow-up'
      : node.type === 'root' ? 'root' : 'term-click';

  const ctx = await runWholeRewrite({
    nodeId,
    variant,
    parentIdForContext: incoming?.fromNodeId ?? null,
    newVersionMeta: {
      header: flattenHeaderParts(parts),
      language: normalizeLanguage(useSettingsStore.getState().generationLanguage),
      headerParts: parts,
      generatedBy,
      contentType: ct,
      selectedTextQuestion: parts.question ?? null,
    },
    runChips: false,
    maxLevel1: DEFAULT_MAX_L1_BULLETS,
  });
  if (!ctx) return;
  if (ct !== 'answer' && !ctx.newSources.length) {
    await correctStructureAfterRegen(nodeId, variant.kind, incoming?.fromNodeId ?? null, ctx.versionIndex);
  }
  await addChipsToCurrentVersion(nodeId, ctx.versionIndex);
  finalizeRewriteCitations(nodeId, ctx.versionIndex, ctx);
  completeGenerationSession(nodeId);

}

/** Re-type a node to one of the TEXT formats (encyclopedic / explain) from the
 *  node-type menu. Regenerates from the node's current header in the target
 *  format and commits it as a NEW version (older versions stay switchable, in
 *  their original format). Mirrors regenerateNode but FORCES the target format
 *  instead of preserving the current one. The root is never re-typed. */
export async function retypeNodeToText(nodeId: string, target: 'encyclopedic' | 'explain'): Promise<void> {
  console.log('[scatter] retypeNodeToText: node=%s target=%s', nodeId, target);
  try {
    const proj = useGraphStore.getState().project!;
    const node = proj.nodes[nodeId]!;
    if (node.type === 'root') return; // the root's type is fixed
    const cur = completedRewriteSource(node);
    const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
    const parentIdForContext = incoming?.fromNodeId ?? null;
    const isExplain = target === 'explain';
    const currentParts = resolveVersionHeaderParts(node, cur, proj.arrows);
    const { suffix: _oldSuffix, ...partsWithoutSuffix } = currentParts;
    const targetParts = normalizeHeaderParts(isExplain
      ? { ...partsWithoutSuffix, suffix: 'explained' }
      : partsWithoutSuffix);
    const explainSubject = semanticHeaderText(targetParts);
    const encyclopedicSubject = semanticHeaderText(targetParts);
    const selectedQuestion = selectedQuestionContext(
      cur,
      incoming,
      isExplainContentType(currentContentType(node)),
    );
    const variant: TaskVariant = isExplain
      ? {
          kind: 'explain',
          term: selectedQuestion
            ? selectedQuestionExplainTerm(selectedQuestion)
            : explainSubject,
        }
      : selectedQuestion
        ? {
            kind: 'follow-up',
            question: selectedQuestion.question,
            selectedText: selectedQuestion.selectedText,
          }
        : encyclopedicSubject.includes('?')
          ? { kind: 'follow-up', question: encyclopedicSubject }
          : { kind: 'term-click', term: encyclopedicSubject };
    const generatedBy: NodeKind = isExplain
      ? 'explain'
      : selectedQuestion || encyclopedicSubject.includes('?') ? 'follow-up' : 'term-click';
    const ctx = await runWholeRewrite({
      nodeId,
      variant,
      parentIdForContext,
      // Fresh format → fresh cap (default); chips run after the structure check.
      newVersionMeta: {
        header: flattenHeaderParts(targetParts),
        headerParts: targetParts,
        generatedBy,
        contentType: target,
      selectedTextQuestion: selectedQuestion?.question,
      },
      runChips: false,
      maxLevel1: DEFAULT_MAX_L1_BULLETS,
    });
    if (!ctx) return;
    if (!ctx.newSources.length) {
      await correctStructureAfterRegen(nodeId, variant.kind, parentIdForContext, ctx.versionIndex);
    }
    await addChipsToCurrentVersion(nodeId, ctx.versionIndex);
    finalizeRewriteCitations(nodeId, ctx.versionIndex, ctx);
    completeGenerationSession(nodeId);
  } catch (e) {
    console.error('[scatter] retypeNodeToText failed:', e);
    throw e;
  }
}

// ───────────────────────────────────────────────────────────────────
// Public API: partial rewrite (expand-part)
// ───────────────────────────────────────────────────────────────────

/**
 * Target for the per-section "expand this part" operation.
 *
 * - `freetext`: the opening paragraph above the bullet list.
 * - `bullet`: a level-1 bullet identified by its 0-based index in
 *   document order (matches `parseBody(body).bullets[index]`).
 */
export type ExpandPartTarget =
  | { kind: 'freetext' }
  | { kind: 'bullet'; index: number }
  | {
      kind: 'selection';
      start: number;
      end: number;
      /** Exact visible semantic fragments; runtime-only rewrite feedback. */
      parts?: NodeTextSelectionPart[];
    };

/** L1 bullet line predicate — same syntax as `bulletParse` accepts. */
export const L1_LINE_RE = /^[-*+]\s+/;
/** Indented (level-2+) bullet line predicate. */
export const L2_LINE_RE = /^\s+[-*+]\s+/;

/**
 * Locate the start/end char positions of `target` inside `body`.
 * Section boundaries align to whole lines. Returns null if the target
 * isn't present in the body.
 *
 * (Behavior unchanged from previous implementation.)
 */
export function locateSection(body: string, target: ExpandPartTarget): { start: number; end: number } | null {
  if (target.kind === 'selection') {
    if (target.start < 0 || target.end <= target.start || target.end > body.length) return null;
    return { start: target.start, end: target.end };
  }
  const lines = body.split('\n');
  const l1Indices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (L1_LINE_RE.test(lines[i]!)) l1Indices.push(i);
  }
  let startLine: number;
  let endLine: number;
  if (target.kind === 'freetext') {
    const firstL1 = l1Indices[0] ?? lines.length;
    if (firstL1 === 0) return null;
    startLine = 0;
    endLine = firstL1;
    while (endLine > startLine && lines[endLine - 1]!.trim() === '') endLine--;
    if (endLine === startLine) return null;
  } else {
    const sIdx = l1Indices[target.index];
    if (sIdx === undefined) return null;
    const nextL1 = l1Indices[target.index + 1] ?? lines.length;
    startLine = sIdx + 1;
    endLine = nextL1;
    while (endLine > startLine && lines[endLine - 1]!.trim() === '') endLine--;
  }
  let start = 0;
  for (let i = 0; i < startLine; i++) start += lines[i]!.length + 1;
  if (start > body.length) start = body.length;
  let end = start;
  for (let i = startLine; i < endLine; i++) {
    end += lines[i]!.length;
    if (i < endLine - 1) end += 1;
  }
  return { start, end };
}

// ───────────────────────────────────────────────────────────────────
// Public API: "Pop selected" — extract a bullet into a new child node
// ───────────────────────────────────────────────────────────────────

/**
 * Split the WHOLE level-1 bullet at `index` (its title line through the line
 * before the next L1, or EOF) out of `body`. Returns the parent body with
 * that block removed (blank-line seams collapsed), plus the raw title line
 * and the raw child lines. Returns null if the index is out of range.
 *
 * NOTE: unlike `locateSection` (which for a bullet returns only the CHILDREN
 * range, excluding the title), this captures the title line too — that's what
 * "remove the whole bullet" requires.
 */
export function splitOutBullet(body: string, index: number): {
  newParentBody: string;
  titleLine: string;
  childLines: string[];
} | null {
  const lines = body.split('\n');
  const l1: number[] = [];
  for (let i = 0; i < lines.length; i++) if (L1_LINE_RE.test(lines[i]!)) l1.push(i);
  const startLine = l1[index];
  if (startLine === undefined) return null;
  const endLine = l1[index + 1] ?? lines.length;   // exclusive
  const block = lines.slice(startLine, endLine);
  const titleLine = block[0] ?? '';
  const childLines = block.slice(1).filter((l) => l.trim() !== '');
  const remaining = [...lines.slice(0, startLine), ...lines.slice(endLine)];
  const newParentBody = remaining.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { newParentBody, titleLine, childLines };
}

/** Strip a leading bullet marker (`- `, `* `, `+ `) from a line. */
function stripBulletMarker(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, '').trim();
}

/** Derive a clean node header from a raw L1 bullet line. Prefers a leading
 *  **bold** term, else the text before a `: ` (name: desc convention), else
 *  the whole line with emphasis stripped. */
function bulletTitleToHeader(titleLine: string): string {
  const t = stripBulletMarker(titleLine);
  let header: string;
  const bold = t.match(/^\*\*(.+?)\*\*/);
  if (bold) {
    header = bold[1]!;
  } else {
    // Chip-aware: skip a colon that lives inside a [[chip]] (e.g.
    // `[[2001: A Space Odyssey]]: ...`) and keep the `: ` (space) separator
    // convention so titles like "Ratio 3:2" aren't split mid-number.
    const colon = separatorColonIndex(t);
    const isSep = colon > 0 && t[colon + 1] === ' ';
    header = (isSep ? t.slice(0, colon) : t).replace(/\*\*/g, '');
  }
  // Strip clickable-reference marks so the header is plain text (e.g.
  // `[[Photosynthesis]]` → `Photosynthesis`); the arrow label (= header)
  // then matches the chip-term convention used for dedup.
  return header.replace(/\[\[([^\]]+)\]\]/g, '$1').trim();
}

/** De-indent the popped bullet's level-2 children into a flat top-level
 *  markdown list (the seed body + the content the rework prompt regroups). */
function childrenToFlatList(childLines: string[]): string {
  return childLines
    .map((l) => l.replace(L2_LINE_RE, '- '))
    .join('\n');
}

/**
 * "Pop selected": extract the level-1 bullet at `bulletIndex` (with its
 * sub-points) from the parent into a NEW child node, then have the AI rework
 * it — a short opening paragraph plus the sub-points regrouped into ≥2 named
 * groups. The structural change (parent body edit + child + arrow + select)
 * lands as ONE undo entry via `popBulletToChild`; the streamed rework is
 * pause-excluded from history (see bgGen.updateGenNode), so undoing the pop
 * removes the whole child in a single step.
 */
export async function popSelectedBullet(parentId: string, bulletIndex: number): Promise<string | null> {
  try {
    const proj = useGraphStore.getState().project;
    if (!proj) return null;
    const parent = proj.nodes[parentId];
    if (!parent) return null;
    const pv = parent.versions[parent.currentVersionIndex];
    if (!pv) return null;
    const split = splitOutBullet(pv.body, bulletIndex);
    if (!split) return null;

    const header = bulletTitleToHeader(split.titleLine);
    const seedBody = childrenToFlatList(split.childLines);
    const id = newId();
    const child: ScatterNode = {
      id, type: 'term-click',
      position: spawnNearParent(parent, Object.values(proj.nodes)),
      frozen: false,
      groupId: parent.groupId,
      // Seed with the extracted sub-points so the content survives even if
      // generation fails; the rework stream replaces the body below.
      versions: [{ header, body: seedBody, createdAt: Date.now(), generatedBy: 'term-click', contentType: 'encyclopedic' }],
      currentVersionIndex: 0,
    };
    const arrow: Arrow = { id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto', label: header };

    useGraphStore.getState().popBulletToChild(parentId, split.newParentBody, child, arrow);
    useGraphStore.getState().requestPanTo(id, parentId, 'newNodes');
    // Pass-1 reworks PLAIN sub-points (chips stripped); pass-2 re-marks them.
    await streamIntoVersion(id, { kind: 'pop-rework', title: header, bulletBody: stripChips(seedBody) }, parentId);
    return id;
  } catch (e) {
    console.error('[scatter] popSelectedBullet failed:', e);
    throw e;
  }
}

/**
 * Defensive sanitizer for `expandPart` LLM output. The prompt asks
 * for ONLY the new section content, but models often echo the
 * surrounding bullets/freetext too. This extracts the section content
 * using structural boundaries (L1 / L2 line predicates).
 *
 * (Behavior unchanged from previous implementation.)
 */
export function extractSectionFromLLM(output: string, target: ExpandPartTarget): string {
  if (target.kind === 'selection') {
    const marked = output.match(/<<<SELECTED>>>\s*([\s\S]*?)\s*<<<END_SELECTED>>>/);
    return (marked?.[1] ?? output)
      .replace(/^```(?:markdown|text)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
  }
  const lines = output.split('\n');
  if (target.kind === 'freetext') {
    let endIdx = 0;
    while (endIdx < lines.length && !L1_LINE_RE.test(lines[endIdx]!)) endIdx++;
    while (endIdx > 0 && lines[endIdx - 1]!.trim() === '') endIdx--;
    return lines.slice(0, endIdx).join('\n');
  }
  let startIdx = 0;
  while (startIdx < lines.length && !L2_LINE_RE.test(lines[startIdx]!)) {
    if (L1_LINE_RE.test(lines[startIdx]!)) { startIdx++; continue; }
    startIdx++;
  }
  if (startIdx === lines.length) return '';
  let endIdx = startIdx;
  while (
    endIdx < lines.length
    && (L2_LINE_RE.test(lines[endIdx]!) || lines[endIdx]!.trim() === '')
  ) endIdx++;
  while (endIdx > startIdx && lines[endIdx - 1]!.trim() === '') endIdx--;
  return lines.slice(startIdx, endIdx).join('\n');
}

/**
 * Per-section expand. Behaviour:
 *
 *   1. Refuse if a whole rewrite is in flight, or if a partial
 *      targeting THIS section is already running. (UI also disables
 *      the button under these conditions; this is defense in depth.)
 *
 *   2. Begin (or reuse) the burst snapshot.
 *
 *   3. Locate the section in the CURRENT working body. Insert a
 *      unique marker pair around the section text. The markers are
 *      stripped at render time (see `getDisplayBody`) and stripped at
 *      commit time, so the user never sees them.
 *
 *   4. Animate-delete the section's text between the markers.
 *
 *   5. Stream the LLM. Each chunk replaces the text BETWEEN this
 *      rewrite's markers via `replaceBetweenMarkers` — other
 *      rewrites' marker-delimited slices are untouched, so two
 *      partials on different sections can run concurrently.
 *
 *   6. On completion, strip just this rewrite's markers (leaving the
 *      streamed content in place). `finishRewrite` then commits if
 *      this was the last in-flight rewrite, or defers to whichever
 *      finishes last.
 */
export async function expandPart(nodeId: string, target: Exclude<ExpandPartTarget, { kind: 'selection' }>): Promise<void> {
  return runPartialRewrite(nodeId, target);
}

/** Modify exactly the source characters represented by a visible body selection. */
export async function modifySelection(selection: NodeTextSelection, instruction: string): Promise<void> {
  const node = useGraphStore.getState().project?.nodes[selection.nodeId];
  const version = node?.versions[node.currentVersionIndex];
  if (
    !node
    || node.currentVersionIndex !== selection.versionIndex
    || version?.body !== selection.sourceBody
    || !instruction.trim()
  ) return;
  const parts = normalizedSelectionParts(selection);
  if (!parts) return;
  return runSegmentedSelectionRewrite(selection, parts, instruction.trim());
}

function normalizedSelectionParts(selection: NodeTextSelection): NodeTextSelectionPart[] | null {
  const parts = selection.parts?.length
    ? selection.parts
    : [{
        sourceField: '', start: selection.start, end: selection.end,
        text: selection.text,
      }];
  const ordered = [...parts].sort((a, b) => a.start - b.start);
  let previousEnd = -1;
  for (const part of ordered) {
    if (
      part.start < 0
      || part.end <= part.start
      || part.end > selection.sourceBody.length
      || part.start < previousEnd
    ) return null;
    previousEnd = part.end;
  }
  return ordered;
}

function markSegmentedSelection(body: string, parts: NodeTextSelectionPart[]): string {
  if (parts.length === 1) {
    const part = parts[0]!;
    return stripChips(body.slice(0, part.start))
      + `<<<SELECTED>>>${stripChips(body.slice(part.start, part.end))}<<<END_SELECTED>>>`
      + stripChips(body.slice(part.end));
  }
  let out = '';
  let cursor = 0;
  parts.forEach((part, index) => {
    const n = index + 1;
    out += stripChips(body.slice(cursor, part.start));
    out += `<<<SELECTED_${n}>>>${stripChips(body.slice(part.start, part.end))}<<<END_SELECTED_${n}>>>`;
    cursor = part.end;
  });
  return out + stripChips(body.slice(cursor));
}

/** Parse the strict, model-neutral envelope used for disjoint replacements. */
export function extractSegmentedSelectionReplacements(output: string, count: number): string[] | null {
  if (count === 1) {
    const replacement = output.trim();
    return replacement ? [replacement] : null;
  }
  const replacements: string[] = [];
  for (let index = 1; index <= count; index++) {
    const pattern = new RegExp(`<<<REPLACEMENT_${index}>>>\\s*([\\s\\S]*?)\\s*<<<END_REPLACEMENT_${index}>>>`);
    const match = output.match(pattern);
    const replacement = match?.[1]?.trim();
    if (!replacement) return null;
    replacements.push(replacement);
  }
  return replacements;
}

/** Splice from right to left so earlier source coordinates never shift. */
export function replaceSelectionParts(
  body: string,
  parts: NodeTextSelectionPart[],
  replacements: string[],
): string | null {
  if (parts.length !== replacements.length) return null;
  let result = body;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    result = result.slice(0, part.start) + replacements[index]! + result.slice(part.end);
  }
  return result;
}

/**
 * One request, one version, many safe splices. The provider rewrites numbered
 * visible fragments; Scatter validates the count before touching the body.
 * Hidden source intervals between those fragments never enter a replacement.
 */
async function runSegmentedSelectionRewrite(
  selection: NodeTextSelection,
  parts: NodeTextSelectionPart[],
  instruction: string,
): Promise<void> {
  const nodeId = selection.nodeId;
  const initialNode = useGraphStore.getState().project?.nodes[nodeId];
  const initialVersion = initialNode?.versions[initialNode.currentVersionIndex];
  if (!initialNode || !initialVersion || isWholeActive(nodeId)) return;
  const activeRecords = useRewriteStore.getState().activeByNode[nodeId] ?? [];
  if (activeRecords.length > 0) return;

  const meta: RewriteVersionMeta = {
    header: initialVersion.header,
    generatedBy: 'modify',
    maxL1Bullets: initialVersion.maxL1Bullets,
    contentType: currentContentType(initialNode),
  };
  beginBurst(nodeId, { draftMeta: meta });
  const store = useRewriteStore.getState();
  const snapshot = store.snapshot[nodeId]!;
  store.setWorkingBody(nodeId, selection.sourceBody);
  const target: ExpandPartTarget = {
    kind: 'selection',
    start: parts[0]!.start,
    end: parts.at(-1)!.end,
    parts,
  };
  const rewriteId = nextMarkerId();
  const controller = new AbortController();
  registerGenerationController(snapshot.generationSessionId, controller);
  store.addRecord({
    id: rewriteId, nodeId, kind: 'partial', target,
    originalSectionText: selection.text, abortController: controller,
  });
  setGenFlags(nodeId, { generating: true, generationError: undefined });
  setNodeStatus(nodeId, 'MODIFYING SELECTION');

  const project = useGraphStore.getState().project!;
  const incoming = Object.values(project.arrows).find(
    (arrow) => arrow.kind === 'auto' && arrow.toNodeId === nodeId,
  );
  let modelTextReceived = false;
  try {
    const streamRes = await streamChunks({
      nodeId,
      variant: {
        kind: 'modify-selection',
        markedBody: markSegmentedSelection(selection.sourceBody, parts),
        selectedText: selection.text,
        instruction,
        mode: currentContentType(initialNode) === 'answer' ? 'answer' : isExplainContentType(currentContentType(initialNode)) ? 'explain' : 'encyclopedic',
        informationChunking: initialVersion.chat?.informationChunking,
        partCount: parts.length,
      },
      parentIdForContext: incoming?.fromNodeId ?? null,
      signal: controller.signal,
      onAcc: (acc) => {
        if (!acc.trim()) return;
        modelTextReceived = true;
        markGenerationTextReceived(snapshot.generationSessionId);
      },
      maxOutputTokens: 8_000,
      statusLabel: 'MODIFYING SELECTION',
      maxLevel1: currentMaxL1Bullets(initialNode),
    });
    if (controller.signal.aborted) {
      finishRewrite(nodeId, rewriteId, 'aborted', meta);
      return;
    }
    if (streamRes.sourceOnlyInsufficient) {
      throw new Error('Sources only: Not enough information in active sources to complete this action. Change the source mode or activate more relevant sources.');
    }
    const completionError = generationCompletionError(
      streamRes.rawText,
      streamRes.finishReason,
      streamRes.citations,
    );
    if (completionError) throw new Error(completionError);
    const presentOld = new Set(
      [...selection.sourceBody.matchAll(/⟦(\d+)⟧/g)].map((match) => Number(match[1])),
    );
    const oldSources = (initialVersion.sources ?? []).filter((source) => presentOld.has(source.n));
    const presentOldInternal = new Set(
      [...selection.sourceBody.matchAll(/\((\d+)\)/g)].map((match) => Number(match[1])),
    );
    const oldInternalSources = (initialVersion.internalSources ?? [])
      .filter((source) => presentOldInternal.has(source.n));
    const internalOffset = oldInternalSources.reduce((max, source) => Math.max(max, source.n), 0);
    const knownUrls = new Set(oldSources.map((source) => source.url));
    const markerNumbers = [...selection.sourceBody.matchAll(/⟦(\d+)⟧/g)]
      .map((match) => Number(match[1]));
    const maxUsedN = [...oldSources.map((source) => source.n), ...markerNumbers]
      .reduce((max, number) => Math.max(max, number), 0);
    const newCitations = streamRes.citations.filter((citation) => citation.url && !knownUrls.has(citation.url));
    const newSources = buildSources(newCitations).map((source) => ({ ...source, n: source.n + maxUsedN }));
    const citedRawSelection = newSources.length
      ? placeCitationMarkersReliable(streamRes.rawText, newCitations, newSources, 'fragment-end')
      : streamRes.rawText;
    // Web offsets belong to the provider's raw text. Normalize SOURCE_n only
    // after the web markers are in place, otherwise replacements after the
    // first internal marker receive shifted offsets.
    const normalizedSelection = normalizeInternalCitationTokens(
      citedRawSelection,
      streamRes.sourcePassages,
    );
    let replacements = extractSegmentedSelectionReplacements(normalizedSelection.body, parts.length);
    if (!replacements) throw new Error('The model did not return every selected-text replacement. Please retry.');
    const usedNewInternal = pruneInternalSources(replacements.join('\n'), normalizedSelection.sources)
      .map((source) => ({ ...source, n: source.n + internalOffset }));
    if (internalOffset > 0) {
      replacements = replacements.map((replacement) => replacement.replace(/\((\d+)\)/g, (token, digits: string) => (
        normalizedSelection.sources.some((source) => source.n === Number(digits))
          ? `(${Number(digits) + internalOffset})`
          : token
      )));
    }

    // Run one marking pass for the whole replacement set. A private delimiter
    // keeps the parts addressable; if a model alters it, fall back to the safe
    // unmarked replacements rather than risking a cross-part rewrite.
    const delimiter = `\n<<<SCATTER_PART_BREAK_${rewriteId}>>>\n`;
    const combined = replacements.join(delimiter);
    const savedRetry = retryArgs.get(nodeId);
    const chippedCombined = await streamChipPass({
      nodeId,
      projId: useGraphStore.getState().activeProjectId,
      plainBody: combined,
      signal: controller.signal,
    });
    const chippedParts = chippedCombined.split(delimiter);
    if (chippedParts.length === parts.length) replacements = chippedParts;
    if (savedRetry) retryArgs.set(nodeId, savedRetry);

    const revisedBody = replaceSelectionParts(selection.sourceBody, parts, replacements);
    if (!revisedBody) throw new Error('The selected text changed before it could be replaced.');
    store.setWorkingBody(nodeId, revisedBody);
    mirrorRewriteDraft(nodeId, revisedBody);

    const presentNumbers = new Set(
      [...revisedBody.matchAll(/⟦(\d+)⟧/g)].map((match) => Number(match[1])),
    );
    const survivingOldSources = oldSources.filter((source) => presentNumbers.has(source.n));
    const citationCtx: RewriteCitationCtx = {
      googleSearchSuggestions: mergeGoogleSearchSuggestions(survivingOldSources.length ? initialVersion.googleSearchSuggestions : undefined, streamRes.googleSearchSuggestions),
      oldSources: survivingOldSources,
      newSources: newSources.filter((source) => presentNumbers.has(source.n)),
      internalSources: [...oldInternalSources, ...usedNewInternal],
      limitedSourceSearchReason: streamRes.limitedSourceSearchReason,
      webSearchRequested: streamRes.webSearchRequested,
      webSearchUsed: streamRes.webSearchUsed,
      webSearchError: streamRes.webSearchError,
    };
    const committedSources = [...citationCtx.oldSources, ...citationCtx.newSources];
    const result = finishRewrite(nodeId, rewriteId, 'completed', {
      ...meta,
      sources: committedSources.length ? committedSources : undefined,
      googleSearchSuggestions: citationCtx.googleSearchSuggestions,
      internalSources: citationCtx.internalSources.length ? citationCtx.internalSources : undefined,
      sourceLimitation: citationCtx.limitedSourceSearchReason ? {
        kind: 'limited-search', message: 'Limited source search', reason: citationCtx.limitedSourceSearchReason,
      } : undefined,
      webSearched: citationCtx.webSearchUsed ? true : undefined,
      webSearchFailed: citationCtx.webSearchRequested && !citationCtx.webSearchUsed ? true : undefined,
    });
    if (result?.committed) {
      finalizeRewriteCitations(nodeId, result.versionIndex, citationCtx);
      completeGenerationSession(nodeId);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      setGenFlags(nodeId, { generationError: friendlyErrorMessage(error) });
    }
    // The working body is still the source body until every replacement has
    // validated, so a malformed/no-text answer cannot damage hidden content.
    if (!modelTextReceived) store.setWorkingBody(nodeId, selection.sourceBody);
    finishRewrite(nodeId, rewriteId, controller.signal.aborted ? 'aborted' : 'errored', meta);
  }
}

async function runPartialRewrite(
  nodeId: string,
  target: ExpandPartTarget,
  selectionRequest?: { instruction: string; selectedText: string },
): Promise<void> {
  console.log('[scatter] partial rewrite: node=%s target=%o', nodeId, target);

  const initialNode = useGraphStore.getState().project?.nodes[nodeId];
  if (!initialNode) return;
  const initialVersion = initialNode.versions[initialNode.currentVersionIndex];
  if (!initialVersion) return;
  const explainMode = isExplainContentType(currentContentType(initialNode));
  if (explainMode && target.kind !== 'selection') target = { kind: 'freetext' };
  const meta: RewriteVersionMeta = {
    header: initialVersion.header,
    generatedBy: 'modify',
    maxL1Bullets: initialVersion.maxL1Bullets,
    contentType: currentContentType(initialNode),
  };

  // Concurrency gate: refuse if conflicting with an existing rewrite.
  // The UI also disables the trigger button under these conditions;
  // this gate handles races where two clicks landed before the UI
  // re-rendered with the disable state.
  const activeRecords = useRewriteStore.getState().activeByNode[nodeId] ?? [];
  if (isWholeActive(nodeId)) {
    console.warn('[scatter] expandPart refused: whole rewrite in flight');
    return;
  }
  // Exact ranges become stale as soon as any other rewrite changes the body.
  // Therefore a selected-text rewrite never shares a burst, and its presence
  // also blocks a later section expansion until it finishes.
  if (
    (target.kind === 'selection' && activeRecords.length > 0)
    || activeRecords.some((record) => record.target?.kind === 'selection')
  ) {
    console.warn('[scatter] partial rewrite refused: selected-text rewrite conflicts with active work');
    return;
  }
  if (isPartialActiveOn(nodeId, target)) {
    console.warn('[scatter] expandPart refused: target already being rewritten');
    return;
  }

  try {
    const joinedExistingBurst = (useRewriteStore.getState().activeByNode[nodeId]?.length ?? 0) > 0;
    beginBurst(nodeId, { draftMeta: meta });
    const store = useRewriteStore.getState();
    const workingBody = store.workingBody[nodeId] ?? '';
    const strippedWorking = stripMarkers(workingBody);

    // Locate section bounds in the CURRENT stripped working body.
    // Other concurrent partials may have shifted line positions by
    // streaming differently-sized content into their sections, so we
    // always re-locate against the live working body, not the pre-
    // burst body.
    const section = locateSection(strippedWorking, target);
    if (!section) {
      console.warn('[scatter] expandPart: no target found, skipping');
      // `beginBurst` creates the provisional version before any model work.
      // If this call started that burst and then discovered there is nothing
      // to expand, roll the empty draft back immediately. A concurrent burst
      // belongs to its other partials and must remain untouched.
      if (!joinedExistingBurst) {
        cancelNodeGeneration(nodeId, { discardCurrentWork: true });
      }
      return;
    }
    // Translate stripped-body section bounds back to raw-body bounds
    // so we know where to splice in our marker pair without disturbing
    // any markers belonging to other concurrent partials.
    const { rawStart, rawEnd, originalSectionText } = translateBoundsToRaw(
      workingBody, section.start, section.end,
    );
    const beforeText = strippedWorking.slice(0, section.start);
    const afterText = strippedWorking.slice(section.end);

    const rewriteId = nextMarkerId();
    const markedBody = insertMarkedSection(workingBody, rawStart, rawEnd, rewriteId, originalSectionText);
    store.setWorkingBody(nodeId, markedBody);

    // Marked-body view of the full body to send to the LLM as
    // context. The model sees the entire current body with
    // <<<EXPAND>>>/<<<END>>> textual markers around the targeted
    // section — independent of our internal marker chars.
    //
    // Strip `[[chip]]` markup from the prompt copy (NOT from the real
    // `originalSectionText`, which the splice logic above/below depends on).
    // If pass 1 sees the existing chips it just echoes them and the dedicated
    // chip pass (pass 2, streamChipPass below) finds nothing left to mark —
    // yielding fewer terms. Feeding plain prose lets pass 2 do all the marking.
    // Mirrors `modify`/`elaborate`/`pop-rework`, which already strip chips
    // before pass 1.
    const promptMarkedBody = target.kind === 'selection'
      ? stripChips(beforeText)
        + `<<<SELECTED>>>${stripChips(originalSectionText)}<<<END_SELECTED>>>`
        + stripChips(afterText)
      : stripChips(beforeText)
        + `<<<EXPAND>>>\n${stripChips(originalSectionText)}\n<<<END>>>`
        + stripChips(afterText);

    const controller = new AbortController();
    const generationSessionId = useRewriteStore.getState().snapshot[nodeId]?.generationSessionId;
    if (generationSessionId != null) registerGenerationController(generationSessionId, controller);
    store.addRecord({
      id: rewriteId,
      nodeId,
      kind: 'partial',
      target,
      originalSectionText,
      abortController: controller,
    });

    // Part F — status from the click, before the section backspaces away.
    setGenFlags(nodeId, { generating: true, generationError: undefined });
    const statusLabel = target.kind === 'selection' ? 'MODIFYING SELECTION' : 'EXPANDING SELECTED';
    setNodeStatus(nodeId, statusLabel);

    const proj = useGraphStore.getState().project!;
    const incoming = Object.values(proj.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
    const expandNode = proj.nodes[nodeId]!;
    const cur = expandNode.versions[expandNode.currentVersionIndex]!;
    let fragmentTextReceived = false;
    try {
      // Backspace-chew the SECTION (text between markers). animateDeletionInto
      // calls writeBack with the new "remaining" each frame; writeBack
      // applies it via replaceBetweenMarkers so other rewrites are unaffected.
      await animateDeletionInto(
        originalSectionText,
        (remaining) => {
          const cur = useRewriteStore.getState().workingBody[nodeId] ?? '';
          useRewriteStore.getState().setWorkingBody(
            nodeId, replaceBetweenMarkers(cur, rewriteId, remaining),
          );
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        finishRewrite(nodeId, rewriteId, 'aborted', meta);
        return;
      }
      // Stream into the marker-delimited slice.
      let finalFragment = '';
      const streamRes = await streamChunks({
        nodeId,
        variant: target.kind === 'selection'
          ? {
              kind: 'modify-selection',
              markedBody: promptMarkedBody,
              selectedText: selectionRequest?.selectedText ?? originalSectionText,
              instruction: selectionRequest?.instruction ?? '',
              mode: explainMode ? 'explain' : 'encyclopedic',
            }
          : { kind: 'expand-part', markedBody: promptMarkedBody, mode: explainMode ? 'explain' : 'encyclopedic' },
        parentIdForContext: incoming?.fromNodeId ?? null,
        signal: controller.signal,
        onAcc: (sanitizedAcc) => {
          if (sanitizedAcc.trim()) {
            fragmentTextReceived = true;
            markGenerationTextReceived(
              useRewriteStore.getState().snapshot[nodeId]?.generationSessionId ?? -1,
            );
          }
          finalFragment = sanitizedAcc;
          const cur = useRewriteStore.getState().workingBody[nodeId] ?? '';
          useRewriteStore.getState().setWorkingBody(
            nodeId, replaceBetweenMarkers(cur, rewriteId, sanitizedAcc),
          );
          mirrorRewriteDraft(
            nodeId,
            useRewriteStore.getState().workingBody[nodeId] ?? '',
          );
        },
        sanitize: (acc) => extractSectionFromLLM(acc, target),
        maxOutputTokens: 8_000,
        statusLabel,
        maxLevel1: currentMaxL1Bullets(expandNode),
      });
      if (controller.signal.aborted) {
        finishRewrite(nodeId, rewriteId, 'aborted', meta);
        return;
      }
      if (streamRes.sourceOnlyInsufficient) {
        fragmentTextReceived = false;
        throw new Error('Sources only: Not enough information in active sources to complete this action. Change the source mode or activate more relevant sources.');
      }
      const completionError = generationCompletionError(
        streamRes.rawText,
        streamRes.finishReason,
        streamRes.citations,
      );
      if (completionError) {
        fragmentTextReceived = false;
        throw new Error(completionError);
      }
      // Carry surviving old sources and place any fresh web-search citations
      // inside the replacement fragment while its provider offsets are still
      // valid. The full working body is used only to determine which old
      // markers survived the replacement.
      const workingAfterText = useRewriteStore.getState().workingBody[nodeId] ?? '';
      const workingWithoutFreshFragment = replaceBetweenMarkers(workingAfterText, rewriteId, '');
      const rawFragment = extractSectionFromLLM(streamRes.rawText, target);
      const originalWebNumbers = new Set(
        [...originalSectionText.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])),
      );
      const presentOld = new Set(
        [...workingWithoutFreshFragment.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])),
      );
      // A source marker inside the replaced range is still valid when that
      // exact marker was present in the original range and survived the
      // model's rewrite. Do not accept an arbitrary old number merely because
      // the model copied it from some other part of the node.
      for (const match of rawFragment.matchAll(/⟦(\d+)⟧/g)) {
        const n = Number(match[1]);
        if (originalWebNumbers.has(n)) presentOld.add(n);
      }
      const oldSources = (cur.sources ?? []).filter((s) => presentOld.has(s.n));
      const priorCtx = aggregatePartialCitationContexts(nodeId);
      const priorNewSources = priorCtx.newSources.filter((s) => presentOld.has(s.n));
      const knownSources = [...oldSources, ...priorNewSources];
      const knownUrls = new Set(knownSources.map((s) => s.url));
      const markerNumbers = [...workingWithoutFreshFragment.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1]));
      const maxUsedN = [...knownSources.map((s) => s.n), ...markerNumbers]
        .reduce((max, n) => Math.max(max, n), 0);
      const newCitations = streamRes.citations.filter((c) => c.url && !knownUrls.has(c.url));
      const newSources = buildSources(newCitations).map((s) => ({ ...s, n: s.n + maxUsedN }));
      const citedRawFragment = newSources.length
        ? placeCitationMarkersReliable(rawFragment, newCitations, newSources, 'fragment-end')
        : rawFragment;
      const normalizedFragment = normalizeInternalCitationTokens(
        citedRawFragment,
        streamRes.sourcePassages,
      );
      finalFragment = normalizedFragment.body;
      {
        const current = useRewriteStore.getState().workingBody[nodeId] ?? '';
        useRewriteStore.getState().setWorkingBody(
          nodeId, replaceBetweenMarkers(current, rewriteId, finalFragment),
        );
      }
      const originalInternalNumbers = new Set(
        [...originalSectionText.matchAll(/\((\d+)\)/g)].map((match) => Number(match[1])),
      );
      const presentInternalNumbers = new Set(
        [...workingWithoutFreshFragment.matchAll(/\((\d+)\)/g)].map((match) => Number(match[1])),
      );
      for (const match of finalFragment.matchAll(/\((\d+)\)/g)) {
        const n = Number(match[1]);
        if (originalInternalNumbers.has(n)) presentInternalNumbers.add(n);
      }
      const existingInternal = [...(cur.internalSources ?? []), ...priorCtx.internalSources]
        .filter((source, index, all) => presentInternalNumbers.has(source.n)
          && all.findIndex((candidate) => candidate.sourceId === source.sourceId
            && candidate.revisionId === source.revisionId
            && candidate.passageId === source.passageId) === index);
      const internalOffset = existingInternal.reduce((max, source) => Math.max(max, source.n), 0);
      const freshInternal = pruneInternalSources(finalFragment, normalizedFragment.sources)
        .map((source) => ({ ...source, n: source.n + internalOffset }));
      if (freshInternal.length && internalOffset > 0) {
        finalFragment = finalFragment.replace(/\((\d+)\)/g, (token, digits: string) => (
          normalizedFragment.sources.some((source) => source.n === Number(digits))
            ? `(${Number(digits) + internalOffset})`
            : token
        ));
        const current = useRewriteStore.getState().workingBody[nodeId] ?? '';
        useRewriteStore.getState().setWorkingBody(
          nodeId, replaceBetweenMarkers(current, rewriteId, finalFragment),
        );
      }
      const citationCtx: RewriteCitationCtx = {
        googleSearchSuggestions: mergeGoogleSearchSuggestions(oldSources.length ? cur.googleSearchSuggestions : undefined, streamRes.googleSearchSuggestions),
        oldSources,
        newSources,
        internalSources: [...existingInternal, ...freshInternal],
        limitedSourceSearchReason: streamRes.limitedSourceSearchReason,
        webSearchRequested: streamRes.webSearchRequested,
        webSearchUsed: streamRes.webSearchUsed,
        webSearchError: streamRes.webSearchError,
      };
      setPartialCitationContext(nodeId, rewriteId, citationCtx);

      // Pass 2 — mark terms in ONLY the freshly-expanded fragment (not the
      // whole body). `generating` stays true (finishRewrite clears it below).
      // The fragment is untouched while the marking streams; the validated
      // chip-marked fragment is spliced in ONE shot below. retryArgs is
      // restored so Retry replays the expand, not the chip pass. On abort,
      // streamChipPass returns the plain fragment — the expansion is kept,
      // just unmarked.
      const savedRetry = retryArgs.get(nodeId);
      const chippedFragment = await streamChipPass({
        nodeId,
        projId: useGraphStore.getState().activeProjectId,
        plainBody: finalFragment,
        signal: controller.signal,
      });
      {
        const cur = useRewriteStore.getState().workingBody[nodeId] ?? '';
        useRewriteStore.getState().setWorkingBody(
          nodeId, replaceBetweenMarkers(cur, rewriteId, chippedFragment),
        );
      }
      if (savedRetry) retryArgs.set(nodeId, savedRetry);
      // Remove just THIS rewrite's markers — the streamed content
      // stays in place. Other partials' markers (if any) remain
      // active.
      const wbNow = useRewriteStore.getState().workingBody[nodeId] ?? '';
      useRewriteStore.getState().setWorkingBody(nodeId, removeMarkers(wbNow, rewriteId));
      const finalWorking = useRewriteStore.getState().workingBody[nodeId] ?? '';
      const presentNumbers = new Set(
        [...finalWorking.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])),
      );
      const aggregateCtx = aggregatePartialCitationContexts(nodeId);
      const committedSources = [...aggregateCtx.oldSources, ...aggregateCtx.newSources]
        .filter((s) => presentNumbers.has(s.n));
      const result = finishRewrite(nodeId, rewriteId, 'completed', {
        ...meta,
        sources: committedSources.length ? committedSources : undefined,
        googleSearchSuggestions: aggregateCtx.googleSearchSuggestions,
        internalSources: aggregateCtx.internalSources.length ? aggregateCtx.internalSources : undefined,
        sourceLimitation: aggregateCtx.limitedSourceSearchReason ? {
          kind: 'limited-search', message: 'Limited source search', reason: aggregateCtx.limitedSourceSearchReason,
        } : undefined,
        webSearched: aggregateCtx.webSearchUsed ? true : undefined,
        webSearchFailed: aggregateCtx.webSearchRequested && !aggregateCtx.webSearchUsed ? true : undefined,
      });
      if (result?.committed) {
        finalizeRewriteCitations(nodeId, result.versionIndex, aggregateCtx);
        partialCitationContexts.delete(nodeId);
        completeGenerationSession(nodeId);
      } else if (result && !result.committed) {
        partialCitationContexts.delete(nodeId);
      }
    } catch (e) {
      const outcome: FinishOutcome = controller.signal.aborted ? 'aborted' : 'errored';
      if (outcome === 'errored') {
        let current = useRewriteStore.getState().workingBody[nodeId] ?? '';
        if (!fragmentTextReceived) {
          current = replaceBetweenMarkers(current, rewriteId, originalSectionText);
        }
        // This failed record no longer owns its delimiters. Keep whatever the
        // model managed to write, or the restored source fragment when it
        // wrote nothing, while other partials continue independently.
        useRewriteStore.getState().setWorkingBody(nodeId, removeMarkers(current, rewriteId));
        setGenFlags(nodeId, {
          generationError: friendlyErrorMessage(e),
        });
      }
      const result = finishRewrite(nodeId, rewriteId, outcome, meta);
      if (result) partialCitationContexts.delete(nodeId);
    }
  } catch (e) {
    console.error('[scatter] expandPart failed:', e);
    throw e;
  }
}

/**
 * Translate stripped-body section bounds back to raw-body bounds,
 * accounting for any markers that precede or are inside the section.
 *
 * Concurrent partials may have left their own marker pairs in the
 * working body. We need to find the section's start/end in the RAW
 * working body so we know exactly where to insert THIS rewrite's
 * markers without disturbing other partials' content.
 *
 * Returns the raw start/end of the section (the indices to splice
 * around when inserting new markers), AND the section's text content
 * (markers removed). The text content is what `animateDeletionInto`
 * chews backwards through.
 */
export function translateBoundsToRaw(
  raw: string,
  strippedStart: number,
  strippedEnd: number,
): { rawStart: number; rawEnd: number; originalSectionText: string } {
  let rawIdx = 0;
  let strippedIdx = 0;
  let rawStart = -1;
  let rawEnd = -1;
  const PFX = 0xE001;
  while (rawIdx < raw.length) {
    const cp = raw.charCodeAt(rawIdx);
    if (cp === PFX) {
      // Skip an 11-char marker (PFX + 8 hex + suffix). If shorter
      // string remains, just consume one char to make progress.
      const skip = Math.min(10, raw.length - rawIdx);
      rawIdx += skip;
      continue;
    }
    if (rawStart === -1 && strippedIdx === strippedStart) rawStart = rawIdx;
    if (strippedIdx === strippedEnd) {
      rawEnd = rawIdx;
      break;
    }
    strippedIdx++;
    rawIdx++;
  }
  if (rawStart === -1 && strippedIdx === strippedStart) rawStart = rawIdx;
  if (rawEnd === -1) rawEnd = rawIdx;
  const originalSectionText = stripMarkers(raw.slice(rawStart, rawEnd));
  return { rawStart, rawEnd, originalSectionText };
}

// ───────────────────────────────────────────────────────────────────
// Public API: retry + small helpers
// ───────────────────────────────────────────────────────────────────

export async function retryGeneration(nodeId: string): Promise<void> {
  const args = retryArgs.get(nodeId);
  if (!args) return;
  await streamIntoVersion(nodeId, args.variant, args.parentIdForContext);

}

/**
 * Commit a manual "Edit text" editor session as a NEW version. Mirrors the
 * finishRewrite append pattern (clone → push → point index at the tail) but
 * with NO rewrite markers and NO AI chip pass — the user's own `[[ ]]` term
 * marks are kept verbatim. `generatedBy: 'manual'`.
 */
export function saveManualEdit(nodeId: string, header: string | HeaderParts, body: string, draftCreatedAt?: number): number | undefined {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node) return;
  const draftIndex = draftCreatedAt == null ? -1 : node.versions.findIndex(version => version.createdAt === draftCreatedAt);
  const cur = node.versions[draftIndex >= 0 ? draftIndex : node.currentVersionIndex]!;
  const parts = typeof header === 'string'
    ? normalizeHeaderParts({ subject: header })
    : normalizeHeaderParts(header);
  const flat = flattenHeaderParts(parts) || cur.header;
  const newVersion: NodeVersion = {
    header: flat,
    headerParts: parts,
    body,
    createdAt: draftIndex >= 0 ? cur.createdAt : nextTextVersionTimestamp(node),
    generatedBy: 'manual',
    // A manual edit keeps the node's bullet cap and content type unchanged.
    maxL1Bullets: cur.maxL1Bullets,
    contentType: currentContentType(node),
    ...(currentContentType(node) === 'answer' ? {
      markdownNote: cur.markdownNote,
      chat: cur.chat ? { ...cur.chat, title: flat, state: 'complete' as const } : undefined,
      width: cur.width, minWidth: cur.minWidth,
      bodyMaxHeight: cur.bodyMaxHeight, minBodyHeight: cur.minBodyHeight,
      sources: cur.sources?.filter((source) => body.includes(`⟦${source.n}⟧`)),
      internalSources: pruneInternalSources(body, cur.internalSources ?? []),
      webSearched: cur.webSearched,
    } : {}),
    selectedTextQuestion: parts.question,
  };
  const versions = [...node.versions];
  if (draftIndex >= 0) versions[draftIndex] = newVersion;
  else versions.push(newVersion);
  // One app-level undo step for the editing session; granular edits belong to
  // ProseMirror's local undo stack. Autosaves must not create a version per key.
  const history = useGraphStore.temporal.getState();
  const wasTracking = history.isTracking;
  if (draftIndex >= 0 && wasTracking) history.pause();
  try { useGraphStore.getState().updateNode(nodeId, { versions, currentVersionIndex: draftIndex >= 0 ? draftIndex : versions.length - 1 }); }
  finally { if (draftIndex >= 0 && wasTracking) history.resume(); }
  return newVersion.createdAt;
}
