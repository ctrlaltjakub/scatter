import { normalizeLanguage, versionLanguage } from './languages';
import { generationLanguagePrompt } from './generationLanguage';
import { useGraphStore } from '@/store/useGraphStore';
import { normalizeGenerationLimit } from './generationLimits';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { getProviderById } from '@/store/providerSelectors';
import { getAdapter, resolveBaseUrl } from '@/providers/registry';
import type { ProviderConversationMessage, TextToolDefinition } from '@/providers/types';
import type { InteractiveBuild, NodeVersion, Project, ScatterNode } from '@/store/types';
import { beginGenerationSession, cancelGenerationSession, finishGenerationSession, getGenerationSession, markGenerationTextReceived, registerGenerationController } from './generationSession';
import { newId } from './ids';
import { spawnNearParent } from './generate';
import { resolveInteractiveModel } from './interactiveModel';
import { configuredPrompt } from './configuredPrompt';
import { isStandaloneInteractive } from './nodeContentType';
import { INTERACTIVE_NODE_W } from './nodeSize';
import { readInteractiveTheme } from './interactiveTheme';
import { InteractiveBuildLimitError, InteractiveVerificationError, type InteractiveStep } from './interactiveHarness';
import { interactiveNeedsVerification, interactivePendingIssues } from './interactiveRetry';
import { interactiveSourceContext, runInteractiveWorkflow } from './interactiveWorkflow';
import { checkInteractiveDocument } from './interactiveProbe';
import { resolveCaps } from './modelMeta';
import { INTERACTIVE_TOOL_ARGUMENT_LIMITS, preferredInteractiveViewport, validateInteractiveDocument } from './interactiveDocument';
import type { InteractiveProbeOptions, InteractiveTestAction } from './interactiveTests';

export function interactiveTools(): TextToolDefinition[] {
  const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const string = { type: 'string' };
  return [
    { name: 'read_document', description: configuredPrompt('interactiveReadTool'), parameters: object() },
    { name: 'write_document', description: configuredPrompt('interactiveWriteTool'), parameters: object({ html: string }, ['html']) },
    { name: 'edit_document', description: configuredPrompt('interactiveEditTool'), parameters: object({ search: string, replace: string }, ['search', 'replace']) },
    { name: 'check_document', description: configuredPrompt('interactiveCheckTool'), parameters: object({ actions: { type: 'array', maxItems: 6,
      items: object({ selector: string, action: { type: 'string', enum: ['click','input','press'] }, value: string }, ['selector','action']) } }) },
    { name: 'finish', description: configuredPrompt('interactiveFinishTool'), parameters: object() },
  ];
}

/** Settle captured build snapshots as well as the live node. Otherwise undoing
 * an unrelated action taken during a build can rewind completed code to a
 * spinner whose request has already finished. This adds no history entry. */
function settleBuildHistory(projectId: string, nodeId: string, version: NodeVersion): void {
  const settle = (project: Project | null): Project | null => {
    const node = project?.id === projectId ? project.nodes[nodeId] : undefined;
    if (!project || !node) return project;
    const index = node.versions.findIndex(v => v.createdAt === version.createdAt && v.interactiveBuild?.state === 'building');
    if (index < 0) return project;
    const settled = { ...node, versions: node.versions.map((v, i) => i !== index ? v : {
      ...v, header: version.header, headerParts: version.headerParts, body: version.body,
      interactive: version.interactive, interactiveBuild: version.interactiveBuild,
    }) };
    if (node.generatingVersionIndex === index) {
      settled.generating = false;
      settled.generatingVersionIndex = undefined;
      settled.generationError = version.interactiveBuild?.error;
    }
    return { ...project, nodes: { ...project.nodes, [nodeId]: settled } };
  };
  const history = useGraphStore.temporal.getState();
  useGraphStore.temporal.setState({
    pastStates: history.pastStates.map(state => state.project ? { ...state, project: settle(state.project) } : state),
    futureStates: history.futureStates.map(state => state.project ? { ...state, project: settle(state.project) } : state),
  });
}

/** Creating the node/arrow and building its content are separate undoable intents. */
export function spawnInteractiveNode(parentId: string, generate = false): string | null {
  const graph = useGraphStore.getState(); const project = graph.project;
  const parent = project?.nodes[parentId];
  if (!project || !parent) return null;
  const source = parent.versions[parent.currentVersionIndex];
  const id = newId();
  const node: ScatterNode = { id, type: 'interactive', frozen: false, groupId: parent.groupId,
    position: spawnNearParent(parent, Object.values(project.nodes), INTERACTIVE_NODE_W, 660), currentVersionIndex: 0,
    versions: [{ header: 'New interactive', body: '', createdAt: Date.now(), generatedBy: 'interactive',
      contentType: 'interactive', interactiveStandalone: true, width: INTERACTIVE_NODE_W }],
  };
  graph.addNodeWithArrow(node, { id: newId(), fromNodeId: parentId, toNodeId: id, kind: 'auto',
    sourceAnswer: source?.chat ? { turnId: source.chat.turnId, versionCreatedAt: source.createdAt } : undefined });
  graph.setSelection([id]); graph.requestPanTo(id, parentId, 'newNodes');
  if (generate) void buildInteractiveNode(id, source?.header ?? 'Interactive program', 'create');
  return id;
}

export function stopInteractiveBuild(nodeId: string): void {
  const graph = useGraphStore.getState();
  if (!graph.activeProjectId) return;
  cancelGenerationSession(graph.activeProjectId, nodeId);
  const node = graph.project?.nodes[nodeId]; if (!node) return;
  updateGenNode(graph.activeProjectId, nodeId, { generating: false, generatingVersionIndex: undefined,
    versions: node.versions.map(v => v.interactiveBuild?.state === 'building' ? { ...v, interactiveBuild: {
      ...v.interactiveBuild, state: 'stopped', steps: v.interactiveBuild.steps.map(s => s.state === 'running' ? { ...s, kind: undefined, state: 'failed', detail: 'Stopped' } : s),
    } } : v) });
  for (const version of getGenProject(graph.activeProjectId)?.nodes[nodeId]?.versions ?? []) {
    if (version.interactiveBuild?.state === 'stopped') settleBuildHistory(graph.activeProjectId, nodeId, version);
  }
  useNodeStatusStore.getState().clearStatus(nodeId);
}

/** Human approval is one undoable content change, with no model calls. */
export function acceptInteractiveDraft(nodeId: string, createdAt: number): boolean {
  const graph = useGraphStore.getState(), node = graph.project?.nodes[nodeId];
  const version = node?.versions[node.currentVersionIndex];
  const build = version?.interactiveBuild;
  if (!node || node.generating || !version || version.createdAt !== createdAt || version.interactive || !build?.draftHtml) return false;
  let html: string;
  try { html = validateInteractiveDocument(build.draftHtml); } catch { return false; }
  const preferred = preferredInteractiveViewport(html);
  graph.updateNode(nodeId, {
    generationError: undefined,
    versions: node.versions.map(v => v !== version ? v : { ...v,
      interactive: { html, request: build.request, providerId: build.providerId ?? '', model: build.model ?? '',
        viewportWidth: build.viewportWidth ?? preferred.width, viewportHeight: build.viewportHeight ?? preferred.height },
      interactiveBuild: { ...build, state: 'complete', acceptedByUser: true, draftHtml: undefined,
        error: undefined, limitReached: false, verificationPending: false },
    }),
  });
  return true;
}

/** Bounded build, with captured project/version ownership across deselection,
 * project switches, cancellation, undo, deletion, and concurrent nodes. */
export async function buildInteractiveNode(nodeId: string, instruction?: string, mode: 'create' | 'modify' | 'regenerate' | 'repair' = 'regenerate'): Promise<void> {
  const graph = useGraphStore.getState(); const project = graph.project;
  const original = project?.nodes[nodeId]; const projectId = graph.activeProjectId;
  if (!project || !projectId || !original || original.generating || !isStandaloneInteractive(original)) return;
  const sourceIndex = original.currentVersionIndex; const source = original.versions[sourceIndex]!;
  const continuing = mode === 'repair';
  const retryVerification = continuing && interactiveNeedsVerification(source.interactiveBuild) && !instruction?.trim();
  // A continuation may supply new runtime evidence, not a replacement request.
  const request = (!continuing && instruction?.trim()) || source.interactive?.request || source.interactiveBuild?.request;
  if (!request) return;
  const initialHtml = continuing ? source.interactiveBuild?.draftHtml : mode === 'modify' ? source.interactive?.html : undefined;
  if (continuing && !initialHtml) return;
  const settings = useSettingsStore.getState();
  const resolution = resolveInteractiveModel({ providers: settings.providers, activeModelRef: settings.activeModelRef,
    interactiveModelRef: settings.interactiveModelRef, catalog: useModelCatalogStore.getState().catalog });
  const provider = resolution.ref ? getProviderById(settings, resolution.ref.providerId) : null;
  if (!provider || !resolution.ref) {
    updateGenNode(projectId, nodeId, { generationError: 'Choose an interactive model in Settings → Models and generation.' }); return;
  }
  const ref = resolution.ref;
  const modelInfo = useModelCatalogStore.getState().getModel(provider.id, ref.model);
  const bypass = settings.modelCompatibilityOverrides?.interactive || (resolution.automatic && settings.modelCompatibilityOverrides?.main);
  if (!bypass && resolveCaps(provider.preset, ref.model, modelInfo).vision === false) {
    updateGenNode(projectId, nodeId, { generationError: 'Interactive generation now requires vision for screenshot review. Choose a vision-capable interactive model in Settings → Models and generation. If the provider metadata is incorrect, use Show all models.' }); return;
  }
  const tools = bypass || resolveCaps(provider.preset, ref.model, modelInfo).tools === true ? interactiveTools() : [];
  const incoming = Object.values(project.arrows).find(a => a.kind === 'auto' && a.toNodeId === nodeId);
  const parent = incoming && project.nodes[incoming.fromNodeId];
  const parentVersion = incoming?.sourceAnswer ? parent?.versions.find(v => v.createdAt === incoming.sourceAnswer?.versionCreatedAt)
    : parent?.versions[parent.currentVersionIndex];
  const context = parentVersion ? interactiveSourceContext(parentVersion.header, parentVersion.body, request) : '';
  const accent = (original.groupId ? project.groups[original.groupId]?.color : undefined) ?? project.color;
  const theme = readInteractiveTheme(accent);
  const previousRequest = source.interactive?.request || source.interactiveBuild?.request || '';
  const fullRequest = mode === 'modify' ? `${previousRequest}\n\nModification: ${request}`.slice(-20000) : request;
  const build: InteractiveBuild = { request: fullRequest, state: 'building', steps: [{ id: 0, state: 'complete', kind: 'info',
    label: 'Keep this tab visible during interactive generation. Browser checks may pause while the tab is in the background.' }],
    providerId: provider.id, model: ref.model, repairPasses: continuing ? source.interactiveBuild?.repairPasses ?? 0 : 0,
    ...(continuing ? { draftHtml: initialHtml, plan: source.interactiveBuild?.plan,
      pendingIssues: interactivePendingIssues(source.interactiveBuild), warnings: source.interactiveBuild?.warnings } : {}) };
  const draft: NodeVersion = { ...source, createdAt: Math.max(Date.now(), ...original.versions.map(v=>v.createdAt+1)),
    language: mode === 'modify' || continuing ? versionLanguage(source) : normalizeLanguage(settings.generationLanguage),
    body: fullRequest, header: source.interactive ? source.header : request.replace(/\s+/g,' ').slice(0,100), headerParts: undefined,
    interactive: undefined, interactiveBuild: { ...build, steps: [...build.steps] }, termPreviews: undefined, generatedBy: 'interactive' };
  const replaceEmpty = !source.interactive && !source.interactiveBuild;
  const versionIndex = replaceEmpty ? sourceIndex : original.versions.length;
  const versions = replaceEmpty ? original.versions.map((v,i)=>i===sourceIndex ? draft : v) : [...original.versions, draft];
  // Creating/modifying code is content intent; record one undo entry, not each log update.
  graph.updateNode(nodeId, { versions, currentVersionIndex: versionIndex, generating: true, generatingVersionIndex: versionIndex, generationError: undefined });
  const session = beginGenerationSession({ projectId, nodeId, kind: replaceEmpty ? 'spawn' : 'rewrite', sourceVersionIndex: sourceIndex, draftVersionIndex: versionIndex });
  const controller = new AbortController(); const unregister = registerGenerationController(session.id, controller);
  const owned = () => {
    const current = getGenProject(projectId)?.nodes[nodeId];
    const version = current?.versions[versionIndex];
    return getGenerationSession(projectId,nodeId)?.id === session.id && !!current?.generating
      && current.generatingVersionIndex === versionIndex && version?.createdAt === draft.createdAt
      && version.interactiveBuild?.state === 'building';
  };
  const commit = (patch: Partial<NodeVersion>, nodePatch: Partial<ScatterNode> = {}) => {
    if (!owned()) { controller.abort(); return; }
    const current = getGenProject(projectId)!.nodes[nodeId]!;
    const nextVersions = current.versions.map((v,i)=>i===versionIndex ? {...v,...patch} : v);
    if (patch.interactiveBuild && patch.interactiveBuild.state !== 'building') {
      settleBuildHistory(projectId, nodeId, nextVersions[versionIndex]!);
    }
    updateGenNode(projectId,nodeId,{ ...nodePatch, versions: nextVersions });
  };
  let lastDraftSave = 0;
  const onDraft = (html: string) => {
    if (html !== build.draftHtml) {
      const viewport = preferredInteractiveViewport(html);
      build.viewportWidth = viewport.width; build.viewportHeight = viewport.height;
    }
    build.draftHtml = html; markGenerationTextReceived(session.id);
    if (Date.now() - lastDraftSave > 650) { lastDraftSave = Date.now(); commit({ interactiveBuild: { ...build, steps: [...build.steps] } }); }
  };
  const check = async (html: string, actions: InteractiveTestAction[] = [], options?: InteractiveProbeOptions) => {
    let pausedStep: InteractiveStep | undefined;
    const result = await checkInteractiveDocument(html, theme, controller.signal, actions, options, {
      retryCapture: true,
      onVisibilityWait: waiting => {
        if (waiting) {
          pausedStep = [...build.steps].reverse().find(step => step.state === 'running');
          if (pausedStep) onStep({ ...pausedStep, kind: 'paused',
            label: 'Verification paused — return to this tab to continue.', detail: pausedStep.label });
        } else if (pausedStep) {
          onStep(pausedStep); pausedStep = undefined;
        }
      },
      onCaptureRetry: () => {
        const step = [...build.steps].reverse().find(step => step.state === 'running');
        if (step) onStep({ ...step, detail: 'Retrying screenshot capture once · no model call' });
      },
    });
    if (result.viewport) {
      build.viewportWidth = Math.max(build.viewportWidth ?? 0, result.viewport.width);
      build.viewportHeight = Math.max(build.viewportHeight ?? 0, result.viewport.height);
    }
    return result;
  };
  const onStep = (step: InteractiveStep) => {
    build.steps = [...build.steps.filter(s=>s.id!==step.id),step].sort((a,b)=>a.id-b.id).slice(-160);
    commit({ interactiveBuild: { ...build, steps: [...build.steps] } });
  };
  useNodeStatusStore.getState().setStatus(nodeId, 'CREATING INTERACTIVE NODE');
  try {
    const messages: ProviderConversationMessage[] = [
      { role: 'system', content: configuredPrompt('interactiveNodeBase') + '\n\n' + configuredPrompt(tools.length ? 'interactiveNodeTools' : 'interactiveNodeOutput') + '\n\n' + generationLanguagePrompt(draft.language) },
      { role: 'user', content: configuredPrompt('interactiveNodeTask',{ request, context, color: theme.primary, mode })
        + (mode === 'modify' ? `\n\nOriginal request: ${previousRequest}` : '') },
    ];
    const html = await runInteractiveWorkflow({ messages, initialHtml, tools,
      acceptedPlan: continuing ? source.interactiveBuild?.plan : undefined,
      onPlan: plan => { build.plan = plan; commit({ interactiveBuild: { ...build } }); },
      ...(continuing ? { maxRepairs: 1, maxRounds: 6, repairPassOffset: build.repairPasses,
        verifyInitial: retryVerification,
        repairFeedback: retryVerification ? undefined : [instruction?.trim(), ...(build.pendingIssues ?? []),
          !build.pendingIssues?.length ? source.interactiveBuild?.error : undefined].filter(Boolean).join('\n')
          || 'Finish and verify the saved draft against the accepted tests.' } : {}),
      onRepairPass: total => { build.repairPasses = total; },
      onIssues: issues => { build.pendingIssues = issues; commit({ interactiveBuild: { ...build } }); },
      onWarnings: warnings => { build.warnings = warnings; commit({ interactiveBuild: { ...build } }); },
      planPrompt: configuredPrompt('interactiveNodePlan'), reviewPrompt: configuredPrompt('interactiveNodeReview'),
      reviewRetryPrompt: configuredPrompt('interactiveNodeReviewRetry'),
      signal: controller.signal, onDraft, onStep,
      invoke: (conversation, definitions, onActivity) => getAdapter(provider.preset).streamChat(provider.apiKey, {
        onActivity,
        model: ref.model, messages: [], conversation, tools: definitions.length ? definitions : undefined,
        toolArgumentLimits: definitions.length ? INTERACTIVE_TOOL_ARGUMENT_LIMITS : undefined,
        modelInfo, maxOutputTokens: normalizeGenerationLimit('interactiveOutputTokenCap', settings.interactiveOutputTokenCap), signal: controller.signal, webSearch: false, reasoningEffort: settings.interactiveReasoningEffort,
        allowUnverifiedCapabilities: bypass,
      }, resolveBaseUrl(provider.preset,provider.baseUrl)),
      check,
      verify: check,
      repairPrompt: error => configuredPrompt('interactiveNodeRepair',{error}),
    });
    const parsed = new DOMParser().parseFromString(html,'text/html');
    const title = parsed.title.trim().replace(/\s+/g,' ').slice(0,120) || draft.header;
    parsed.querySelectorAll('script,style').forEach(el=>el.remove());
    const text = parsed.body.textContent?.replace(/\s+/g,' ').trim().slice(0,10000) ?? '';
    commit({ header: title, headerParts: { subject: title }, body: `${fullRequest}\n\n${text}`,
      interactive: { html, request: fullRequest, providerId: provider.id, model: ref.model,
        viewportWidth: build.viewportWidth ?? 960, viewportHeight: build.viewportHeight ?? 720 },
      interactiveBuild: { ...build, draftHtml: undefined, state: 'complete', verificationPending: false },
    }, { generating: false, generatingVersionIndex: undefined, generationError: undefined });
  } catch (error) {
    if (owned()) commit({ interactiveBuild: { ...build, state: controller.signal.aborted ? 'stopped' : 'failed',
      limitReached: !controller.signal.aborted && error instanceof InteractiveBuildLimitError,
      verificationPending: !controller.signal.aborted && error instanceof InteractiveVerificationError && !(error instanceof InteractiveBuildLimitError),
      steps: build.steps.map(s=>s.state==='running' ? {...s,kind:undefined,state:'failed'} : s), error: controller.signal.aborted ? undefined : (error as Error).message,
    } }, { generating: false, generatingVersionIndex: undefined, generationError: controller.signal.aborted ? undefined : (error as Error).message });
  } finally {
    unregister();
    if (getGenerationSession(projectId,nodeId)?.id===session.id) useNodeStatusStore.getState().clearStatus(nodeId);
    finishGenerationSession(projectId,nodeId,session.id);
  }
}
