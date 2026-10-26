import type { NodeVersion, Project } from '@/store/types';
import { termPreviewFingerprint } from '../termPreviewCore';
import { stringHash } from '../stringHash';
import { versionLanguage } from '../languages';

export const pendingAnswerTermMarking = new Set<string>();
export const answerMarkingFingerprint = (version: NodeVersion) =>
  `${versionLanguage(version)}:${version.body.length}:${stringHash(version.body)}`;

export function answerEnrichmentError(version: NodeVersion): string | undefined {
  if (version.answerTermMarking?.fingerprint === answerMarkingFingerprint(version) && version.answerTermMarking.error)
    return version.answerTermMarking.error;
  if (version.termPreviews?.fingerprint !== termPreviewFingerprint(version)) return;
  return version.termPreviews.error ?? (version.termPreviews.exhaustedTerms?.length
    ? 'Some term previews could not be generated. Use Redo terms to retry; completed previews are kept.' : undefined);
}

/** Re-key a verified cache when a chat answer becomes a detached answer.
 * The prose/context is unchanged; only the presentation and header differ. */
export function shareAnswerEnrichment(version: NodeVersion, id: string): NodeVersion {
  const next = { ...version, answerEnrichmentId: id };
  if (version.termPreviews?.fingerprint === termPreviewFingerprint(version)) {
    next.termPreviews = { ...version.termPreviews, fingerprint: termPreviewFingerprint(next) };
  }
  return next;
}

export function enrichmentMembers(project: Project, nodeId: string, seed: NodeVersion) {
  const members: Array<{ nodeId: string; index: number; version: NodeVersion }> = [];
  const nodes = seed.answerEnrichmentId ? Object.values(project.nodes) : project.nodes[nodeId] ? [project.nodes[nodeId]!] : [];
  for (const node of nodes) {
    node.versions.forEach((version, index) => {
      if (seed.answerEnrichmentId ? version.answerEnrichmentId === seed.answerEnrichmentId
        : version.createdAt === seed.createdAt) members.push({ nodeId: node.id, index, version });
    });
  }
  return members;
}
