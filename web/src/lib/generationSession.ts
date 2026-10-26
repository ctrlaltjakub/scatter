/** Runtime-only ownership for every pass that belongs to one node generation. */

export type GenerationSessionKind = 'spawn' | 'rewrite';

export interface GenerationSession {
  id: number;
  projectId: string;
  nodeId: string;
  kind: GenerationSessionKind;
  sourceVersionIndex: number | null;
  draftVersionIndex: number;
  modelTextReceived: boolean;
  controllers: Set<AbortController>;
}

type BeginGenerationSession = Pick<GenerationSession,
  'projectId' | 'nodeId' | 'kind' | 'sourceVersionIndex' | 'draftVersionIndex'>;

const sessions = new Map<string, GenerationSession>();
let nextSessionId = 1;

const keyOf = (projectId: string, nodeId: string) => `${projectId}\u0000${nodeId}`;

export function beginGenerationSession(input: BeginGenerationSession): GenerationSession {
  const key = keyOf(input.projectId, input.nodeId);
  const previous = sessions.get(key);
  if (previous) {
    for (const controller of previous.controllers) controller.abort();
  }
  const session: GenerationSession = {
    ...input,
    id: nextSessionId++,
    modelTextReceived: false,
    controllers: new Set(),
  };
  sessions.set(key, session);
  return session;
}

export function getGenerationSession(
  projectId: string,
  nodeId: string,
): GenerationSession | undefined {
  return sessions.get(keyOf(projectId, nodeId));
}

export function registerGenerationController(
  sessionId: number,
  controller: AbortController,
): () => void {
  const session = [...sessions.values()].find((candidate) => candidate.id === sessionId);
  if (!session) {
    controller.abort();
    return () => undefined;
  }
  session.controllers.add(controller);
  return () => session.controllers.delete(controller);
}

export function markGenerationTextReceived(sessionId: number): void {
  const session = [...sessions.values()].find((candidate) => candidate.id === sessionId);
  if (session) session.modelTextReceived = true;
}

export function cancelGenerationSession(
  projectId: string,
  nodeId: string,
): GenerationSession | undefined {
  const key = keyOf(projectId, nodeId);
  const session = sessions.get(key);
  if (!session) return undefined;
  sessions.delete(key);
  for (const controller of session.controllers) controller.abort();
  return session;
}

export function finishGenerationSession(
  projectId: string,
  nodeId: string,
  sessionId: number,
): void {
  const key = keyOf(projectId, nodeId);
  if (sessions.get(key)?.id === sessionId) sessions.delete(key);
}

export function resetGenerationSessionsForTests(): void {
  for (const session of sessions.values()) {
    for (const controller of session.controllers) controller.abort();
  }
  sessions.clear();
  nextSessionId = 1;
}
