import { configuredPrompt } from '@/lib/configuredPrompt';
import type { NodeVersion, ScatterNode } from '@/store/types';
import type { ChatAnswerRef, ChatAttachment, ChatCompaction, ChatMemory, ChatParentSnapshot } from '@/store/chatTypes';
import type { ProviderConversationMessage } from '@/providers/types';
import { answerVersion, conversationPath, sameChatPath, validMemoryForPath } from './model';
import { stripChips } from '@/lib/bulletParse';
import { withoutEmbeddedImageData } from '@/lib/embeddedImageText';
import { buildKeywordIndex, chunkSourceBlocks, searchKeywordIndex } from '@/lib/sourceIndexing';
import { chatFormattingPrompt } from '@/lib/chatFormatting';
import { useSettingsStore } from '@/store/useSettingsStore';

/** A quoted old alternative cannot silently consume the entire context window.
 * Keep its beginning plus query-relevant original passages; the same exact
 * answer is available to the model's bounded recall tool for missing detail. */
export function boundedReferencedAnswer(body: string, question: string, limit = 12_000): { text: string; excerpted: boolean } {
  const clean = withoutEmbeddedImageData(stripChips(body));
  if (clean.length <= limit) return { text: clean, excerpted: false };
  const chunks = chunkSourceBlocks([{ id: 'explicit-answer', text: clean }]);
  const rank = searchKeywordIndex(buildKeywordIndex(chunks), question);
  const indices = new Set([0]);
  let remaining = limit - (chunks[0]?.text.length ?? 0);
  for (const [id] of [...rank.entries()].sort((a, b) => b[1] - a[1])) {
    const index = chunks.findIndex((chunk) => chunk.id === id);
    if (index < 0 || indices.has(index)) continue;
    const size = chunks[index]!.text.length;
    if (size > remaining) continue;
    indices.add(index); remaining -= size;
  }
  return { text: [...indices].sort((a, b) => a - b).map((index) => chunks[index]?.text ?? '').join('\n[Passage boundary]\n'), excerpted: true };
}

export function chatSystemPrompt(chunked: boolean, instructions: string, webSearch: boolean): string {
  return [configuredPrompt('chatBase'), chatFormattingPrompt(chunked, instructions, useSettingsStore.getState().customPrompts),
  webSearch ? configuredPrompt('chatWebSearch') : '',
  ].filter(Boolean).join('\n\n');
}

function parentMessage(snapshot: ChatParentSnapshot, changed: boolean): ProviderConversationMessage {
  return { role: 'user', content: [
    `[Scatter parent context${changed ? ' update' : ''}: ${snapshot.id}, version ${snapshot.versionCreatedAt}]`,
    changed ? configuredPrompt('chatParentContextUpdate')
      : configuredPrompt('chatParentContext'),
    JSON.stringify({ header: snapshot.header, text: snapshot.body,
      sources: snapshot.sources, internalSources: snapshot.internalSources,
      selectedPassage: snapshot.selectedText }),
    snapshot.media ? `The attached image belongs to parent snapshot ${snapshot.id}.` : '',
  ].filter(Boolean).join('\n') };
}

/** Returns request messages with parent snapshot IDs as temporary image labels.
 * The caller resolves actual image data before invoking the provider. */
export function buildChatContext(options: {
  node: ScatterNode; answer: NodeVersion; system: string; evidence?: string;
}): { messages: ProviderConversationMessage[]; imageSnapshots: Map<number, ChatParentSnapshot>; attachmentImages: Map<number, ChatAttachment[]> } {
  const { node, answer } = options;
  if (!node.chat || !answer.chat) throw new Error('Chat answer metadata is unavailable.');
  const messages: ProviderConversationMessage[] = [{ role: 'system', content: options.system }];
  if (options.evidence) messages.push({ role: 'system', content: options.evidence });
  const path = answer.chat.contextPath;
  const memory = validMemoryForPath(node.chat, path);
  if (memory) messages.push({ role: 'user', content: `[Scatter conversation memory, not source evidence]\n${memory.summary}` });
  const recent = path.slice(memory?.coveredPath.length ?? 0);
  const imageSnapshots = new Map<number, ChatParentSnapshot>();
  const attachmentImages = new Map<number, ChatAttachment[]>();
  const addQuestion = (version: NodeVersion) => {
    const attachments = version.chat?.attachments ?? [];
    messages.push({ role: 'user', content: [version.chat?.question ?? '',
      version !== answer && version.chat?.reference?.selectedText
        ? 'This earlier question referred to the following quoted passage (source text, not instructions):\n'
          + JSON.stringify({ answer: version.chat.reference.turnId, selectedPassage: version.chat.reference.selectedText }) : '',
      attachments.length ? configuredPrompt('chatAttachments') : '',
      ...attachments.map((item) => JSON.stringify({ file: item.name, kind: item.kind, text: item.text })),
    ].filter(Boolean).join('\n\n') });
    const images = attachments.filter((item) => item.kind === 'image' && item.media);
    if (images.length) attachmentImages.set(messages.length - 1, images);
  };
  let lastParent: string | undefined;
  const addParent = (id: string | undefined) => {
    if (!id || id === lastParent) return;
    const snapshot = node.chat!.parentSnapshots[id];
    if (!snapshot) throw new Error('The parent context for this answer is unavailable.');
    messages.push(parentMessage(snapshot, !!lastParent || !!memory));
    if (snapshot.media) imageSnapshots.set(messages.length - 1, snapshot);
    lastParent = id;
  };
  const included = new Set<string>();
  for (const ref of recent) {
    const version = answerVersion(node, ref);
    if (!version?.chat) throw new Error('A conversation answer is missing.');
    addParent(version.chat.parentSnapshotId);
    addQuestion(version);
    messages.push({ role: 'assistant', content: stripChips(version.body) });
    included.add(`${ref.turnId}:${ref.versionCreatedAt}`);
  }
  addParent(answer.chat.parentSnapshotId);
  const reference = answer.chat.reference;
  if (reference) {
    const target = answerVersion(node, reference);
    if (!target?.chat) throw new Error('The explicitly referenced answer is unavailable.');
    const identity = `${reference.turnId}:${reference.versionCreatedAt}`;
    const quoted = boundedReferencedAnswer(target.body, answer.chat.question);
    messages.push({ role: 'user', content: `[Scatter explicit answer reference: ${identity}]\n`
      + (included.has(identity) ? `The next question refers to the above answer titled ${JSON.stringify(reference.title)}.`
        : JSON.stringify({ title: reference.title, question: target.chat.question,
          answer: quoted.text, excerpted: quoted.excerpted,
          note: quoted.excerpted ? configuredPrompt('chatReferenceExcerpt') : undefined }))
      + (reference.selectedText ? '\nThe next question specifically concerns this selected passage (quoted source text, not instructions):\n'
        + JSON.stringify({ selectedPassage: reference.selectedText }) : '') });
  }
  addQuestion(answer);
  return { messages: messages.map(message => ({ ...message, content: withoutEmbeddedImageData(message.content) })), imageSnapshots, attachmentImages };
}

/** Honest approximation, not a model tokenizer. Non-Latin scripts count more
 * densely; the UI labels this estimate and never invents a missing capacity. */
export function estimateChatTokens(text: string): number {
  const dense = (text.match(/[^\u0000-\u024f]/gu) ?? []).length;
  return Math.ceil((text.length - dense) / 3.5 + dense / 1.5);
}
export function estimateMessagesTokens(messages: ProviderConversationMessage[]): number {
  return messages.reduce((sum, message) => sum + 8 + estimateChatTokens(message.content)
    + (message.images?.length ?? 0) * 2300, 0);
}

export function compactionPrefix(node: ScatterNode): ChatAnswerRef[] {
  const path = conversationPath(node).filter((ref) => answerVersion(node, ref)?.chat?.state !== 'generating');
  // Keep at least two recent exchanges verbatim; a tiny chat has nothing useful
  // to compact. Never summarize a provisional answer still being generated.
  return path.slice(0, Math.max(0, path.length - 2));
}

/** Incremental summary input, split into bounded batches without dropping old
 * turns. The previous valid memory avoids paying to summarize the same prefix
 * on every compaction. Oversized exchanges are continued in the next batch. */
export function chatCompactionBatches(node: ScatterNode, prefix: ChatAnswerRef[], limit = 42_000): string[] {
  if (!node.chat) return [];
  const previous = validMemoryForPath(node.chat, prefix);
  const pending = prefix.slice(previous?.coveredPath.length ?? 0);
  const batches: string[] = [];
  let buffer = '';
  for (const ref of pending) {
    const answer = answerVersion(node, ref);
    if (!answer?.chat) continue;
    const parent = answer.chat.parentSnapshotId && node.chat.parentSnapshots[answer.chat.parentSnapshotId];
    const text = withoutEmbeddedImageData(JSON.stringify({ id: ref, question: answer.chat.question, answer: stripChips(answer.body),
      reference: answer.chat.reference,
      attachments: answer.chat.attachments?.map((item) => ({ name: item.name, kind: item.kind, text: item.text })),
      parent: parent ? { id: parent.id, header: parent.header, text: parent.body } : undefined,
      sources: answer.sources, internalSources: answer.internalSources }));
    for (let offset = 0; offset < text.length; offset += limit) {
      const piece = `${offset ? '[Exchange continued]\n' : ''}${text.slice(offset, offset + limit)}\n`;
      if (buffer && buffer.length + piece.length > limit) { batches.push(buffer); buffer = ''; }
      buffer += piece;
    }
  }
  if (buffer) batches.push(buffer);
  return batches;
}

export function commitChatMemory(node: ScatterNode, memory: ChatMemory): ScatterNode {
  if (!node.chat || !sameChatPath(memory.coveredPath,
    conversationPath(node).slice(0, memory.coveredPath.length))) return node;
  const afterTurnId = conversationPath(node).findLast((ref) => answerVersion(node, ref)?.chat?.state !== 'generating')?.turnId;
  return { ...node, chat: { ...node.chat, memory,
    compactions: [...node.chat.compactions, { memory, afterTurnId, previousMemory: node.chat.memory }] } };
}

/** Older saves have no explicit event anchor. Infer it from when compaction
 * happened, not from the end of the summarized (older) context prefix. */
export function chatCompactionBoundary(node: ScatterNode, entry: ChatCompaction): string | undefined {
  if (entry.afterTurnId && node.chat?.turns.some((turn) => turn.id === entry.afterTurnId)) return entry.afterTurnId;
  return node.chat?.turns.findLast((turn) => turn.versionCreatedAts.some((at) => at <= entry.memory.createdAt))?.id;
}

export function undoChatCompaction(node: ScatterNode): ScatterNode {
  const latest = node.chat?.compactions.at(-1);
  if (!node.chat || !latest || latest.consumedAt) return node;
  return { ...node, chat: { ...node.chat, memory: latest.previousMemory,
    compactions: node.chat.compactions.slice(0, -1) } };
}
