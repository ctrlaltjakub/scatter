'use client';
import { useMemo } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useChatRuntimeStore, chatDraftKey, EMPTY_CHAT_DRAFT } from '@/store/useChatRuntimeStore';
import { buildChatContext, chatSystemPrompt, estimateMessagesTokens } from '@/lib/chat/context';
import { captureChatParent, chatParentPending, conversationPath } from '@/lib/chat/model';
import { effectiveSourceMode, sourceLibrary } from '@/lib/projectSources';
import type { NodeVersion, ScatterNode } from '@/store/types';

export function ChatContextUsage({ node }: { node: ScatterNode }) {
  const projectId = useGraphStore((s) => s.project?.id ?? '');
  const library = useGraphStore((s) => s.project?.sourceLibrary);
  const parentVersion = useGraphStore((s) => {
    const parent = node.chat?.parentNodeId ? s.project?.nodes[node.chat.parentNodeId] : undefined;
    return parent?.versions[parent.currentVersionIndex];
  });
  const parentPending = useGraphStore((s) => chatParentPending(node.chat?.parentNodeId ? s.project?.nodes[node.chat.parentNodeId] : undefined));
  const settings = useSettingsStore();
  const models = useModelCatalogStore((s) => s.catalog);
  const draft = useChatRuntimeStore((s) => s.drafts[chatDraftKey(projectId, node.id)] ?? EMPTY_CHAT_DRAFT);
  const sourceTokens = useChatRuntimeStore((s) => s.views[node.id]?.sourceTokens ?? 0);
  const input = useMemo(() => {
    if (!node.chat) return 0;
    try {
      const project = useGraphStore.getState().project;
      const parent = node.chat.parentNodeId ? project?.nodes[node.chat.parentNodeId] : undefined;
      const captured = parent && !chatParentPending(parent) ? captureChatParent(parent, 'context-estimate') : undefined;
      const snapshot = captured && (Object.values(node.chat.parentSnapshots).find((item) =>
        item.nodeId === captured.nodeId && item.versionCreatedAt === captured.versionCreatedAt
        && item.fingerprint === captured.fingerprint && item.header === captured.header && item.body === captured.body) ?? captured);
      const estimating = snapshot ? { ...node, chat: { ...node.chat,
        parentSnapshots: { ...node.chat.parentSnapshots, [snapshot.id]: snapshot } } } : node;
      const answer: NodeVersion = { header: '', body: '', createdAt: 0, generatedBy: 'chat', chat: {
        turnId: '', question: draft.text, attachments: draft.attachments, reference: draft.reference,
        informationChunking: node.chat.informationChunking, title: '', state: 'generating',
        contextPath: conversationPath(node), parentSnapshotId: snapshot?.id,
      } };
      const context = buildChatContext({ node: estimating, answer,
        system: chatSystemPrompt(node.chat.informationChunking, settings.normalChatInstructions ?? '', settings.webSearch) });
      return estimateMessagesTokens(context.messages)
        + (context.imageSnapshots.size + [...context.attachmentImages.values()].reduce((sum, items) => sum + items.length, 0)) * 2300
        + (effectiveSourceMode(sourceLibrary(project)) === 'ignore' ? 0 : sourceTokens);
    } catch { return 0; }
  }, [node.chat, node.versions, draft, parentVersion, parentPending, library, sourceTokens,
    settings.normalChatInstructions, settings.webSearch]);
  const model = settings.activeModelRef;
  const capacity = model && models[model.providerId]?.find((info) => info.id === model.model)?.contextLength;
  return <span className="node-tag chat-context-usage" tabIndex={0}
    data-tip="Estimated input usage for the selected main model: conversation, memory, parent, instructions and the last source retrieval. Actual source selection and tokenization can differ. Output space is reserved separately. Compaction preserves the complete readable chat.">
    {capacity ? `Context ~${Math.min(999, Math.round(input / capacity * 100))}%` : 'Context —'}
  </span>;
}
