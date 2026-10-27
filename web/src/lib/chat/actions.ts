import { normalizeLanguage, versionLanguage } from '../languages';
import { generationLanguagePrompt } from '../generationLanguage';
import { configuredPrompt } from '@/lib/configuredPrompt';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useChatRuntimeStore, getChatDraft, EMPTY_CHAT_DRAFT } from '@/store/useChatRuntimeStore';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { getActiveProvider } from '@/store/providerSelectors';
import { getAdapter, resolveBaseUrl, modelSupportsWebSearch } from '@/providers/registry';
import { newId } from '@/lib/ids';
import { spawnNearParent } from '@/lib/generate';
import { currentContentType } from '@/lib/nodeContentType';
import { isEditableImageMedia } from '@/lib/imageEditActions';
import { chatImageInput } from './imageInput';
import { snapshotSourcePolicy, retrieveProjectSources, formatSourceEvidenceBlock,
  type RetrievedSourcePassage } from '@/lib/sourceRetrieval';
import { normalizeInternalCitationTokens } from '@/lib/internalCitations';
import { waitForProjectSources } from '@/lib/sourceProcessing';
import { buildSources, extractInlineCitations, placeCitationMarkersReliable,
  renumberCitations, stripIncompleteCitationTail } from '@/lib/citations';
import type { Citation } from '@/providers/types';
import type { ChatAnswerRef, ChatAttachment, ChatMemory, ChatParentSnapshot, ChatQuestionReference } from '@/store/chatTypes';
import type { Arrow, FactCheckReport, ImageQuestionContext, NodeSource, NodeVersion, ScatterNode } from '@/store/types';
import { useNodeTextSelectionStore, type NodeTextSelection } from '@/store/useNodeTextSelectionStore';
import { chatSelectionReference } from './selectionReference';
import { createArrowSourceSelection } from '@/lib/sourceSelection';
import { prepareImageQuestion } from '@/lib/imageRegionInput';
import { secondaryTaskCompletion } from '@/lib/secondaryTaskCompletion';
import { appendChatAnswer, answerVersion, captureChatParent, chatInitialBodyHeight,
  conversationPath, createChatNode, CHAT_NODE_WIDTH, selectLatestChatAlternative, updateChatAnswer,
  removeLastChatTurn, forkChatConversation, validMemoryForPath } from './model';
import { chatAvailability } from './availability';
import { buildChatContext, chatSystemPrompt, estimateMessagesTokens, compactionPrefix,
  commitChatMemory, undoChatCompaction, chatCompactionBatches, estimateChatTokens } from './context';
import { runChatToolLoop } from './toolRuntime';
import { conversationSearchTool, warmChatRecall } from './recall';
import { enrichChatAnswer, ensureAnswerTerms } from './enrichment';
import { chatHasSourceCoverage } from './markdown';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';
import { shareAnswerEnrichment } from './sharedEnrichment';
import { mergeGoogleSearchSuggestions } from '@/lib/googleSearchSuggestions';
import { ProviderError } from '@/providers/errors';
import { generateTermPreviews } from '../termPreviews';
import { APPROX_HEADER_CHROME } from '../nodeSize';

const jobs = new Map<string, { controller: AbortController; kind: 'answer' | 'compact' }>();
const keyOf = (projectId: string, nodeId: string) => `${projectId}:${nodeId}`;
const abortError = () => new DOMException('Stopped', 'AbortError');
const freshTimestamp = (node: ScatterNode) => Math.max(Date.now(), ...node.versions.map((v) => v.createdAt + 1));
const contextBudgetError = (input: number, output: number, capacity: number) => new ProviderError(
  `The input (~${input.toLocaleString('en-US')} tokens) plus the requested output allowance (${output.toLocaleString('en-US')} tokens) does not fit safely in this model’s ${capacity.toLocaleString('en-US')}-token context window. Lower “Main generations” in Settings → Models and generation → Generation token limits, shorten or compact the conversation, or increase the loaded context size on your local server. Search tools and results also need space.`,
  { kind: 'context' },
);

export function startChat(parentId: string, origin: Partial<Pick<Arrow, 'sourceAnswer' | 'sourceSelection' | 'sourceImage'>> = {}): string | null {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) return null;
  const usableContext = currentContentType(parent) !== 'media'
    || isEditableImageMedia(parent.versions[parent.currentVersionIndex]?.media);
  const bodyHeight = chatInitialBodyHeight(typeof window === 'undefined' ? 900 : window.innerHeight);
  // Starting a chat never calls AI. Even a generating parent allows a draft.
  const node = createChatNode({ id: newId(), createdAt: Date.now(), parentNodeId: usableContext ? parentId : undefined,
    informationChunking: useSettingsStore.getState().defaultChatInformationChunking,
    groupId: parent.groupId, position: spawnNearParent(parent, Object.values(project.nodes), CHAT_NODE_WIDTH,
      bodyHeight + APPROX_HEADER_CHROME, origin.sourceImage?.regions), bodyHeight });
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: parentId, toNodeId: node.id,
    kind: 'auto', label: 'Chat', createdAt: Date.now(), ...origin });
  graph.setSelection([node.id]);
  graph.requestPanTo(node.id, parentId, 'newNodes');
  useChatRuntimeStore.getState().view(node.id, { composerFocusNonce: 1 });
  return node.id;
}

/** Preserve the exact first question; selection/image context is separate from user prose. */
export function startFollowUpChat(parentId: string, question: string, options: {
  selectedText?: NodeTextSelection; imageContext?: ImageQuestionContext; onSpawn?: () => void;
  language?: NodeVersion['language'];
} = {}): string {
  const project = useGraphStore.getState().project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) throw new Error('The source node is no longer available.');
  const selected = options.selectedText;
  const selectedVersion = selected?.nodeId === parentId ? parent.versions[selected.versionIndex] : undefined;
  const validSelection = selectedVersion?.body === selected?.sourceBody ? selected : undefined;
  const sourceVersion = parent.versions[validSelection?.versionIndex ?? parent.currentVersionIndex];
  // A routed follow-up can start while its source is still streaming. Freeze
  // the content visible now, rather than dropping the submitted question.
  const snapshot = captureChatParent({ ...parent, currentVersionIndex: validSelection?.versionIndex ?? parent.currentVersionIndex }, newId(), true);
  if (validSelection) snapshot.selectedText = validSelection.text;
  if (options.imageContext) {
    snapshot.imageContext = structuredClone(options.imageContext);
    snapshot.media = structuredClone(options.imageContext.sourceMedia);
  }
  // Selection is part of the immutable snapshot's identity, not only the full body.
  snapshot.fingerprint += JSON.stringify([snapshot.selectedText, snapshot.imageContext]);
  const id = startChat(parentId, {
    sourceSelection: validSelection ? createArrowSourceSelection(validSelection, sourceVersion!.createdAt) ?? undefined : undefined,
    sourceAnswer: sourceVersion?.chat ? { turnId: sourceVersion.chat.turnId, versionCreatedAt: sourceVersion.createdAt } : undefined,
    sourceImage: options.imageContext?.regions.length ? structuredClone(options.imageContext) : undefined,
  });
  if (!id) throw new Error('Could not create the follow-up chat.');
  useChatRuntimeStore.getState().setDraft(project.id, id, { text: question });
  options.onSpawn?.();
  void submitChat(id, { question, parentSnapshot: snapshot, language: options.language });
  return id;
}

/** Copy only the chosen answer, never the mutable conversation around it. */
export function spawnChatAnswer(nodeId: string, ref: ChatAnswerRef): string | null {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const parent = project?.nodes[nodeId];
  const original = parent && answerVersion(parent, ref);
  if (!project || !parent?.chat || !original?.chat || original.chat.state === 'generating' || !original.body.trim()) return null;
  const id = newId();
  const shared = shareAnswerEnrichment(original, original.answerEnrichmentId ?? `${project.id}:${nodeId}:${original.createdAt}`);
  // Derived metadata does not add an undo entry. Creating the copy is still one
  // ordinary structural edit. Missing enrichment resumes as shared background
  // work; completed marking/previews never need another request.
  updateGenNode(project.id, nodeId, { versions: parent.versions.map(version => version === original ? shared : version) });
  const copied = structuredClone(shared);
  copied.contentType = 'answer';
  copied.header = original.chat.title || original.header || original.chat.question;
  copied.headerParts = { subject: copied.header };
  copied.chat = { ...copied.chat!, turnId: id, contextPath: [], attachments: undefined,
    parentSnapshotId: undefined, reference: undefined, outlineParentTurnId: undefined, tools: undefined };
  copied.minBodyHeight = 120;
  copied.minWidth = 320;
  copied.bodyMaxHeight = Math.min(copied.bodyMaxHeight ?? 400,
    chatInitialBodyHeight(typeof window === 'undefined' ? 900 : window.innerHeight));
  const node: ScatterNode = { id, type: 'follow-up', currentVersionIndex: 0, versions: [copied],
    groupId: parent.groupId, position: spawnNearParent(parent, Object.values(project.nodes)), frozen: false };
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: nodeId, toNodeId: id, kind: 'auto',
    sourceAnswer: { ...ref }, label: original.chat.question || copied.header, createdAt: Date.now() });
  graph.setSelection([id]);
  graph.requestPanTo(id, nodeId, 'newNodes');
  void ensureAnswerTerms(project.id, id, { turnId: id, versionCreatedAt: copied.createdAt })
    .then(() => generateTermPreviews(id, copied.createdAt));
  return id;
}

export function activateChatAnswer(nodeId: string, ref: ChatAnswerRef): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  if (!node?.chat || !answerVersion(node, ref)) return;
  const runtime = useChatRuntimeStore.getState();
  const previous = runtime.views[nodeId]?.active;
  if (previous?.turnId === ref.turnId && previous.versionCreatedAt === ref.versionCreatedAt) return;
  // Answer selection is navigation, never an undo entry.
  useGraphStore.temporal.getState().pause();
  try { graph.updateNode(nodeId, { currentVersionIndex: node.versions.findIndex((v) => v.createdAt === ref.versionCreatedAt) }); }
  finally { useGraphStore.temporal.getState().resume(); }
  const previews = { ...runtime.views[nodeId]?.previews };
  if (previous?.turnId && previous.turnId !== ref.turnId) delete previews[previous.turnId];
  runtime.view(nodeId, { active: ref, previews });
  // The evidence display belongs to the explicitly checked answer, not the
  // answer nearest the top while scrolling through the conversation.
}

export function showChatAlternative(nodeId: string, ref: ChatAnswerRef): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  if (!node?.chat || !answerVersion(node, ref)) return;
  if (node.chat.turns.at(-1)?.id === ref.turnId && !node.generating) {
    // Changing the continuation alternative is a user content decision.
    graph.updateNode(nodeId, selectLatestChatAlternative(node, ref));
  } else {
    const runtime = useChatRuntimeStore.getState();
    runtime.view(nodeId, { previews: { ...runtime.views[nodeId]?.previews, [ref.turnId]: ref.versionCreatedAt } });
  }
  activateChatAnswer(nodeId, ref);
}

export function editLastChatQuestion(nodeId: string): void {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  const last = node && conversationPath(node).at(-1);
  const answer = node && last && answerVersion(node, last);
  if (!project || !answer?.chat || node?.generating) return;
  const old = getChatDraft(project.id, nodeId);
  useChatRuntimeStore.getState().setDraft(project.id, nodeId, {
    text: answer.chat.question, reference: answer.chat.reference, attachments: answer.chat.attachments, editingTurnId: answer.chat.turnId,
    previousDraft: old.editingTurnId ? old.previousDraft : { text: old.text, reference: old.reference, attachments: old.attachments },
  });
  useChatRuntimeStore.getState().jumpTo(nodeId);
  focusChatComposer(nodeId);
}
function focusChatComposer(nodeId: string): void {
  const runtime = useChatRuntimeStore.getState();
  runtime.view(nodeId, { composerFocusNonce: (runtime.views[nodeId]?.composerFocusNonce ?? 0) + 1 });
}
export function cancelChatEdit(nodeId: string): void {
  const project = useGraphStore.getState().project;
  if (!project) return;
  const draft = getChatDraft(project.id, nodeId);
  useChatRuntimeStore.getState().setDraft(project.id, nodeId, draft.previousDraft ?? EMPTY_CHAT_DRAFT);
}
export function askAboutChatAnswer(nodeId: string, ref: ChatAnswerRef): void {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  const answer = node && answerVersion(node, ref);
  if (!project || !answer?.chat) return;
  const draft = getChatDraft(project.id, nodeId);
  const selected = draft.reference?.turnId === ref.turnId && draft.reference.versionCreatedAt === ref.versionCreatedAt;
  useChatRuntimeStore.getState().setDraft(project.id, nodeId,
    { ...draft, reference: selected ? undefined : { ...ref, title: answer.chat.question || answer.chat.title } });
  focusChatComposer(nodeId);
}

export function stopChat(nodeId: string): void {
  const projectId = useGraphStore.getState().project?.id;
  if (projectId) jobs.get(keyOf(projectId, nodeId))?.controller.abort();
}

export async function submitChat(nodeId: string, options: {
  regenerate?: boolean; question?: string; reference?: ChatQuestionReference; evidence?: FactCheckReport;
  skipPendingSources?: boolean;
  parentSnapshot?: ChatParentSnapshot;
  language?: NodeVersion['language'];
} = {}): Promise<void> {
  const graph = useGraphStore.getState();
  const project = graph.project;
  let node = project?.nodes[nodeId];
  if (!project || !node?.chat || jobs.has(keyOf(project.id, nodeId))) return;
  const runtime = useChatRuntimeStore.getState();
  const draft = getChatDraft(project.id, nodeId);
  const lastRef = conversationPath(node).at(-1);
  if (!options.regenerate && draft.editingTurnId && draft.editingTurnId !== lastRef?.turnId) {
    runtime.setDraft(project.id, nodeId, { text: draft.text, reference: draft.reference, attachments: draft.attachments });
    runtime.view(nodeId, { error: 'That message is no longer the latest turn. Your text is kept as a new draft.' });
    return;
  }
  const previous = lastRef && answerVersion(node, options.evidence
    ? { ...lastRef, versionCreatedAt: options.evidence.versionCreatedAt } : lastRef);
  if (options.evidence && (!previous || !options.evidence.complete
    || options.evidence.bodyFingerprint !== factCheckBodyFingerprint(previous))) {
    runtime.view(nodeId, { error: 'This evidence no longer matches the selected latest answer. Check it again, or fork from the checked answer.' });
    return;
  }
  const regenerate = !!options.regenerate || !!draft.editingTurnId;
  const question = (options.question ?? (options.regenerate ? previous?.chat?.question : draft.text) ?? '').trim();
  const attachments = options.regenerate ? previous?.chat?.attachments : draft.attachments;
  if ((!question && !attachments?.length) || (regenerate && !lastRef)) return;
  const parent = node.chat.parentNodeId ? project.nodes[node.chat.parentNodeId] : undefined;
  const availability = chatAvailability(options.parentSnapshot ? undefined : parent);
  if (!availability.available) { runtime.view(nodeId, { error: availability.reason }); return; }
  const evidencePanel = useCitationPanelStore.getState();
  if (evidencePanel.nodeId === nodeId && evidencePanel.mode === 'fact-check') evidencePanel.close();
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings)!;
  const model = settings.activeModelRef!.model;
  const config = { provider, model, output: settings.outputTokenCap, reasoning: settings.reasoningEffort,
    web: settings.webSearch && modelSupportsWebSearch(provider.preset, model,
      useModelCatalogStore.getState().getModel(provider.id, model), provider.webSearchEndpoint, provider.serverSearch, settings.modelCompatibilityOverrides?.main), normal: settings.normalChatInstructions ?? '' };
  const snapshot = snapshotSourcePolicy(project, { includePending: !options.skipPendingSources });
  if (options.evidence) snapshot.mode = 'ignore';
  const reference = options.reference ?? (options.regenerate ? previous?.chat?.reference
    : chatSelectionReference(node, useNodeTextSelectionStore.getState().selection) ?? draft.reference);
  const createdAt = freshTimestamp(node);
  const ref = { turnId: regenerate ? lastRef!.turnId : newId(), versionCreatedAt: createdAt };
  const previousParent = previous?.chat?.parentSnapshotId ? node.chat.parentSnapshots[previous.chat.parentSnapshotId] : undefined;
  node = appendChatAnswer(node, { turnId: ref.turnId, createdAt, question, replaceLatest: regenerate,
    parentSnapshot: options.parentSnapshot ?? (options.regenerate && (previousParent?.selectedText || previousParent?.imageContext)
      ? previousParent
      : parent ? captureChatParent(parent, newId()) : undefined),
    metadata: { providerId: provider.id, reference, attachments, sourceMode: snapshot.mode, activeSourceIds: snapshot.sourceIds,
      ...(options.evidence ? { informationChunking: previous?.chat?.informationChunking } : {}) } });
  const language = options.evidence ? versionLanguage(previous) : normalizeLanguage(options.language ?? settings.generationLanguage);
  node = updateChatAnswer(node, ref, { modelUsed: model, language });
  const controller = new AbortController();
  const jobKey = keyOf(project.id, nodeId);
  jobs.set(jobKey, { controller, kind: 'answer' });
  // Exactly one undo entry: create the provisional paired question/answer.
  graph.updateNode(nodeId, node);
  const unsubscribe = useGraphStore.subscribe((state) => {
    if (state.project?.id !== project.id || !state.project.nodes[nodeId]
      || !answerVersion(state.project.nodes[nodeId]!, ref)) controller.abort();
  });
  const timeout = setTimeout(() => controller.abort(new Error('The answer timed out.')), 10 * 60_000);
  runtime.view(nodeId, { error: undefined, activity: 'Working', active: ref });
  runtime.jumpTo(nodeId);
  runtime.setDraft(project.id, nodeId, draft.editingTurnId ? draft.previousDraft ?? EMPTY_CHAT_DRAFT : EMPTY_CHAT_DRAFT);
  const lane = `chat-answer-${createdAt}`;
  const status = (text: string) => {
    runtime.view(nodeId, { activity: text });
    useNodeStatusStore.getState().setProcessStatus(nodeId, lane, text.toUpperCase());
  };
  const commit = (patch: Partial<NodeVersion>, metadata?: Parameters<typeof updateChatAnswer>[3]) => {
    const current = getGenProject(project.id)?.nodes[nodeId];
    if (!current || !answerVersion(current, ref)) { controller.abort(); return; }
    updateGenNode(project.id, nodeId, updateChatAnswer(current, ref, patch, metadata));
  };
  let raw = '';
  let citations: Citation[] = [];
  let passages: RetrievedSourcePassage[] = [];
  const evidenceSources: NodeSource[] = [];
  if (options.evidence) for (const unit of options.evidence.units) for (const item of unit.finding?.evidence ?? []) {
    if (!evidenceSources.some((source) => source.url === item.url)) evidenceSources.push({
      n: evidenceSources.length + 1, url: item.url, title: item.title, domain: item.domain,
    });
  }
  const evidenceSuggestions = mergeGoogleSearchSuggestions(...(options.evidence?.units.map(unit => unit.finding?.googleSearchSuggestions) ?? []));
  const evidencePrompt = options.evidence ? configuredPrompt('chatFactRewrite', {
    evidenceReport: JSON.stringify({ ...options.evidence, units: options.evidence.units.map(unit => ({ ...unit,
      finding: unit.finding ? { ...unit.finding, googleSearchSuggestions: undefined } : undefined })) }),
    sourceCatalog: evidenceSources.map((source) => `⟪E${source.n}⟫ ${source.url}`).join('\n'),
  }) : '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const display = () => {
    flushTimer = undefined;
    const clean = stripIncompleteCitationTail(raw, citations);
    if (options.evidence) {
      const used = new Set<number>();
      const body = clean.replace(/⟪E(\d+)⟫/g, (_, n: string) => {
        const number = Number(n);
        if (!evidenceSources.some((source) => source.n === number)) return '';
        used.add(number); return `⟦${number}⟧`;
      });
      const normalized = renumberCitations(body, evidenceSources.filter((source) => used.has(source.n)));
      commit({ body: normalized.body, sources: normalized.sources, internalSources: [], googleSearchSuggestions: evidenceSuggestions });
      return;
    }
    const internal = normalizeInternalCitationTokens(clean, passages);
    // Citation offsets always apply to the original provider string, before
    // replacing internal IDs or adding term markers.
    const sourceList = buildSources([...citations, ...extractInlineCitations(clean)]);
    const placed = placeCitationMarkersReliable(clean, citations, sourceList, 'message-end');
    const combined = normalizeInternalCitationTokens(placed, passages);
    const web = renumberCitations(combined.body, sourceList, internal.sources.length + 1, true);
    commit({ body: web.body, internalSources: combined.sources, sources: web.sources });
  };
  try {
    status('Working');
    if (snapshot.mode !== 'ignore') {
      if (snapshot.pendingJobIds.length) {
        status('Waiting for sources');
        await waitForProjectSources(project.id, snapshot.pendingJobIds, controller.signal);
        const loaded = getGenProject(project.id);
        for (const source of Object.values(loaded?.sourceLibrary?.sources ?? {})) {
          if (!snapshot.sourceIds.includes(source.id)
            && (snapshot.pendingSourceIds.includes(source.id) || snapshot.pendingUrls.includes(source.originalUrl ?? ''))) {
            snapshot.sourceIds.push(source.id); snapshot.revisionIds.push(source.activeRevisionId);
          }
        }
      }
      if (controller.signal.aborted) throw abortError();
      status('Searching sources');
      const result = await retrieveProjectSources({ project: getGenProject(project.id) ?? project,
        snapshot, query: question, signal: controller.signal });
      passages = result.passages;
      if (result.limitedReason) commit({ sourceLimitation: { kind: 'limited-search',
        message: 'Limited source search', reason: result.limitedReason } });
      if (snapshot.mode === 'only' && !passages.length) {
        raw = 'Not enough information in the active sources to answer in Sources only mode. Try Use sources, or add relevant sources.';
        display();
        commit({}, { state: 'complete', completedAt: Date.now() });
        return;
      }
    }
    let current = getGenProject(project.id)?.nodes[nodeId];
    let answer = current && answerVersion(current, ref);
    if (!current?.chat || !answer?.chat) throw abortError();
    const build = () => options.evidence ? { messages: [
      { role: 'system' as const, content: chatSystemPrompt(answer!.chat!.informationChunking, config.normal, false) + '\n\n' + generationLanguagePrompt(language) },
      { role: 'user' as const, content: `${evidencePrompt}\n\nQUESTION:\n${question}\n\nORIGINAL ANSWER:\n${previous?.body ?? ''}` },
    ], imageSnapshots: new Map<number, ChatParentSnapshot>(), attachmentImages: new Map<number, ChatAttachment[]>() } : buildChatContext({ node: current!, answer: answer!,
      system: chatSystemPrompt(answer!.chat!.informationChunking, config.normal, config.web && snapshot.mode !== 'only') + '\n\n' + generationLanguagePrompt(language),
      evidence: [snapshot.mode !== 'ignore' ? formatSourceEvidenceBlock(snapshot.mode, passages) : '',
        evidencePrompt].filter(Boolean).join('\n\n') });
    runtime.view(nodeId, { sourceTokens: snapshot.mode === 'ignore' ? 0 : estimateChatTokens(formatSourceEvidenceBlock(snapshot.mode, passages)) });
    let context = build();
    const capacity = useModelCatalogStore.getState().getModel(provider.id, model)?.contextLength;
    const estimated = () => estimateMessagesTokens(context.messages)
      + (context.imageSnapshots.size + [...context.attachmentImages.values()].reduce((sum, items) => sum + items.length, 0)) * 2300;
    if (!options.evidence && capacity && estimated() + config.output > capacity * 0.85) {
      const prefix = answer.chat.contextPath.slice(0, Math.max(0, answer.chat.contextPath.length - 1));
      if (prefix.length) {
        runtime.view(nodeId, { compacting: true }); status('Compacting conversation');
        const memory = await summarizeChatPrefix(current, prefix, controller.signal);
        if (controller.signal.aborted) throw abortError();
        const latest = getGenProject(project.id)?.nodes[nodeId];
        if (!latest) throw abortError();
        current = commitChatMemory(latest, memory);
        if (current.chat) current = { ...current, chat: { ...current.chat,
          compactions: current.chat.compactions.map((entry) => entry.memory.id === memory.id
            ? { ...entry, consumedAt: createdAt } : entry) } };
        updateGenNode(project.id, nodeId, current);
        answer = answerVersion(current, ref)!;
        context = build(); runtime.view(nodeId, { compacting: false });
      }
    }
    for (const [index, parentSnapshot] of context.imageSnapshots) {
      if (parentSnapshot.imageContext) {
        const prepared = await prepareImageQuestion(project.id, parentSnapshot.imageContext, controller.signal);
        context.messages[index]!.content += '\n\n' + prepared.instructions;
        context.messages[index]!.images = prepared.images;
        continue;
      }
      const url = await chatImageInput(project.id, parentSnapshot.media);
      if (url) context.messages[index]!.images = [{ id: parentSnapshot.id, url, detail: 'high' }];
    }
    for (const [index, images] of context.attachmentImages) {
      context.messages[index]!.images = await Promise.all(images.map(async (item) => ({
        id: item.id, url: (await chatImageInput(project.id, item.media))!, detail: 'high' as const,
      })));
    }
    if (capacity && estimateMessagesTokens(context.messages) + config.output > capacity * 0.92) {
      throw contextBudgetError(estimateMessagesTokens(context.messages), config.output, capacity);
    }
    const recallPath = [...answer.chat!.contextPath];
    if (reference && !recallPath.some((item) => item.turnId === reference.turnId && item.versionCreatedAt === reference.versionCreatedAt)) recallPath.push(reference);
    const tools = !options.evidence && (current.chat?.memory || reference) ? [conversationSearchTool(current, recallPath)] : [];
    if (tools.length) void warmChatRecall(current, recallPath);
    status('Working');
    await runChatToolLoop({ messages: context.messages, tools, signal: controller.signal,
      invoke: (messages, definitions) => {
        if (capacity && estimateMessagesTokens(messages) + config.output > capacity * 0.97) {
          throw contextBudgetError(estimateMessagesTokens(messages), config.output, capacity);
        }
        return getAdapter(provider.preset).streamChat(provider.apiKey, {
        model, messages: [], conversation: messages, tools: definitions,
        maxOutputTokens: config.output, reasoningEffort: config.reasoning,
        modelInfo: useModelCatalogStore.getState().getModel(provider.id, model),
        webSearch: config.web && snapshot.mode !== 'only' && !options.evidence,
        webSearchEndpoint: provider.webSearchEndpoint,
        serverSearch: provider.serverSearch,
        allowUnverifiedCapabilities: settings.modelCompatibilityOverrides?.main,
        signal: controller.signal,
      }, resolveBaseUrl(provider.preset, provider.baseUrl)); },
      onChunk: (chunk) => {
        if (chunk.googleSearchSuggestions?.length) {
          const live = getGenProject(project.id)?.nodes[nodeId];
          const existing = live && answerVersion(live, ref)?.googleSearchSuggestions;
          commit({ googleSearchSuggestions: mergeGoogleSearchSuggestions(existing, chunk.googleSearchSuggestions) });
        }
        if (chunk.citations) citations = [...citations, ...chunk.citations];
        if (chunk.webSearch?.used) commit({ webSearched: true });
        if (chunk.webSearch?.error) commit({ webSearchFailed: true });
        if (chunk.delta) { raw += chunk.delta; status('Writing'); }
        if (!flushTimer) flushTimer = setTimeout(display, 45);
      },
      onActivity: (activity) => {
        const latest = getGenProject(project.id)?.nodes[nodeId];
        const answer = latest && answerVersion(latest, ref);
        const list = answer?.chat?.tools ?? [];
        commit({}, { tools: [...list.filter((item) => item.id !== activity.id), activity] });
        if (activity.state === 'running') status(activity.summary);
        else if (activity.state !== 'stopped') status('Working');
      },
    });
    if (controller.signal.aborted) throw abortError();
    if (!raw.trim()) throw new Error('The model returned no answer. Try again.');
    if (snapshot.mode === 'only') {
      const valid = new Set(passages.map((passage) => passage.evidenceId));
      if (!chatHasSourceCoverage(raw, valid)) {
        status('Checking source citations');
        let repaired = '';
        for await (const chunk of getAdapter(provider.preset).streamChat(provider.apiKey, {
          model, messages: [{ role: 'system', content: `${configuredPrompt('chatSourceRepair')}\n\n${configuredPrompt('proseLineBoundaries')}` },
            { role: 'user', content: `${raw}\n\n${formatSourceEvidenceBlock('only', passages)}` }],
          maxOutputTokens: config.output, webSearch: false, reasoningEffort: config.reasoning, signal: controller.signal,
          modelInfo: useModelCatalogStore.getState().getModel(provider.id, model),
        }, resolveBaseUrl(provider.preset, provider.baseUrl))) { repaired += chunk.delta; if (chunk.done) break; }
        if (!chatHasSourceCoverage(repaired, valid)) {
          raw = 'Sources only: Not enough information in the active sources to provide a fully traceable answer. Try Use sources, or add relevant sources.';
        } else raw = repaired;
      }
    }
    display();
    commit({}, { state: 'complete', completedAt: Date.now() });
    // Optional metadata runs alongside subsequent conversation, never blocks
    // Send and never selects/renames a different answer.
    void enrichChatAnswer(project.id, nodeId, ref, AbortSignal.timeout(180_000));
  } catch (error) {
    if (flushTimer) clearTimeout(flushTimer);
    display();
    const abortReason = controller.signal.reason;
    const timeoutMessage = controller.signal.aborted && abortReason instanceof Error && abortReason.name !== 'AbortError'
      ? abortReason.message : undefined;
    const stopped = controller.signal.aborted && !timeoutMessage;
    const message = timeoutMessage ?? (stopped ? undefined : error instanceof Error ? error.message : 'The answer could not be completed.');
    commit({}, { state: stopped ? 'stopped' : 'interrupted', error: message });
    const currentDraft = getChatDraft(project.id, nodeId);
    runtime.setDraft(project.id, nodeId, { text: question, reference, attachments, editingTurnId: ref.turnId,
      previousDraft: currentDraft.text || currentDraft.reference || currentDraft.attachments?.length ? currentDraft : undefined });
    runtime.view(nodeId, { error: message });
  } finally {
    unsubscribe(); clearTimeout(timeout);
    if (flushTimer) clearTimeout(flushTimer);
    if (jobs.get(jobKey)?.controller === controller) jobs.delete(jobKey);
    const current = getGenProject(project.id)?.nodes[nodeId];
    if (current && answerVersion(current, ref)) updateGenNode(project.id, nodeId, {
      generating: false, generatingVersionIndex: undefined, streamingText: false,
    });
    runtime.view(nodeId, { activity: undefined, compacting: false });
    useNodeStatusStore.getState().clearProcessStatus(nodeId, lane);
  }
}

export async function summarizeChatPrefix(node: ScatterNode, prefix: ChatAnswerRef[], signal: AbortSignal,
  complete = secondaryTaskCompletion): Promise<ChatMemory> {
  let summary = validMemoryForPath(node.chat!, prefix)?.summary ?? '';
  for (const batch of chatCompactionBatches(node, prefix)) {
    if (signal.aborted) throw abortError();
    summary = await complete({
      system: configuredPrompt('chatCompaction'),
      user: configuredPrompt('chatCompactionTask', { memory: summary, transcript: batch }), maxOutputTokens: 2400, signal,
    });
  }
  if (!summary.trim()) throw new Error('The model returned no usable conversation memory.');
  return { id: newId(), summary, coveredPath: prefix, createdAt: Date.now() };
}

export async function compactChat(nodeId: string): Promise<boolean> {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  if (!project || !node?.chat || node.generating || jobs.has(keyOf(project.id, nodeId))) return false;
  const prefix = compactionPrefix(node);
  if (!prefix.length) return false;
  const controller = new AbortController();
  jobs.set(keyOf(project.id, nodeId), { controller, kind: 'compact' });
  const unsubscribe = useGraphStore.subscribe((state) => {
    const current = state.project?.id === project.id ? state.project.nodes[nodeId] : undefined;
    if (!current?.chat || prefix.some((ref) => !answerVersion(current, ref))) controller.abort();
  });
  const timeout = setTimeout(() => controller.abort(new Error('Compaction timed out. Your previous context is unchanged.')), 5 * 60_000);
  const runtime = useChatRuntimeStore.getState();
  runtime.view(nodeId, { compacting: true, error: undefined });
  useNodeStatusStore.getState().setProcessStatus(nodeId, 'chat-compact', 'COMPACTING CONVERSATION');
  try {
    const memory = await summarizeChatPrefix(node, prefix, controller.signal);
    if (controller.signal.aborted) return false;
    const current = useGraphStore.getState().project?.id === project.id
      ? useGraphStore.getState().project?.nodes[nodeId] : undefined;
    if (!current) return false;
    const next = commitChatMemory(current, memory);
    if (next === current) return false;
    useGraphStore.getState().updateNode(nodeId, next);
    void warmChatRecall(next, conversationPath(next));
    return true;
  } catch (error) {
    const reason = controller.signal.reason;
    if (!controller.signal.aborted || (reason instanceof Error && reason.name !== 'AbortError')) {
      runtime.view(nodeId, { error: controller.signal.aborted ? reason.message : error instanceof Error ? error.message : 'Compaction failed.' });
    }
    return false;
  } finally {
    unsubscribe(); clearTimeout(timeout);
    jobs.delete(keyOf(project.id, nodeId));
    runtime.view(nodeId, { compacting: false });
    useNodeStatusStore.getState().clearProcessStatus(nodeId, 'chat-compact');
  }
}
export function reverseChatCompaction(nodeId: string): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  if (node && !node.generating) graph.updateNode(nodeId, undoChatCompaction(node));
}
export function deleteLastChatTurn(nodeId: string): void {
  const graph = useGraphStore.getState();
  const node = graph.project?.nodes[nodeId];
  if (!node?.chat || node.generating) return;
  const runtime = useChatRuntimeStore.getState();
  const old = runtime.views[nodeId];
  const next = removeLastChatTurn(node);
  const active = old?.active && answerVersion(next, old.active) ? old.active : conversationPath(next).at(-1);
  if (active) next.currentVersionIndex = next.versions.findIndex((version) => version.createdAt === active.versionCreatedAt);
  graph.updateNode(nodeId, next);
  runtime.view(nodeId, { active, previews: Object.fromEntries(Object.entries(old?.previews ?? {})
    .filter(([turnId, versionCreatedAt]) => !!answerVersion(next, { turnId, versionCreatedAt }))) });
  const panel = useCitationPanelStore.getState();
  if (panel.nodeId === nodeId && panel.mode === 'fact-check'
    && !next.versions.some(version => version.createdAt === panel.factVersionCreatedAt)) panel.close();
  const projectId = graph.project!.id;
  const draft = getChatDraft(projectId, nodeId);
  if (draft.editingTurnId === node.chat.turns.at(-1)?.id) runtime.setDraft(projectId, nodeId, draft.previousDraft ?? EMPTY_CHAT_DRAFT);
}
export function forkChat(nodeId: string, ref: ChatAnswerRef): string | null {
  const graph = useGraphStore.getState();
  const project = graph.project;
  const source = project?.nodes[nodeId];
  if (!project || !source?.chat || source.generating) return null;
  const { node: next, turnIds } = forkChatConversation(source, ref, newId(), newId);
  next.position = spawnNearParent(source, Object.values(project.nodes));
  const references = Object.values(project.arrows).filter((arrow) => arrow.fromNodeId === nodeId
    && arrow.sourceAnswer && turnIds.has(arrow.sourceAnswer.turnId) && project.nodes[arrow.toNodeId])
    .map((arrow) => ({ ...structuredClone(arrow), id: newId(), fromNodeId: next.id,
      kind: 'dotted' as const, gravitates: false, anchors: undefined, createdAt: Date.now(),
      sourceAnswer: { ...arrow.sourceAnswer!, turnId: turnIds.get(arrow.sourceAnswer!.turnId)! } }));
  graph.addNodeWithArrow(next, { id: newId(), kind: 'auto', fromNodeId: source.id,
    toNodeId: next.id, label: 'Fork', sourceAnswer: ref, createdAt: Date.now() }, references);
  graph.setSelection([next.id]);
  graph.requestPanTo(next.id, source.id, 'newNodes');
  return next.id;
}
