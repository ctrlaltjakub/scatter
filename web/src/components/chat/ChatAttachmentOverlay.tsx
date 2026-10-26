'use client';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SourceImportOverlay } from '@/components/sources/SourceImportOverlay';
import { prepareChatAttachments } from '@/lib/chat/attachments';
import { useChatRuntimeStore, getChatDraft } from '@/store/useChatRuntimeStore';
import { useGraphStore } from '@/store/useGraphStore';

export function ChatAttachmentOverlay({ projectId, nodeId, onClose }: {
  projectId: string; nodeId: string; onClose: () => void;
}) {
  const job = useRef<AbortController>();
  useEffect(() => () => job.current?.abort(), []);
  return createPortal(<SourceImportOverlay attachment={{ onClose,
    onConfirm: async (files, progress) => {
      const controller = new AbortController(); job.current = controller;
      const unsubscribe = useGraphStore.subscribe((state) => {
        if (state.project?.id !== projectId || !state.project.nodes[nodeId]) controller.abort();
      });
      try {
        const attachments = await prepareChatAttachments(projectId, files, controller.signal, progress);
        controller.signal.throwIfAborted();
        const draft = getChatDraft(projectId, nodeId);
        useChatRuntimeStore.getState().setDraft(projectId, nodeId,
          { ...draft, attachments: [...draft.attachments ?? [], ...attachments] });
      } finally { unsubscribe(); }
    },
  }} />, document.body);
}
