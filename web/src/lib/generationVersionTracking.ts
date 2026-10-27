import { getGenProject } from '@/store/bgGen';
import { useGraphStore } from '@/store/useGraphStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { cancelGenerationSession, getGenerationSession, registerGenerationCleanup, type GenerationSession } from './generationSession';

const tracked = new WeakSet<GenerationSession>();

/** Version identities survive deleting an older row and undoing that deletion.
 * Keep runtime indexes aligned without stopping the captured provider request. */
export function trackGenerationVersions(session: GenerationSession): void {
  if (tracked.has(session)) return;
  const initial = getGenProject(session.projectId)?.nodes[session.nodeId];
  const draft = initial?.versions[session.draftVersionIndex];
  if (!initial || !draft) return;
  const source = session.sourceVersionIndex == null ? undefined : initial.versions[session.sourceVersionIndex];
  tracked.add(session);
  let previousVersions = initial.versions;
  const sync = () => {
    const node = getGenProject(session.projectId)?.nodes[session.nodeId];
    if (!node || node.versions === previousVersions) return;
    previousVersions = node.versions;
    const draftIndex = node.versions.findIndex(version => version.createdAt === draft.createdAt);
    if (draftIndex < 0) {
      if (getGenerationSession(session.projectId, session.nodeId)?.id === session.id) {
        cancelGenerationSession(session.projectId, session.nodeId);
      }
      return;
    }
    session.draftVersionIndex = draftIndex;
    const sourceIndex = source ? node.versions.findIndex(version => version.createdAt === source.createdAt) : -1;
    session.sourceVersionIndex = sourceIndex < 0 ? null : sourceIndex;
    const store = useRewriteStore.getState();
    const snapshot = store.snapshot[session.nodeId];
    const sourceFallback = sourceIndex < 0 ? draftIndex : sourceIndex;
    if (snapshot?.generationSessionId === session.id
      && (snapshot.draftVersionIndex !== draftIndex || snapshot.preBurstVersionIndex !== sourceFallback)) {
      store.setSnapshot(session.nodeId, { ...snapshot, draftVersionIndex: draftIndex, preBurstVersionIndex: sourceFallback });
    }
  };
  registerGenerationCleanup(session, useGraphStore.subscribe(sync));
}
