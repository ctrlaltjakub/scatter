import type { NodeVersion, ScatterNode } from '@/store/types';
import type {
  ChatAnswerMetadata, ChatAnswerRef, ChatConversation, ChatParentSnapshot,
} from '@/store/chatTypes';
import { stripChips } from '@/lib/bulletParse';
import { stringHash as hashPrompt } from '@/lib/stringHash';

export const CHAT_NODE_WIDTH = 672;
export const CHAT_MIN_BODY_HEIGHT = 120;

export function chatInitialBodyHeight(screenHeight: number, readingZoom = 0.75): number {
  const zoom = Math.max(0.35, Math.min(1.5, readingZoom));
  return Math.max(CHAT_MIN_BODY_HEIGHT, Math.round(((screenHeight - 40) / zoom - 210) * 0.6));
}

export function chatFallbackTitle(question: string): string {
  const text = question.replace(/\s+/g, ' ').trim();
  if (text.length <= 72) return text || 'Chat';
  const head = text.slice(0, 72);
  const boundary = head.lastIndexOf(' ');
  return head.slice(0, boundary > 36 ? boundary : 72).trim();
}

export function createChatNode(options: {
  id: string; createdAt: number; position: { x: number; y: number };
  parentNodeId?: string; groupId?: string; bodyHeight: number; informationChunking?: boolean;
}): ScatterNode {
  const { id, createdAt, position, parentNodeId, groupId } = options;
  return {
    id, type: 'chat', position: { ...position }, frozen: false, groupId,
    currentVersionIndex: 0,
    versions: [{
      header: 'Chat', body: '', createdAt, generatedBy: 'chat', contentType: 'chat',
      width: CHAT_NODE_WIDTH, minWidth: 520,
      bodyMaxHeight: Math.max(CHAT_MIN_BODY_HEIGHT, options.bodyHeight),
      minBodyHeight: CHAT_MIN_BODY_HEIGHT,
    }],
    chat: {
      title: 'Chat', informationChunking: options.informationChunking ?? true, turns: [], parentNodeId,
      parentSnapshots: {}, compactions: [],
    },
  };
}

export function answerVersion(node: ScatterNode, ref: ChatAnswerRef): NodeVersion | undefined {
  return node.versions.find((version) => version.createdAt === ref.versionCreatedAt
    && version.chat?.turnId === ref.turnId);
}

export function conversationPath(node: ScatterNode): ChatAnswerRef[] {
  return node.chat?.turns.map((turn) => ({
    turnId: turn.id, versionCreatedAt: turn.selectedVersionCreatedAt,
  })) ?? [];
}

export function sameChatPath(a: readonly ChatAnswerRef[], b: readonly ChatAnswerRef[]): boolean {
  return a.length === b.length && a.every((ref, i) => ref.turnId === b[i]?.turnId
    && ref.versionCreatedAt === b[i]?.versionCreatedAt);
}

export function validMemoryForPath(chat: ChatConversation, path: ChatAnswerRef[]) {
  const memory = chat.memory;
  return memory && sameChatPath(memory.coveredPath, path.slice(0, memory.coveredPath.length))
    ? memory : undefined;
}

/** A completed displayed alternative is usable while a different one streams. */
export function chatParentPending(parent: ScatterNode | undefined): boolean {
  return !!parent?.generating && (parent.generatingVersionIndex == null
    || parent.generatingVersionIndex === parent.currentVersionIndex);
}

export function captureChatParent(parent: ScatterNode, id: string, allowPending = false): ChatParentSnapshot {
  const version = parent.versions[parent.currentVersionIndex];
  if (!version) throw new Error('The parent version is unavailable.');
  if (!allowPending && chatParentPending(parent)) throw new Error('Wait for the displayed parent version to finish.');
  const body = stripChips(version.body);
  const signature = JSON.stringify([version.header, body, version.media ?? null,
    version.sources ?? null, version.internalSources ?? null]);
  return structuredClone({
    id, nodeId: parent.id, versionCreatedAt: version.createdAt,
    fingerprint: `${hashPrompt(signature)}:${signature.length}`,
    header: version.header, body, media: version.media,
    sources: version.sources, internalSources: version.internalSources,
  });
}

export function appendChatAnswer(node: ScatterNode, options: {
  turnId: string; createdAt: number; question: string;
  metadata?: Partial<Omit<ChatAnswerMetadata, 'turnId' | 'question' | 'contextPath'>>;
  parentSnapshot?: ChatParentSnapshot;
  replaceLatest?: boolean;
}): ScatterNode {
  if (!node.chat) throw new Error('This node is not a chat.');
  const latest = node.chat.turns.at(-1);
  if (options.replaceLatest && latest?.id !== options.turnId) {
    throw new Error('Only the last message can be regenerated or edited.');
  }
  if (node.versions.some((v) => v.createdAt === options.createdAt)) {
    throw new Error('Answer identity already exists.');
  }
  const contextPath = conversationPath(node).slice(0, options.replaceLatest ? -1 : undefined);
  const previous = node.versions[node.currentVersionIndex];
  const snapshot = options.parentSnapshot;
  const knownSnapshot = snapshot && Object.values(node.chat.parentSnapshots).find((item) =>
    item.nodeId === snapshot.nodeId && item.versionCreatedAt === snapshot.versionCreatedAt
    && item.fingerprint === snapshot.fingerprint
    && item.header === snapshot.header && item.body === snapshot.body
    && JSON.stringify([item.media, item.sources, item.internalSources])
      === JSON.stringify([snapshot.media, snapshot.sources, snapshot.internalSources]));
  const parentSnapshot = knownSnapshot ?? snapshot;
  const metadata: ChatAnswerMetadata = {
    ...options.metadata,
    turnId: options.turnId, question: options.question,
    informationChunking: options.metadata?.informationChunking ?? node.chat.informationChunking,
    state: 'generating', title: chatFallbackTitle(options.question), contextPath,
    parentSnapshotId: parentSnapshot?.id ?? options.metadata?.parentSnapshotId,
  };
  const version: NodeVersion = {
    header: metadata.title, body: '', createdAt: options.createdAt,
    generatedBy: 'chat', contentType: 'chat', chat: metadata,
    width: previous?.width ?? CHAT_NODE_WIDTH, minWidth: previous?.minWidth ?? 520,
    bodyMaxHeight: previous?.bodyMaxHeight ?? 600, minBodyHeight: CHAT_MIN_BODY_HEIGHT,
  };
  const versions = [...node.versions, version];
  const turns = options.replaceLatest
    ? node.chat.turns.map((turn) => turn.id === options.turnId ? {
      ...turn, versionCreatedAts: [...turn.versionCreatedAts, options.createdAt],
      selectedVersionCreatedAt: options.createdAt,
    } : turn)
    : [...node.chat.turns, {
      id: options.turnId, versionCreatedAts: [options.createdAt],
      selectedVersionCreatedAt: options.createdAt,
    }];
  return {
    ...node, versions, currentVersionIndex: versions.length - 1,
    generating: true, generatingVersionIndex: versions.length - 1, streamingText: true,
    chat: {
      ...node.chat, turns,
      title: node.chat.turns.length || node.chat.titleManual
        ? node.chat.title : chatFallbackTitle(options.question),
      parentSnapshots: parentSnapshot && !knownSnapshot ? {
        ...node.chat.parentSnapshots, [parentSnapshot.id]: structuredClone(parentSnapshot),
      } : node.chat.parentSnapshots,
      compactions: node.chat.compactions.map((entry) => entry.consumedAt
        ? entry : { ...entry, consumedAt: options.createdAt }),
    },
  };
}

export function updateChatAnswer(
  node: ScatterNode, ref: ChatAnswerRef,
  patch: Partial<Omit<NodeVersion, 'createdAt' | 'chat'>>,
  metadata?: Partial<Omit<ChatAnswerMetadata, 'turnId' | 'question' | 'contextPath'>>,
): ScatterNode {
  const index = node.versions.findIndex((version) => version.createdAt === ref.versionCreatedAt
    && version.chat?.turnId === ref.turnId);
  if (index < 0) return node;
  const previous = node.versions[index];
  if (!previous?.chat) return node;
  const versions = node.versions.slice();
  versions[index] = { ...previous, ...patch, chat: { ...previous.chat!, ...metadata } };
  return { ...node, versions };
}

export function selectLatestChatAlternative(node: ScatterNode, ref: ChatAnswerRef): ScatterNode {
  if (!node.chat || node.chat.turns.at(-1)?.id !== ref.turnId || !answerVersion(node, ref)) return node;
  return { ...node, chat: { ...node.chat, turns: node.chat.turns.map((turn) => turn.id === ref.turnId
    ? { ...turn, selectedVersionCreatedAt: ref.versionCreatedAt } : turn) } };
}

/** Only the latest turn is editable: older answers may be in later context paths.
 * The last remaining answer is deliberately left to the whole-turn action. */
export function removeChatAnswer(node: ScatterNode, ref: ChatAnswerRef): ScatterNode {
  const last = node.chat?.turns.at(-1);
  if (!node.chat || last?.id !== ref.turnId || last.versionCreatedAts.length < 2
    || !last.versionCreatedAts.includes(ref.versionCreatedAt) || !answerVersion(node, ref)) return node;
  if (node.generating) throw new Error('Stop generating before deleting an answer.');
  const deletedIndex = last.versionCreatedAts.indexOf(ref.versionCreatedAt);
  const versionCreatedAts = last.versionCreatedAts.filter(createdAt => createdAt !== ref.versionCreatedAt);
  const selectedVersionCreatedAt = last.selectedVersionCreatedAt === ref.versionCreatedAt
    ? versionCreatedAts[Math.max(0, deletedIndex - 1)]! : last.selectedVersionCreatedAt;
  const versions = node.versions.filter(version => version.createdAt !== ref.versionCreatedAt);
  const displayedAt = node.versions[node.currentVersionIndex]?.createdAt;
  const affectedMemory = (memory: ChatConversation['memory']) => memory?.coveredPath.some(item =>
    item.turnId === ref.turnId && item.versionCreatedAt === ref.versionCreatedAt);
  return { ...node, versions,
    currentVersionIndex: Math.max(0, versions.findIndex(version => version.createdAt ===
      (displayedAt === ref.versionCreatedAt ? selectedVersionCreatedAt : displayedAt))),
    chat: { ...node.chat,
      turns: node.chat.turns.map(turn => turn.id === ref.turnId ? { ...turn, versionCreatedAts, selectedVersionCreatedAt } : turn),
      memory: affectedMemory(node.chat.memory) ? undefined : node.chat.memory,
      compactions: node.chat.compactions.filter(item => !affectedMemory(item.memory))
        .map(item => affectedMemory(item.previousMemory) ? { ...item, previousMemory: undefined } : item),
    },
  };
}

export function removeLastChatTurn(node: ScatterNode): ScatterNode {
  if (!node.chat || !node.chat.turns.length) return node;
  if (node.generating) throw new Error('Stop generating before deleting the last turn.');
  const last = node.chat.turns.at(-1)!;
  const versions = node.versions.filter((version) => version.chat?.turnId !== last.id);
  const turns = node.chat.turns.slice(0, -1);
  const memory = node.chat.memory?.coveredPath.some((ref) => ref.turnId === last.id)
    ? undefined : node.chat.memory;
  const compactions = node.chat.compactions.filter((item) => !item.memory.coveredPath
    .some((ref) => ref.turnId === last.id)).map((item) => item.afterTurnId === last.id
      ? { ...item, afterTurnId: turns.at(-1)?.id } : item);
  const selectedAt = turns.at(-1)?.selectedVersionCreatedAt;
  return { ...node, versions, currentVersionIndex: Math.max(0,
    versions.findIndex((version) => version.createdAt === selectedAt)),
  chat: { ...node.chat, turns, memory, compactions } };
}

/** Save interruption markers in the durable copy, never mutate a running job. */
export function recoverChatNode(node: ScatterNode): ScatterNode {
  if (!node.chat || (!node.generating && !node.streamingText && node.generatingVersionIndex == null && !node.versions.some((v) => v.chat?.state === 'generating'
    || v.chat?.tools?.some((tool) => tool.state === 'running')))) return node;
  return { ...node, generating: false, streamingText: false, generatingVersionIndex: undefined,
    versions: node.versions.map((version) => !version.chat ? version : {
    ...version, chat: { ...version.chat,
      state: version.chat.state === 'generating' ? 'interrupted' : version.chat.state,
      tools: version.chat.tools?.map((tool) => tool.state === 'running'
        ? { ...tool, state: 'stopped' as const, resultSummary: 'Interrupted' } : tool),
    },
  }) };
}

export function forkChatConversation(
  source: ScatterNode, endpoint: ChatAnswerRef, newNodeId: string,
  nextTurnId: () => string,
): { node: ScatterNode; turnIds: Map<string, string> } {
  if (!source.chat || !answerVersion(source, endpoint)) throw new Error('This answer is unavailable.');
  const end = source.chat.turns.findIndex((turn) => turn.id === endpoint.turnId);
  if (end < 0) throw new Error('This turn is unavailable.');
  const copy = structuredClone(recoverChatNode(source));
  const chat = copy.chat!;
  const included = chat.turns.slice(0, end + 1);
  const turnIds = new Map(included.map((turn) => [turn.id, nextTurnId()]));
  const remap = (ref: ChatAnswerRef): ChatAnswerRef => ({
    ...ref, turnId: turnIds.get(ref.turnId) ?? ref.turnId,
  });
  const originalPath = answerVersion(source, endpoint)!.chat!.contextPath;
  chat.turns = included.map((turn, i) => ({
    ...turn, id: turnIds.get(turn.id)!,
    selectedVersionCreatedAt: i === end ? endpoint.versionCreatedAt
      : originalPath.find((ref) => ref.turnId === turn.id)?.versionCreatedAt
        ?? turn.selectedVersionCreatedAt,
  }));
  copy.versions = copy.versions.filter((version) => !version.chat || turnIds.has(version.chat.turnId))
    .map((version) => !version.chat ? version : { ...version, chat: {
      ...version.chat, turnId: turnIds.get(version.chat.turnId)!,
      contextPath: version.chat.contextPath.map(remap),
      reference: version.chat.reference && { ...version.chat.reference, ...remap(version.chat.reference) },
      outlineParentTurnId: version.chat.outlineParentTurnId
        ? turnIds.get(version.chat.outlineParentTurnId) : undefined,
    } });
  const usedSnapshots = new Set(copy.versions.flatMap((version) => version.chat?.parentSnapshotId ? [version.chat.parentSnapshotId] : []));
  chat.parentSnapshots = Object.fromEntries(Object.entries(chat.parentSnapshots).filter(([id]) => usedSnapshots.has(id)));
  // Memory and its history entry can share an object after structuredClone.
  // Replacing it prevents remapping the history entry's IDs a second time.
  if (chat.memory) chat.memory = { ...chat.memory, coveredPath: chat.memory.coveredPath.map(remap) };
  chat.memory = validMemoryForPath(chat, chat.turns.map((turn) => ({
    turnId: turn.id, versionCreatedAt: turn.selectedVersionCreatedAt,
  })));
  chat.compactions = chat.compactions.flatMap((item) => {
    const refs = item.memory.coveredPath;
    if (!refs.every((ref) => turnIds.has(ref.turnId))) return [];
    const memory = { ...item.memory, coveredPath: refs.map(remap) };
    if (!sameChatPath(memory.coveredPath, chat.turns.slice(0, refs.length).map((turn) => ({
      turnId: turn.id, versionCreatedAt: turn.selectedVersionCreatedAt,
    })))) return [];
    return [{ ...item, memory, afterTurnId: item.afterTurnId
      ? turnIds.get(item.afterTurnId) ?? chat.turns.at(-1)?.id : undefined, previousMemory: item.previousMemory && {
      ...item.previousMemory, coveredPath: item.previousMemory.coveredPath.map(remap),
    } }];
  });
  chat.forkedFrom = { nodeId: source.id, ...endpoint };
  const question = answerVersion(source, endpoint)!.chat!.question.replace(/\s+/g, ' ').trim() || 'Attached files';
  const preview = chatFallbackTitle(question);
  chat.title = `${source.chat.title} — forked at “${preview}${preview.length < question.length ? '…' : ''}”`;
  // Preserve this identifying title when the first copied answer is regenerated.
  chat.titleManual = true;
  copy.id = newNodeId;
  copy.type = 'chat';
  copy.frozen = false;
  copy.currentVersionIndex = copy.versions.findIndex((version) => version.createdAt === endpoint.versionCreatedAt);
  delete copy.generating;
  delete copy.generatingVersionIndex;
  delete copy.streamingText;
  delete copy.generationError;
  return { node: copy, turnIds };
}
