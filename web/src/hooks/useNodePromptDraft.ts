'use client';
import { useCallback, useEffect } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { chatDraftKey, flushChatDrafts, getChatDraft, useChatRuntimeStore } from '@/store/useChatRuntimeStore';

/** Follow-up prompts share chat's local-only draft storage. No project writes,
 * sync conflicts, or undo entries for unfinished text. Keyed by project/node,
 * not version: switching versions must not discard a question being composed. */
export function useNodePromptDraft(nodeId: string) {
  const projectId = useGraphStore(state => state.project?.id ?? '');
  const text = useChatRuntimeStore(state => state.drafts[chatDraftKey(projectId, nodeId)]?.text ?? '');
  useEffect(() => {
    useChatRuntimeStore.getState().hydrateDraft(projectId, nodeId);
    return flushChatDrafts;
  }, [projectId, nodeId]);
  const setText = useCallback((value: string) => {
    useChatRuntimeStore.getState().setDraft(projectId, nodeId, { ...getChatDraft(projectId, nodeId), text: value });
  }, [projectId, nodeId]);
  const getText = useCallback(() => getChatDraft(projectId, nodeId).text, [projectId, nodeId]);
  return { text, setText, getText };
}
