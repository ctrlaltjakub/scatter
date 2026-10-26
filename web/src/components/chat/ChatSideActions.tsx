'use client';
import { ListTree, Shrink, WrapText } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { compactChat, reverseChatCompaction } from '@/lib/chat/actions';
import { compactionPrefix } from '@/lib/chat/context';
import { ChatPanelGroup, ChatPanelTopActions } from './ChatPanelControls';
import type { ScatterNode } from '@/store/types';
import { AddNodeMenu } from '@/components/canvas/AddNodeMenu';
import { EditHeaderButton } from '@/components/node/EditHeaderButton';

export function ChatSideActions({ node }: { node: ScatterNode }) {
  const project = useGraphStore((state) => state.project);
  const compacting = useChatRuntimeStore((state) => !!state.views[node.id]?.compacting);
  const panelMode = useCitationPanelStore((state) => state.nodeId === node.id ? state.mode : null);
  if (!project || !node.chat) return null;
  const graph = useGraphStore.getState();
  const busy = !!node.generating || compacting;
  const unconsumed = node.chat.compactions.at(-1) && !node.chat.compactions.at(-1)?.consumedAt;
  const canCompact = compactionPrefix(node).length > 0;
  const compactionTip = compacting
    ? 'Compaction is already running. Wait or stop it first.'
    : node.generating
      ? 'Wait for the current answer to finish, or stop it first.'
      : unconsumed
        ? 'Restore the previous context. Your messages stay unchanged.'
        : !canCompact
          ? 'Needs at least 3 turns. The latest 2 are kept in full.'
          : 'Summarize older turns; keep the latest 2 in full. Messages stay visible.';
  return <div className="side-panel-content chat-side-actions">
    <ChatPanelTopActions node={node} />
    <AddNodeMenu key={node.id} nodeId={node.id} />
    <EditHeaderButton node={node} />
    <ChatPanelGroup node={node} />
    <button type="button" className="side-action" aria-pressed={node.chat.informationChunking} data-state-in-label
      data-tip="Presents one idea per sentence, starts sentences on new lines, and bolds key ideas. Uses headings and bullets to organize details."
      onClick={() => graph.updateNode(node.id, { chat: { ...node.chat!, informationChunking: !node.chat!.informationChunking } })}>
      <span className="side-action-icon"><WrapText size={15} /></span>
      <span>Information chunking: {node.chat.informationChunking ? 'On' : 'Off'}{' '}<span className="chat-action-detail">New and regenerated answers</span></span>
    </button>
    <button type="button" className={`side-action${panelMode === 'conversation' ? ' toggled' : ''}`}
      onClick={() => panelMode === 'conversation' ? useCitationPanelStore.getState().close() : useCitationPanelStore.getState().openConversation(node.id)}>
      <span className="side-action-icon"><ListTree size={15} /></span>{panelMode === 'conversation' ? 'Hide chat history' : 'Show chat history'}
    </button>
    <button type="button" className="side-action" disabled={busy || (!unconsumed && !canCompact)}
      data-tip={compactionTip} aria-description={compactionTip}
      onClick={() => unconsumed ? reverseChatCompaction(node.id) : void compactChat(node.id)}>
      <span className="side-action-icon"><Shrink size={15} /></span>{unconsumed ? 'Undo compaction' : 'Compact conversation'}
    </button>
  </div>;
}
