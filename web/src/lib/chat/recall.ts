import { configuredPrompt } from '@/lib/configuredPrompt';
import type { ScatterNode, SourceChunk } from '@/store/types';
import type { ChatAnswerRef } from '@/store/chatTypes';
import { answerVersion } from './model';
import { buildKeywordIndex, chunkSourceBlocks, fuseSourceRanks, searchEmbeddingValues, searchKeywordIndex } from '@/lib/sourceIndexing';
import type { StoredKeywordIndex } from '@/lib/sourceCodec';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { embedSourceQuery, embedSourceTexts, GRANITE_EMBEDDING_DIMENSIONS } from '@/lib/graniteEmbeddings';
import { stripChips } from '@/lib/bulletParse';
import type { ChatTool } from './toolRuntime';
import { parseChatMarkdown, type ChatMdNode } from './markdownFields';
import { markdownText } from './markdown';

interface RecallIndex {
  signature: string;
  chunks: SourceChunk[];
  owners: Map<string, ChatAnswerRef & { attachmentName?: string }>;
  keyword: StoredKeywordIndex;
  vectors?: Float32Array;
  embedding?: Promise<void>;
}
const indexes = new Map<string, RecallIndex>();

/** Table rows remain meaningful even when a long answer must be excerpted.
 * Each retrieval block carries its nearby heading and the column labels. */
function recallBlocks(body: string): Array<{ text: string; section?: string }> {
  if (body.length <= 4000) return [{ text: body }];
  const blocks: Array<{ text: string; section?: string }> = [];
  let heading = '';
  const visit = (node: ChatMdNode) => {
    if (node.type === 'heading') { heading = markdownText(node); return; }
    if (node.type === 'table') {
      const rows = node.children ?? [], labels = rows[0]?.children?.map(markdownText) ?? [];
      for (const row of rows.slice(1)) blocks.push({ section: heading,
        text: row.children?.map((cell, i) => `${labels[i] || `Column ${i + 1}`}: ${markdownText(cell)}`).join('; ') ?? '' });
      return;
    }
    if (['paragraph', 'code'].includes(node.type)) {
      blocks.push({ section: heading, text: body.slice(node.position?.start.offset, node.position?.end.offset) }); return;
    }
    node.children?.forEach(visit);
  };
  visit(parseChatMarkdown(body));
  return blocks;
}

function recallIndex(node: ScatterNode, path: ChatAnswerRef[]): RecallIndex {
  const versions = path.map((ref) => answerVersion(node, ref)).filter((version) => !!version?.chat);
  // Bodies are immutable strings. No reindex on scroll, physics or focus.
  const signature = JSON.stringify(versions.map((version) => [version!.createdAt,
    version!.chat!.question, version!.body, version!.chat!.attachments]));
  const existing = indexes.get(node.id);
  if (existing?.signature === signature) return existing;
  const owners = new Map<string, ChatAnswerRef & { attachmentName?: string }>();
  const chunks = versions.flatMap((version) => {
    const id = `${version!.chat!.turnId}:${version!.createdAt}`;
    const blocks = [...recallBlocks(stripChips(version!.body)).map((block) => ({ ...block, attachmentName: undefined as string | undefined })),
      ...version!.chat!.attachments?.filter((item) => item.kind === 'text' && item.text)
        .map((item) => ({ text: item.text!, section: `Attached file: ${item.name}`, attachmentName: item.name })) ?? []];
    return blocks.flatMap((block, i) => {
      const blockId = `${id}:${i}`;
      owners.set(blockId, { turnId: version!.chat!.turnId, versionCreatedAt: version!.createdAt, attachmentName: block.attachmentName });
      return chunkSourceBlocks([{ ...block, id: blockId,
        text: `Question: ${version!.chat!.question}\n${block.attachmentName ? `Attached file ${block.attachmentName}` : 'Answer'}: ${block.text}` }]);
    });
  });
  const index: RecallIndex = { signature, chunks, owners, keyword: buildKeywordIndex(chunks) };
  if (indexes.size >= 8) indexes.delete(indexes.keys().next().value!);
  indexes.set(node.id, index);
  return index;
}

/** Warm only an already running local model. Never download one or hold up a
 * main answer for chat recall; keyword retrieval is immediately usable. */
export function warmChatRecall(node: ScatterNode, path: ChatAnswerRef[]): void {
  const index = recallIndex(node, path);
  if (useSourceRuntimeStore.getState().embeddingStatus !== 'ready'
    || index.vectors || index.embedding || !index.chunks.length) return;
  index.embedding = embedSourceTexts(index.chunks.map((chunk) => chunk.text), { batchSize: 4 })
    .then((vectors) => { index.vectors = vectors; }).catch(() => undefined)
    .finally(() => { index.embedding = undefined; });
}

export function conversationSearchTool(node: ScatterNode, path: ChatAnswerRef[]): ChatTool {
  const index = recallIndex(node, path);
  return {
    definition: { name: 'search_conversation',
      description: configuredPrompt('chatRecallTool'),
      parameters: { type: 'object', properties: { query: { type: 'string' } },
        required: ['query'], additionalProperties: false },
    },
    parse(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a search query.');
      const values = input as Record<string, unknown>;
      if (Object.keys(values).some((key) => key !== 'query') || typeof values.query !== 'string'
        || !values.query.trim() || values.query.length > 500) throw new Error('Search query must contain 1–500 characters.');
      return values.query.trim();
    },
    summary: (input) => `Searching earlier messages for “${String(input).slice(0, 90)}”`,
    async execute(input, signal) {
      const query = String(input);
      const keyword = searchKeywordIndex(index.keyword, query);
      const ranks = [keyword];
      if (index.vectors && useSourceRuntimeStore.getState().embeddingStatus === 'ready') {
        try {
          const vector = await embedSourceQuery(query);
          if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
          ranks.push(searchEmbeddingValues(index.chunks.map((chunk) => chunk.id),
            index.vectors, GRANITE_EMBEDDING_DIMENSIONS, vector));
        } catch (error) { if (signal.aborted) throw error; }
      }
      const ranked = [...fuseSourceRanks(ranks).entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      const seenWholeAnswers = new Set<string>();
      const found = ranked.flatMap(([id]) => {
        const chunk = index.chunks.find((candidate) => candidate.id === id);
        const ref = chunk && index.owners.get(chunk.blockId);
        const version = ref && answerVersion(node, ref);
        if (!chunk || !ref || !version) return [];
        const complete = !ref.attachmentName && version.body.length <= 4000;
        const answerKey = `${ref.turnId}:${ref.versionCreatedAt}`;
        if (complete && seenWholeAnswers.has(answerKey)) return [];
        if (complete) seenWholeAnswers.add(answerKey);
        return [{ ...ref, question: version.chat!.question,
          passage: complete ? stripChips(version.body) : chunk.text, section: chunk.section,
          completeAnswer: complete, sources: version.sources, internalSources: version.internalSources }];
      }).slice(0, 5);
      // Keep valid, complete JSON rather than letting the generic tool limit
      // cut off the middle of a source or a table row.
      const matches: typeof found = [];
      for (const match of found) {
        if (JSON.stringify([...matches, match]).length <= 14_000) matches.push(match);
      }
      return { text: JSON.stringify({ kind: 'conversation_memory_not_evidence', matches }),
        summary: matches.length ? `Found ${matches.length} earlier passages` : 'No matching earlier passages found' };
    },
  };
}
