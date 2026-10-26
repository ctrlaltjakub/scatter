import { getAdapter, modelSupportsWebSearch, resolveBaseUrl } from '@/providers/registry';
import { mergeGoogleSearchSuggestions } from './googleSearchSuggestions';
import { GenerationOutputLimitError, isOutputLimit, mainOutputTokens } from './generationLimits';
import { ProviderError, friendlyErrorMessage } from '@/providers/errors';
import type { Citation, ModelInfo } from '@/providers/types';
import { getActiveProvider } from '@/store/providerSelectors';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useFactCheckTaskStore, factCheckTaskKey } from '@/store/useFactCheckTaskStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import type {
  FactCheckFinding,
  FactCheckReport,
  FactCheckUnit,
  NodeVersion,
  ProviderPreset,
  ReasoningEffort,
  ScatterNode,
} from '@/store/types';
import { factCheckMessages, FACT_CHECK_SEARCH_POLICY } from './factCheckRequest';
import {
  extractFactCheckUnits,
  factCheckBodyFingerprint,
  factCheckProgress,
  parseFactCheckFinding,
} from './factCheckCore';

const MAX_PARALLEL = 10;
const FACT_STATUS_PREFIX = 'CHECKING FACTS';

class FactCheckQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const enter = () => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(enter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.active < MAX_PARALLEL) enter();
      else this.waiting.push(enter);
    });
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

const queue = new FactCheckQueue();
const jobs = new Map<string, AbortController>();

function abortError(error: unknown): boolean {
  return (error as Error)?.name === 'AbortError';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

function targetVersion(
  nodeId: string,
  versionCreatedAt: number,
  bodyFingerprint: string,
): { node: ScatterNode; version: NodeVersion; index: number } | null {
  const node = useGraphStore.getState().project?.nodes[nodeId];
  if (!node) return null;
  const index = node.versions.findIndex((version) =>
    version.createdAt === versionCreatedAt
    && factCheckBodyFingerprint(version) === bodyFingerprint,
  );
  const version = node.versions[index];
  return index >= 0 && version ? { node, version, index } : null;
}

function patchFactCheck(
  nodeId: string,
  versionCreatedAt: number,
  bodyFingerprint: string,
  mutate: (version: NodeVersion) => NodeVersion,
): boolean {
  const target = targetVersion(nodeId, versionCreatedAt, bodyFingerprint);
  if (!target) return false;
  const versions = [...target.node.versions];
  versions[target.index] = mutate(target.version);
  useGraphStore.temporal.getState().pause();
  try {
    useGraphStore.getState().updateNode(nodeId, { versions });
  } finally {
    useGraphStore.temporal.getState().resume();
  }
  return true;
}

class RetryableFactCheckError extends Error {}

interface FactCheckRequestConfig {
  preset: ProviderPreset;
  apiKey: string;
  baseUrl?: string;
  webSearchEndpoint?: string;
  serverSearch?: import('@/store/types').ServerSearch;
  allowUnverifiedCapabilities?: boolean;
  model: string;
  modelInfo?: ModelInfo;
  reasoningEffort: ReasoningEffort;
  outputTokenCap: number;
}

async function requestFinding(
  version: NodeVersion,
  unit: FactCheckUnit,
  signal: AbortSignal,
  config: FactCheckRequestConfig,
): Promise<FactCheckFinding> {
  let raw = '';
  const citations: Citation[] = [];
  let searchUsed = false;
  let searchError: string | undefined;
  let googleSearchSuggestions: string[] | undefined;
  for await (const chunk of getAdapter(config.preset).streamChat(config.apiKey, {
    model: config.model,
    modelInfo: config.modelInfo,
    messages: factCheckMessages(version, unit, useSettingsStore.getState().customPrompts),
    maxOutputTokens: mainOutputTokens(config.outputTokenCap, 2400),
    reasoningEffort: config.reasoningEffort,
    webSearch: true,
    webSearchEndpoint: config.webSearchEndpoint,
    serverSearch: config.serverSearch,
    allowUnverifiedCapabilities: config.allowUnverifiedCapabilities,
    webSearchPolicy: FACT_CHECK_SEARCH_POLICY,
    signal,
  }, resolveBaseUrl(config.preset, config.baseUrl))) {
    if (chunk.delta) raw += chunk.delta;
    googleSearchSuggestions = mergeGoogleSearchSuggestions(googleSearchSuggestions, chunk.googleSearchSuggestions);
    if (isOutputLimit(chunk.finishReason)) throw new GenerationOutputLimitError('main');
    if (chunk.citations?.length) {
      citations.push(...chunk.citations);
      searchUsed = true;
    }
    if (chunk.webSearch) {
      searchUsed ||= chunk.webSearch.used;
      if (chunk.webSearch.error) searchError = chunk.webSearch.error;
    }
  }
  if (!searchUsed) {
    throw new RetryableFactCheckError(
      searchError
        ? `Web search did not complete: ${searchError}`
        : 'The model answered without using web search.',
    );
  }
  try {
    return { ...parseFactCheckFinding(raw, unit.id, citations), googleSearchSuggestions };
  } catch (error) {
    throw new RetryableFactCheckError((error as Error).message);
  }
}

async function checkWithRetry(
  version: NodeVersion,
  unit: FactCheckUnit,
  signal: AbortSignal,
  config: FactCheckRequestConfig,
): Promise<FactCheckFinding> {
  let attempt = 0;
  for (;;) {
    try {
      return await queue.run(signal, () => requestFinding(version, unit, signal, config));
    } catch (error) {
      if (signal.aborted || abortError(error)) throw error;
      const isRateLimit = error instanceof ProviderError && error.kind === 'rate_limit';
      const retryableProvider = error instanceof ProviderError && error.retryable;
      const retryableOutput = error instanceof RetryableFactCheckError;
      const maxAttempts = isRateLimit ? 3 : (retryableProvider || retryableOutput) ? 2 : 1;
      attempt += 1;
      if (attempt >= maxAttempts) throw error;
      const backoff = Math.min(8000, 800 * 2 ** (attempt - 1));
      await sleep(
        error instanceof ProviderError && error.retryAfterMs != null
          ? Math.max(backoff, error.retryAfterMs)
          : backoff,
        signal,
      );
    }
  }
}

function setProgressStatus(nodeId: string, report: FactCheckReport): void {
  const { completed, total } = factCheckProgress(report);
  useNodeStatusStore.getState().setProcessStatus(
    nodeId,
    'fact-check',
    `${FACT_STATUS_PREFIX} ${completed}/${total}`,
    false,
  );
}

function clearOwnedStatus(nodeId: string): void {
  useNodeStatusStore.getState().clearProcessStatus(nodeId, 'fact-check');
}

function writeUnitResult(
  nodeId: string,
  reportIdentity: Pick<FactCheckReport, 'versionCreatedAt' | 'bodyFingerprint'>,
  unitId: string,
  patch: Partial<FactCheckUnit>,
): FactCheckReport | null {
  let nextReport: FactCheckReport | null = null;
  patchFactCheck(
    nodeId,
    reportIdentity.versionCreatedAt,
    reportIdentity.bodyFingerprint,
    (version) => {
      const pending = version.factCheck?.pending;
      if (!pending || pending.bodyFingerprint !== reportIdentity.bodyFingerprint) return version;
      nextReport = {
        ...pending,
        units: pending.units.map((unit) => unit.id === unitId ? { ...unit, ...patch } : unit),
      };
      nextReport.failedUnitIds = nextReport.units
        .filter((unit) => unit.state === 'failed')
        .map((unit) => unit.id);
      return {
        ...version,
        factCheck: { ...version.factCheck, pending: nextReport },
      };
    },
  );
  return nextReport;
}

async function runStage(
  nodeId: string,
  version: NodeVersion,
  report: FactCheckReport,
  units: FactCheckUnit[],
  controller: AbortController,
  taskKey: string,
  config: FactCheckRequestConfig,
): Promise<void> {
  await Promise.all(units.map(async (unit) => {
    if (unit.state === 'complete' || controller.signal.aborted) return;
    try {
      const finding = await checkWithRetry(version, unit, controller.signal, config);
      if (controller.signal.aborted) return;
      const next = writeUnitResult(nodeId, report, unit.id, {
        state: 'complete',
        finding,
        error: undefined,
      });
      if (next) {
        const progress = factCheckProgress(next);
        useFactCheckTaskStore.getState().patchTask(taskKey, { completed: progress.completed });
        setProgressStatus(nodeId, next);
      }
    } catch (error) {
      if (controller.signal.aborted || abortError(error)) return;
      const next = writeUnitResult(nodeId, report, unit.id, {
        state: 'failed',
        error: friendlyErrorMessage(error),
        finding: undefined,
      });
      if (next) {
        const progress = factCheckProgress(next);
        useFactCheckTaskStore.getState().patchTask(taskKey, { completed: progress.completed });
        setProgressStatus(nodeId, next);
      }
    }
  }));
}

export function factCheckAvailability(): { available: boolean; reason?: string } {
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings);
  const model = settings.activeModelRef?.model;
  if (!provider?.apiKey || !model) {
    return { available: false, reason: 'Configure the main model and API key first.' };
  }
  if (!modelSupportsWebSearch(provider.preset, model,
    useModelCatalogStore.getState().getModel(provider.id, model), provider.webSearchEndpoint, provider.serverSearch, settings.modelCompatibilityOverrides?.main)) {
    return {
      available: false,
      reason: 'The selected main model has no available web-search connection.',
    };
  }
  return { available: true };
}

export function isFactCheckRunning(nodeId: string, versionCreatedAt: number): boolean {
  return !!useFactCheckTaskStore.getState().tasks[factCheckTaskKey(nodeId, versionCreatedAt)]?.running;
}

export function stopFactCheck(nodeId: string, versionCreatedAt: number): void {
  const key = factCheckTaskKey(nodeId, versionCreatedAt);
  jobs.get(key)?.abort();
  jobs.delete(key);
  useFactCheckTaskStore.getState().removeTask(key);
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  const version = node?.versions.find((entry) => entry.createdAt === versionCreatedAt);
  if (version) {
    const fingerprint = factCheckBodyFingerprint(version);
    patchFactCheck(nodeId, versionCreatedAt, fingerprint, (current) => {
      const pending = current.factCheck?.pending;
      if (!pending) return current;
      return {
        ...current,
        factCheck: {
          ...current.factCheck,
          pending: { ...pending, stoppedAt: Date.now(), complete: false },
        },
      };
    });
  }
  clearOwnedStatus(nodeId);
}

export async function startFactCheck(
  nodeId: string,
  mode: 'new' | 'again' | 'continue' = 'new',
): Promise<void> {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  if (!project || !node) return;
  const version = node.versions[node.currentVersionIndex];
  if (!version || version.contentType === 'media' || version.media) return;
  const availability = factCheckAvailability();
  if (!availability.available) throw new Error(availability.reason);

  const fingerprint = factCheckBodyFingerprint(version);
  const key = factCheckTaskKey(nodeId, version.createdAt);
  stopFactCheck(nodeId, version.createdAt);

  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings)!;
  const requestConfig: FactCheckRequestConfig = {
    preset: provider.preset,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    webSearchEndpoint: provider.webSearchEndpoint,
    serverSearch: provider.serverSearch,
    allowUnverifiedCapabilities: settings.modelCompatibilityOverrides?.main,
    model: settings.activeModelRef!.model,
    modelInfo: useModelCatalogStore.getState().getModel(provider.id, settings.activeModelRef!.model),
    reasoningEffort: settings.reasoningEffort,
    outputTokenCap: settings.outputTokenCap,
  };
  const previous = version.factCheck;
  const continuing = mode === 'continue'
    && previous?.pending?.bodyFingerprint === fingerprint
    ? previous.pending
    : undefined;
  const units = continuing
    ? continuing.units.map((unit) => unit.state === 'complete'
      ? unit
      : { ...unit, state: 'pending' as const, error: undefined })
    : extractFactCheckUnits(version);
  const report: FactCheckReport = {
    schemaVersion: 1,
    bodyFingerprint: fingerprint,
    versionCreatedAt: version.createdAt,
    providerId: provider.id,
    model: settings.activeModelRef!.model,
    startedAt: continuing?.startedAt ?? Date.now(),
    complete: false,
    units,
    failedUnitIds: [],
  };
  patchFactCheck(nodeId, version.createdAt, fingerprint, (current) => ({
    ...current,
    factCheck: {
      complete: current.factCheck?.complete,
      pending: report,
    },
  }));

  useCitationPanelStore.getState().openFact(nodeId, version.createdAt, units[0]?.id);
  if (useLiveViewportStore.getState().zoom < 0.35) {
    useGraphStore.getState().requestFitNodes([nodeId], 'panels');
  }
  const alreadyDone = units.filter((unit) => unit.state === 'complete').length;
  useFactCheckTaskStore.getState().setTask({
    key,
    projectId: project.id,
    nodeId,
    versionCreatedAt: version.createdAt,
    bodyFingerprint: fingerprint,
    completed: alreadyDone,
    total: units.length,
    running: true,
  });
  setProgressStatus(nodeId, report);

  const controller = new AbortController();
  jobs.set(key, controller);
  const unsubscribe = useGraphStore.subscribe((state) => {
    const sameProject = state.project?.id === project.id;
    const stillExists = !!state.project?.nodes[nodeId]?.versions.some(
      (entry) => entry.createdAt === version.createdAt
        && factCheckBodyFingerprint(entry) === fingerprint,
    );
    if (!sameProject || !stillExists) controller.abort();
  });
  try {
    const opening = units.filter((unit) => unit.stage !== 'bullets');
    const bullets = units.filter((unit) => unit.stage === 'bullets');
    await runStage(nodeId, version, report, opening, controller, key, requestConfig);
    if (!controller.signal.aborted) {
      await runStage(nodeId, version, report, bullets, controller, key, requestConfig);
    }
    if (controller.signal.aborted) return;

    patchFactCheck(nodeId, version.createdAt, fingerprint, (current) => {
      const pending = current.factCheck?.pending;
      if (!pending) return current;
      const complete = pending.units.every((unit) => unit.state === 'complete');
      const finished: FactCheckReport = {
        ...pending,
        complete,
        completedAt: Date.now(),
        failedUnitIds: pending.units
          .filter((unit) => unit.state === 'failed')
          .map((unit) => unit.id),
      };
      return {
        ...current,
        factCheck: complete
          ? { complete: finished, pending: undefined }
          : { complete: current.factCheck?.complete, pending: finished },
      };
    });
  } finally {
    unsubscribe();
    if (jobs.get(key) === controller) {
      jobs.delete(key);
      useFactCheckTaskStore.getState().removeTask(key);
      clearOwnedStatus(nodeId);
    }
  }
}
