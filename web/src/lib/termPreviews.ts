import { useGraphStore } from '@/store/useGraphStore';
import { updateGenNode } from '@/store/bgGen';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { secondaryTaskCompletion } from './secondaryTaskCompletion';
import { completeTermPreviews, previewTerms, reusableTermPreviews, TERM_PREVIEW_BATCH_SIZE, termPreviewContextFingerprint, termPreviewFingerprint, termPreviewKey, termPreviewWorkFingerprint } from './termPreviewCore';
import { enrichmentMembers, pendingAnswerTermMarking, shareAnswerEnrichment } from './chat/sharedEnrichment';
import { ensureAnswerTerms } from './chat/enrichment';

const running = new Map<string, { controller: AbortController; fingerprint: string; terms: Set<string> }>();
const statusOwners = new Map<string, Set<AbortController>>();
// One pending body per version, consumed by the focused watcher. Manual marking
// requests its own preview; that mutation must not backfill unrelated terms.
const manuallyMarkedBodies = new Map<string, string>();
export function registerManualTermMark(projectId: string, nodeId: string, createdAt: number, body: string): void {
  manuallyMarkedBodies.set(`${projectId}:${nodeId}:${createdAt}`, body);
  if (manuallyMarkedBodies.size > 100) manuallyMarkedBodies.delete(manuallyMarkedBodies.keys().next().value!);
}
let activeRequests = 0;
const waiting: Array<() => void> = [];

/** Shared limit across focused chat answers and concurrently completed nodes. */
async function limited<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const enter = () => { signal.removeEventListener('abort', abort); activeRequests++; resolve(); };
    const abort = () => { const index = waiting.indexOf(enter); if (index >= 0) waiting.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (activeRequests < 2) enter(); else waiting.push(enter);
  });
  try { signal.throwIfAborted(); return await work(); }
  finally { activeRequests--; waiting.shift()?.(); }
}

export const termPreviewProcess = (createdAt: number) => `term-previews-${createdAt}`;

/** Background enrichment never creates an undo entry or changes body text.
 * Results stay with the captured project and matching source prose. */
export async function generateTermPreviews(nodeId: string, createdAt: number, explicitRedo = false,
  options?: { terms: readonly string[] }): Promise<void> {
  const project = useGraphStore.getState().project;
  const node = project?.nodes[nodeId];
  let version = node?.versions.find(v => v.createdAt === createdAt);
  if (!project || !node || !version || version.contentType === 'interactive' || version.chat?.state === 'generating') return;
  const enabled = useSettingsStore.getState().autoTermPreviews;
  const requested = options ? new Set(options.terms.map(termPreviewKey))
    : explicitRedo && !enabled ? new Set(version.termPreviews?.manualTerms) : undefined;
  if (!enabled && !requested?.size) return;
  // Chat completion belongs to each answer. A different turn may be streaming
  // or have failed while the user re-marks an already completed answer.
  if (!node.chat && (node.generating || (!requested && node.generationError))) return;
  if (node.chat && !version.answerEnrichmentId) {
    version = shareAnswerEnrichment(version, `${project.id}:${nodeId}:${createdAt}`);
    updateGenNode(project.id, nodeId, { versions: node.versions.map(v => v.createdAt === createdAt ? version! : v) });
  }
  const seed = version;
  if (version.answerEnrichmentId && pendingAnswerTermMarking.has(version.answerEnrichmentId)) return;
  const fingerprint = termPreviewFingerprint(version);
  const allTerms = previewTerms(version).filter(term => !requested || requested.has(termPreviewKey(term)));
  const ownEntries = version.termPreviews?.fingerprint === fingerprint ? version.termPreviews.entries : {};
  if (allTerms.every(term => Object.hasOwn(ownEntries, termPreviewKey(term)))) return;
  const reused = reusableTermPreviews(version, version.answerEnrichmentId
    ? [...node.versions, ...enrichmentMembers(project, nodeId, version).map(member => member.version)] : node.versions);
  if (reused && reused !== version.termPreviews) {
    const versions = node.versions.map(v => v.createdAt === createdAt ? { ...version!, termPreviews: reused } : v);
    updateGenNode(project.id, nodeId, { versions });
  }
  const existing = reused?.entries ?? ownEntries;
  // A completed pass already retries malformed entries twice. Remember those
  // exhausted terms so refocusing cannot repeatedly spend money on them.
  const exhausted = new Set((reused?.exhaustedTerms ?? []).filter(term => !requested?.has(term)));
  const terms = allTerms.filter(term => !Object.hasOwn(existing, termPreviewKey(term)) && !exhausted.has(termPreviewKey(term)));
  if (!terms.length) return;
  const workFingerprint = termPreviewContextFingerprint(version);
  const identity = `${project.id}:${version.answerEnrichmentId ?? `${nodeId}:${workFingerprint}`}`;
  const termKeys = new Set(terms.map(termPreviewKey));
  if (requested && [...running.entries()].some(([key, task]) => key.startsWith(identity + ':')
    && task.fingerprint === workFingerprint && !task.controller.signal.aborted
    && [...termKeys].every(term => task.terms.has(term)))) return;
  const key = `${identity}:${requested ? JSON.stringify([...termKeys].sort()) : 'auto'}`;
  const previous = running.get(key);
  if (previous?.fingerprint === workFingerprint && !previous.controller.signal.aborted) return;
  previous?.controller.abort();
  const controller = new AbortController();
  running.set(key, { controller, fingerprint: workFingerprint, terms: termKeys });
  // Large encyclopedic nodes can contain hundreds of terms. Scale the overall
  // budget with work; still cap each individual request to catch a stalled API.
  const timeout = Math.min(1_800_000, Math.max(180_000, Math.ceil(terms.length / TERM_PREVIEW_BATCH_SIZE) * 60_000));
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  const currentVersions = () => {
    const current = useGraphStore.getState().project;
    if (current?.id !== project.id) return [];
    // Title-only editor snapshots retain the same prose. Let the original
    // request finish for them too, even if they have a new version timestamp.
    const members = seed.answerEnrichmentId ? enrichmentMembers(current, nodeId, seed)
      : (current.nodes[nodeId]?.versions ?? []).map((version, index) => ({ nodeId, index, version }));
    return members
      .filter(member => termPreviewContextFingerprint(member.version) === workFingerprint
        && (!requested || previewTerms(member.version).some(term => termKeys.has(termPreviewKey(term)))))
      .map(member => ({ ...member, node: current.nodes[member.nodeId]! }));
  };
  const statusNodes = new Map<string, number>();
  const syncStatus = () => {
    const members = currentVersions();
    if (!members.length) controller.abort();
    for (const member of members) if (!statusNodes.has(member.nodeId)) {
      statusNodes.set(member.nodeId, member.version.createdAt);
      const statusKey = `${project.id}:${member.nodeId}:${member.version.createdAt}`;
      const owners = statusOwners.get(statusKey) ?? new Set<AbortController>();
      owners.add(controller);
      statusOwners.set(statusKey, owners);
      useNodeStatusStore.getState().setProcessStatus(member.nodeId, termPreviewProcess(member.version.createdAt), 'GENERATING TERM PREVIEWS');
    }
  };
  const unsubscribe = useGraphStore.subscribe(syncStatus);
  const unsubscribeSettings = useSettingsStore.subscribe(state => { if (!requested && !state.autoTermPreviews) controller.abort(); });
  syncStatus();
  const commit = (entries: Record<string, string>, exhaustedTerms: string[] = []) => {
    if (signal.aborted || (!Object.keys(entries).length && !exhaustedTerms.length)) return;
    for (const current of currentVersions()) {
      // Undo may remove one term while another request is still running.
      const visible = new Set(previewTerms(current.version).map(termPreviewKey));
      const applicable = Object.fromEntries(Object.entries(entries).filter(([key]) => visible.has(key)));
      const currentFingerprint = termPreviewFingerprint(current.version);
      const previous = current.version.termPreviews?.fingerprint === currentFingerprint ? current.version.termPreviews : undefined;
      const stillFailed = [...new Set([...(previous?.exhaustedTerms ?? []), ...exhaustedTerms.map(termPreviewKey)])]
        .filter(term => !Object.hasOwn(applicable, term));
      // A restored project can contain the same shared answer in more than one
      // history entry. Keep updates already committed to its other versions.
      const latestNode = useGraphStore.getState().project?.nodes[current.nodeId];
      if (!latestNode) continue;
      const versions = [...latestNode.versions];
      versions[current.index] = { ...current.version, termPreviews: { fingerprint: currentFingerprint, entries: { ...previous?.entries, ...applicable },
        ...(previous?.manualTerms ? { manualTerms: previous.manualTerms, manualTermOffsets: previous.manualTermOffsets } : {}),
        // A partial legacy cache can still contain explanations in the old
        // forced language. Only an explicit redo refreshes those paid entries.
        ...(!previous || previous.languageMode === 'source' || !Object.keys(previous.entries).length ? { languageMode: 'source' as const } : {}),
        ...(stillFailed.length ? { exhaustedTerms: stillFailed, ...(previous?.error ? { error: previous.error } : {}) } : {}),
      } };
      updateGenNode(project.id, current.node.id, { versions });
    }
  };
  try {
    const failed = await completeTermPreviews(version, terms, request => limited(signal, async () => {
      const raw = await secondaryTaskCompletion({ ...request, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) });
      signal.throwIfAborted();
      return raw;
    }), commit);
    commit({}, failed);
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = signal.aborted ? 'Term preview generation timed out. Use Redo terms to retry.'
        : 'Term previews could not finish. Use Redo terms to re-mark the text and refresh its previews.';
      for (const current of currentVersions()) {
        const latest = useGraphStore.getState().project?.nodes[current.nodeId];
        if (!latest) continue;
        updateGenNode(project.id, current.nodeId, { versions: latest.versions.map((v, i) => i === current.index
          ? { ...v, termPreviews: { ...v.termPreviews, fingerprint: termPreviewFingerprint(v), entries: v.termPreviews?.entries ?? {}, error: message,
            ...(requested ? { exhaustedTerms: [...new Set([...(v.termPreviews?.exhaustedTerms ?? []), ...termKeys])]
              .filter(term => !Object.hasOwn(v.termPreviews?.entries ?? {}, term)) } : {}),
          } } : v) });
      }
      if (!signal.aborted) console.warn('[term previews] Background explanations could not finish.', error);
    }
  } finally {
    unsubscribe();
    unsubscribeSettings();
    if (running.get(key)?.controller === controller) {
      running.delete(key);
    }
    for (const [id, timestamp] of statusNodes) {
      const statusKey = `${project.id}:${id}:${timestamp}`;
      // A manual redo can detach this answer from its former shared identity.
      // Finishing that old task must not clear the replacement task's status.
      const owners = statusOwners.get(statusKey);
      if (!owners?.delete(controller)) continue;
      if (owners.size) continue;
      statusOwners.delete(statusKey);
      useNodeStatusStore.getState().clearProcessStatus(id, termPreviewProcess(timestamp));
    }
  }
}

/** Focus is navigation, not an edit. Legacy versions are enriched lazily; a
 * failed attempt can be retried by focusing again, not on every store update. */
export function watchFocusedTermPreviews(): () => void {
  let previousProject: string | undefined;
  let previousNode: string | undefined;
  let previousGenerating: boolean | undefined;
  let previousEnabled: boolean | undefined;
  let previousVersions: readonly import('@/store/types').NodeVersion[] = [];
  const check = () => {
    const enabled = useSettingsStore.getState().autoTermPreviews;
    const project = useGraphStore.getState().project;
    const focused = project?.selection.length === 1 ? project.nodes[project.selection[0]!] : undefined;
    const alternatives = focused?.chat ? useChatRuntimeStore.getState().views[focused.id]?.previews : undefined;
    // Historical alternatives are display-only; they are not necessarily the
    // conversation's selected continuation. Backfill the answers actually shown.
    const displayed = focused?.chat && new Set(focused.chat.turns.map(turn => alternatives?.[turn.id] ?? turn.selectedVersionCreatedAt));
    const versions = focused?.chat
      ? focused.versions.filter(version => displayed && displayed.has(version.createdAt))
      : focused?.versions[focused.currentVersionIndex] ? [focused.versions[focused.currentVersionIndex]!] : [];
    if (previousEnabled === enabled && previousProject === project?.id && previousNode === focused?.id && previousGenerating === focused?.generating
      && versions.length === previousVersions.length && versions.every((version, index) => {
        const previous = previousVersions[index]!;
        return previous === version || ((!focused?.chat || previous.createdAt === version.createdAt)
          && termPreviewWorkFingerprint(previous) === termPreviewWorkFingerprint(version)
          && previous.chat?.state === version.chat?.state);
      })) return;
    const markerOnly = new Set(previousProject === project?.id && previousNode === focused?.id && previousEnabled === enabled
      ? versions.filter(version => previousVersions.some(previous => previous.createdAt === version.createdAt
        && previous.body !== version.body
        && termPreviewContextFingerprint(previous) === termPreviewContextFingerprint(version))).map(version => version.createdAt) : []);
    previousProject = project?.id;
    previousEnabled = enabled;
    previousNode = focused?.id;
    previousGenerating = focused?.generating;
    previousVersions = versions;
    if (focused && project && (focused.chat || !focused.generating)) for (const version of versions) {
      // Term marking is not controlled by the optional preview preference.
      // Opening a detached answer also resumes work interrupted before copying.
      if (version.chat) void ensureAnswerTerms(project.id, focused.id,
        { turnId: version.chat.turnId, versionCreatedAt: version.createdAt });
      const manualKey = `${project.id}:${focused.id}:${version.createdAt}`;
      const manualBody = manuallyMarkedBodies.get(manualKey);
      manuallyMarkedBodies.delete(manualKey);
      if (enabled && manualBody !== version.body && !markerOnly.has(version.createdAt)) void generateTermPreviews(focused.id, version.createdAt);
    }
  };
  let queued = false, disposed = false;
  const schedule = () => {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!disposed) check(); });
  };
  schedule();
  const unsubscribe = useGraphStore.subscribe(schedule);
  const unsubscribeSettings = useSettingsStore.subscribe((state, previous) => {
    if (state.autoTermPreviews !== previous.autoTermPreviews) schedule();
  });
  const unsubscribeChat = useChatRuntimeStore.subscribe((state, previous) => {
    const selection = useGraphStore.getState().project?.selection;
    const nodeId = selection?.length === 1 ? selection[0] : undefined;
    // Draft typing, scrolling, and other chat activity do not change previews.
    if (nodeId && state.views[nodeId]?.previews !== previous.views[nodeId]?.previews) schedule();
  });
  return () => { disposed = true; unsubscribe(); unsubscribeChat(); unsubscribeSettings(); };
}
