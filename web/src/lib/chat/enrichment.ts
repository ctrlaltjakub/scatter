import { configuredPrompt } from '@/lib/configuredPrompt';
import { generationLanguagePrompt } from '../generationLanguage';
import { versionLanguage } from '../languages';
import { secondaryTaskCompletion } from '@/lib/secondaryTaskCompletion';
import { stripChips } from '@/lib/bulletParse';
import { getGenProject, updateGenNode } from '@/store/bgGen';
import { useNodeStatusStore } from '@/store/useNodeStatusStore';
import type { ChatAnswerRef } from '@/store/chatTypes';
import { answerVersion, chatFallbackTitle, updateChatAnswer } from './model';
import type { ScatterNode } from '@/store/types';
import { useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { markChatTerms } from './termMarking';
import { markedTerms, stripTermMarkers } from '../termMarking';
import { generateTermPreviews } from '../termPreviews';
import { reusableTermPreviews } from '../termPreviewCore';
import { answerMarkingFingerprint, enrichmentMembers, pendingAnswerTermMarking, shareAnswerEnrichment } from './sharedEnrichment';
import { newId } from '../ids';

const marking = new Set<string>();

/** Revisit unfinished work once per opening/copying, not on every store update.
 * Older answers with existing markers keep their already-paid-for enrichment. */
export async function ensureAnswerTerms(projectId: string, nodeId: string, ref: ChatAnswerRef): Promise<void> {
  const node = getGenProject(projectId)?.nodes[nodeId];
  const answer = node && answerVersion(node, ref);
  if (!answer?.chat || answer.markdownNote || (!node?.chat && answer.contentType !== 'answer')
    || answer.chat.state === 'generating' || !answer.body.trim()) return;
  const progress = answer.answerTermMarking;
  if (progress?.fingerprint === answerMarkingFingerprint(answer) && progress.state === 'complete') return;
  if (!progress && markedTerms(answer.body).length) return;
  await enrichChatAnswer(projectId, nodeId, ref, AbortSignal.timeout(180_000));
}

export function redoChatTerms(nodeId: string, ref: ChatAnswerRef): Promise<void> {
  const projectId = useGraphStore.getState().project?.id;
  return projectId ? enrichChatAnswer(projectId, nodeId, ref, AbortSignal.timeout(180_000), true) : Promise.resolve();
}

/** Enrich a fixed answer identity. A later selection never redirects results. */
export async function enrichChatAnswer(projectId: string, nodeId: string, ref: ChatAnswerRef, outerSignal: AbortSignal, manual = false) {
  const initial = getGenProject(projectId)?.nodes[nodeId];
  let answer = initial && answerVersion(initial, ref);
  if (!initial || (!initial.chat && answer?.contentType !== 'answer') || !answer?.chat || !answer.body.trim()) return;
  if (!manual && !answer.answerEnrichmentId) {
    answer = shareAnswerEnrichment(answer, `${projectId}:${nodeId}:${ref.versionCreatedAt}`);
    updateGenNode(projectId, nodeId, { versions: initial.versions.map(version => version.createdAt === ref.versionCreatedAt ? answer! : version) });
  }
  const seed = answer;
  const taskKey = `${projectId}:${manual ? `${nodeId}:${ref.versionCreatedAt}` : seed.answerEnrichmentId}`;
  if (marking.has(taskKey)) return;
  marking.add(taskKey);
  if (!manual && seed.answerEnrichmentId) pendingAnswerTermMarking.add(seed.answerEnrichmentId);
  const lifecycle = new AbortController();
  const signal = AbortSignal.any([outerSignal, lifecycle.signal]);
  const unsubscribe = useGraphStore.subscribe((state) => {
    if (state.activeProjectId !== projectId || !state.project
      || (manual ? !state.project.nodes[nodeId] || !answerVersion(state.project.nodes[nodeId]!, ref)
        : !enrichmentMembers(state.project, nodeId, seed).length)) lifecycle.abort();
  });
  const plain = stripChips(answer.body);
  const setProgress = (state: 'pending' | 'failed', error?: string) => {
    if (manual) return; // Manual marking stays one undoable content action.
    const project = getGenProject(projectId);
    if (!project) return;
    for (const member of enrichmentMembers(project, nodeId, seed)) {
      if (member.version.body !== seed.body) continue;
      const node = getGenProject(projectId)?.nodes[member.nodeId];
      if (!node) continue;
      updateGenNode(projectId, member.nodeId, { versions: node.versions.map((version, index) => index === member.index
        ? { ...version, answerTermMarking: { fingerprint: answerMarkingFingerprint(version), state, error } } : version) });
    }
  };
  setProgress('pending');
  const commit = (apply: (node: ScatterNode) => ScatterNode) => {
    if (signal.aborted) return;
    const current = getGenProject(projectId)?.nodes[nodeId];
    if (!current || !answerVersion(current, ref)) return;
    const next = apply(current);
    if (next !== current) {
      // Explicit re-marking is a single reversible content action; automatic
      // enrichment belongs to its original generation instead.
      if (manual && useGraphStore.getState().project?.id === projectId) useGraphStore.getState().updateNode(nodeId, next);
      else updateGenNode(projectId, nodeId, next);
    }
  };
  try { await Promise.allSettled([
    (async () => {
      const lane = `chat-terms-${ref.versionCreatedAt}`;
      const error = (message?: string) => {
        const project = getGenProject(projectId);
        const members = !manual && project ? enrichmentMembers(project, nodeId, seed)
          : [{ nodeId, version: seed }];
        for (const member of members) {
          const runtime = useChatRuntimeStore.getState();
          runtime.view(member.nodeId, { termErrors: { ...runtime.views[member.nodeId]?.termErrors, [member.version.createdAt]: message } });
        }
      };
      error();
      useNodeStatusStore.getState().setProcessStatus(nodeId, lane, 'MARKING TERMS');
      try {
        const { body, failed } = await markChatTerms(manual ? stripTermMarkers(answer.body) : answer.body, signal);
        commit((node) => {
          const current = answerVersion(node, ref);
          if (!current || current.body !== answer.body) return node;
          // Read the latest cache: previews may finish while term selection runs.
          const next = { ...current, body, ...(manual ? { answerEnrichmentId: current.answerEnrichmentId ? newId() : undefined } : {}) };
          let termPreviews = reusableTermPreviews(next, [current]);
          if (manual && termPreviews) termPreviews = { ...termPreviews, exhaustedTerms: undefined, error: undefined };
          return updateChatAnswer(node, ref, { body, termPreviews, answerEnrichmentId: next.answerEnrichmentId,
            answerTermMarking: { fingerprint: answerMarkingFingerprint(next), state: failed ? 'failed' : 'complete',
              error: failed ? 'Some terms could not be marked. Use Redo terms to retry.' : undefined } });
        });
        if (!manual && !signal.aborted) {
          const project = getGenProject(projectId);
          if (project) for (const member of enrichmentMembers(project, nodeId, seed)) {
            if (member.nodeId === nodeId || member.version.body !== seed.body) continue;
            const node = getGenProject(projectId)?.nodes[member.nodeId];
            if (!node) continue;
            const next = { ...member.version, body };
            next.termPreviews = reusableTermPreviews(next, [member.version]);
            next.answerTermMarking = { fingerprint: answerMarkingFingerprint(next), state: failed ? 'failed' : 'complete',
              error: failed ? 'Some terms could not be marked. Use Redo terms to retry.' : undefined };
            updateGenNode(projectId, member.nodeId, { versions: node.versions.map((v, i) => i === member.index ? next : v) });
          }
        }
        if (failed) error('Some terms could not be marked. Your text is unchanged; try Redo terms.');
        if (!manual && seed.answerEnrichmentId) pendingAnswerTermMarking.delete(seed.answerEnrichmentId);
        if (!signal.aborted) {
          const project = getGenProject(projectId);
          const member = project && enrichmentMembers(project, nodeId, seed)[0];
          if (manual) void generateTermPreviews(nodeId, ref.versionCreatedAt);
          else if (member) void generateTermPreviews(member.nodeId, member.version.createdAt);
        }
      } catch (cause) {
        if (!lifecycle.signal.aborted) {
          const message = signal.aborted ? 'Term marking was interrupted. Use Redo terms to retry.'
            : `Term marking failed: ${cause instanceof Error ? cause.message : 'Unknown error'}. Use Redo terms to retry.`;
          error(message);
          setProgress('failed', message);
        }
      } finally { useNodeStatusStore.getState().clearProcessStatus(nodeId, lane); }
    })(),
    (async () => {
      // History displays the original questions. Only the node itself still
      // needs an automatic title, once after its first answer.
      if (manual || !initial.chat || initial.chat.titleManual || initial.chat.turns[0]?.id !== ref.turnId) return;
      const raw = await secondaryTaskCompletion({
        system: configuredPrompt('chatTitle') + '\n\n' + generationLanguagePrompt(versionLanguage(answer)),
        user: JSON.stringify({ question: answer.chat!.question, answer: plain }),
        maxOutputTokens: 256, signal,
      });
      const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as {
        chatTitle?: unknown;
      };
      commit((node) => {
        if (!node.chat!.titleManual && node.chat!.turns[0]?.id === ref.turnId
          && typeof parsed.chatTitle === 'string') {
          return { ...node, chat: { ...node.chat!, title: chatFallbackTitle(parsed.chatTitle) } };
        }
        return node;
      });
    })(),
  ]); } finally {
    unsubscribe(); marking.delete(taskKey);
    if (!manual && seed.answerEnrichmentId) pendingAnswerTermMarking.delete(seed.answerEnrichmentId);
  }
}
