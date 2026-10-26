'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { answerVersion } from '@/lib/chat/model';
import { activateChatAnswer } from '@/lib/chat/actions';
import { nodeWidth } from '@/lib/nodeSize';
import { colorToCss } from '@/lib/groupColor';

const historyTimestamp = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function ChatOutlinePanel() {
  const nodeId = useCitationPanelStore((state) => state.nodeId);
  const node = useGraphStore((state) => nodeId ? state.project?.nodes[nodeId] : undefined);
  const focused = useGraphStore((state) => state.project?.selection.length === 1 && state.project.selection[0] === nodeId);
  const accent = useGraphStore((state) => (node?.groupId ? state.project?.groups[node.groupId]?.color : undefined) ?? state.project?.color);
  const active = useChatRuntimeStore((state) => nodeId ? state.views[nodeId]?.active?.turnId : undefined);
  const previews = useChatRuntimeStore((state) => nodeId ? state.views[nodeId]?.previews : undefined);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (nodeId && !focused) useCitationPanelStore.getState().close('navigation');
  }, [nodeId, focused]);
  useLayoutEffect(() => {
    if (!nodeId) return;
    const nodeElement = document.querySelector<HTMLElement>(`[data-node-id="${nodeId}"]`);
    const position = () => {
      const current = useGraphStore.getState().project?.nodes[nodeId];
      if (!panel.current || !current) return;
      const live = useLivePositionsStore.getState().positions[nodeId] ?? current.position;
      panel.current.style.transform = `translate3d(${live.x + nodeWidth(current) + 12}px, ${live.y}px, 0)`;
    };
    const size = () => { if (panel.current && nodeElement) panel.current.style.height = `${Math.max(240, nodeElement.offsetHeight)}px`; position(); };
    const observer = new ResizeObserver(size);
    if (nodeElement) observer.observe(nodeElement);
    const unsubscribe = useLivePositionsStore.subscribe(position);
    size();
    return () => { observer.disconnect(); unsubscribe(); };
  }, [nodeId]);
  if (!node?.chat || !nodeId) return null;
  const color = accent ? colorToCss(accent) : 'var(--text)';
  return <div ref={panel} className="side-panel citations-panel chat-outline-panel" data-canvas-right-panel="conversation"
    style={{ '--control-accent': color, '--node-accent': color,
      '--tint-2': `color-mix(in oklab, ${color} 10%, transparent)` } as React.CSSProperties}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
    <div className="citations-panel-head"><span>Chat history</span><button type="button" className="citations-close-btn" aria-label="Close chat history"
      onClick={() => useCitationPanelStore.getState().close()}><X size={15} /></button></div>
    <div className="citations-list chat-outline-list">
      {node.chat.turns.map((turn) => {
        const ref = { turnId: turn.id, versionCreatedAt: previews?.[turn.id] ?? turn.selectedVersionCreatedAt };
        const version = answerVersion(node, ref);
        if (!version?.chat) return null;
        return <button key={turn.id} type="button" className={`chat-outline-entry${active === turn.id ? ' active' : ''}`}
          aria-current={active === turn.id ? 'true' : undefined} data-tip={version.chat.question}
          onClick={() => { activateChatAnswer(nodeId, ref); useChatRuntimeStore.getState().jumpTo(nodeId, turn.id); }}>
          <span>{version.chat.question}</span>
          <time className="chat-outline-timestamp" dateTime={new Date(version.createdAt).toISOString()}>
            {historyTimestamp.format(version.createdAt)}
          </time>
        </button>;
      })}
    </div>
  </div>;
}
