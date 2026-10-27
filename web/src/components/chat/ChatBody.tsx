'use client';
import { VersionCounter } from '@/components/VersionCounter';
import { Fragment, memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { ArrowDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ScatterNode, NodeVersion } from '@/store/types';
import { useChatRuntimeStore, EMPTY_CHAT_VIEW } from '@/store/useChatRuntimeStore';
import { answerVersion } from '@/lib/chat/model';
import { activateChatAnswer, showChatAlternative } from '@/lib/chat/actions';
import { useGenerationPulseSync } from '@/hooks/useGenerationPulseSync';
import { NodeBodySkeleton } from '@/components/node/NodeBody';
import { ChatMarkdown } from './ChatMarkdown';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useReadingStore } from '@/store/useReadingStore';
import { collectSearchRanges } from '@/lib/searchHighlight';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { CHAT_SCROLL_INSET, visibleChatTurn } from '@/lib/chat/scroll';
import { ChatAssistantActions, ChatUserActions } from './ChatMessageActions';
import { chatCompactionBoundary } from '@/lib/chat/context';
import { useGraphStore } from '@/store/useGraphStore';
import { useNodeTextSelectionStore } from '@/store/useNodeTextSelectionStore';
import { selectionNodeId } from '@/lib/selectionNode';

const ChatAnswer = memo(function ChatAnswer({ nodeId, version }: { nodeId: string; version: NodeVersion }) {
  const pulse = useGenerationPulseSync(version.chat?.state === 'generating');
  const activity = useChatRuntimeStore((state) => state.views[nodeId]?.activity);
  const meta = version.chat!;
  return <>
    {!!meta.tools?.length && <div className="chat-tools" aria-label="Tool activity">
      {meta.tools.map((tool) => <div key={tool.id} className={tool.state === 'running' ? 'chat-activity is-generating' : 'chat-activity'}
        style={tool.state === 'running' ? pulse : undefined}>
        {tool.state === 'running' ? tool.summary : tool.resultSummary ?? tool.summary}
      </div>)}
    </div>}
    {meta.state === 'generating' && !meta.tools?.some((tool) => tool.state === 'running')
      && <div className="chat-activity is-generating" style={pulse} role="status">{activity ?? 'Working'}</div>}
    {meta.state === 'generating' && !version.body.trim() ? <NodeBodySkeleton /> : <ChatMarkdown nodeId={nodeId} version={version} />}
    {(meta.state === 'stopped' || meta.state === 'interrupted') && <div className="chat-notice" role="status">
      {meta.state === 'stopped' ? 'Stopped' : 'Interrupted'}{meta.error ? ` — ${meta.error}` : ''}
    </div>}
  </>;
});

export function ChatBody({ node, selected, style }: { node: ScatterNode; selected: boolean; style?: CSSProperties }) {
  const view = useChatRuntimeStore((state) => state.views[node.id] ?? EMPTY_CHAT_VIEW);
  const focused = useGraphStore((state) => state.project?.selection.length === 1
    && state.project.selection[0] === node.id);
  const reading = useReadingStore((state) => state.nodeId === node.id);
  const bodyRef = useRef<HTMLDivElement>(null);
  const settling = useRef<ReturnType<typeof setTimeout>>();
  const follow = useRef(view.atBottom);
  const savedScroll = useRef(view.scrollTop);
  const latestRef = useRef(node);
  const requestedTurn = useRef<string>();
  if (reading) follow.current = false;
  latestRef.current = node;
  const pulse = useGenerationPulseSync(view.compacting);
  const wasFocused = useRef(false);
  useEffect(() => {
    const newlyFocused = selected && focused && !wasFocused.current;
    wasFocused.current = selected && focused;
    // Panel opening deliberately single-selects its owner. Never restore a
    // panel for a member of a multi-selection (or it steals that selection).
    const panels = useCitationPanelStore.getState();
    if (!selected || !focused) {
      if (panels.nodeId === node.id && panels.mode === 'fact-check') panels.close('navigation');
      return;
    }
    if (panels.nodeId === node.id) return;
    const preference = useChatRuntimeStore.getState().views[node.id]?.rightPanelPreference;
    const active = node.versions[node.currentVersionIndex];
    // The focus/spawn camera request already fits the reopened panel. Do not
    // create a second request that bypasses a disabled focus/new-node setting.
    // A panel first appearing during an ongoing conversation still reveals.
    if (preference === 'fact-check' && active) panels.openFact(node.id, active.createdAt, undefined, !newlyFocused);
    else if (preference === 'conversation' || (preference === undefined && (node.chat?.turns.length ?? 0) >= 2)) {
      panels.openConversation(node.id, !newlyFocused);
    }
  }, [node.id, selected, focused, node.chat?.turns.length]);
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = view.scrollTop;
    // One restoration per mount, never on streaming or active-answer changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);
  useEffect(() => () => { if (settling.current) clearTimeout(settling.current);
    useChatRuntimeStore.getState().view(node.id, { scrollTop: savedScroll.current }); }, [node.id]);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => resize.disconnect();
  }, []);
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [node.versions, view.compacting]);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || !view.jump.nonce) return;
    const target = view.jump.turnId ? element.querySelector<HTMLElement>(`[data-chat-turn="${view.jump.turnId}"]`) : null;
    requestedTurn.current = target ? view.jump.turnId : undefined;
    if (settling.current) clearTimeout(settling.current);
    follow.current = !target;
    const rect = target && view.jump.query ? collectSearchRanges(target, view.jump.query)[0]?.getBoundingClientRect() : target?.getBoundingClientRect();
    const top = rect ? element.scrollTop + (rect.top - element.getBoundingClientRect().top) / (useLiveViewportStore.getState().zoom || 1) - CHAT_SCROLL_INSET : element.scrollHeight;
    element.scrollTo({ top,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [view.jump.nonce, view.jump.turnId, view.jump.query]);
  const onScroll = () => {
    const element = bodyRef.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 28;
    follow.current = atBottom && !requestedTurn.current;
    savedScroll.current = element.scrollTop;
    useChatRuntimeStore.getState().view(node.id, { atBottom });
    if (!selected) return;
    if (settling.current) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      useChatRuntimeStore.getState().view(node.id, { scrollTop: element.scrollTop });
      if (useReadingStore.getState().nodeId === node.id || requestedTurn.current) return;
      // Scrolling settles asynchronously. A selection made in the meantime
      // owns its answer, even if another turn is nearer the viewport's top.
      // Switching here would invalidate the exact range and hide its toolbar.
      if (useNodeTextSelectionStore.getState().selection?.nodeId === node.id) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed
        && selectionNodeId(selection.anchorNode, selection.focusNode) === node.id) return;
      const nearest = visibleChatTurn(element, useLiveViewportStore.getState().zoom || 1, atBottom);
      const id = nearest?.dataset.chatTurn;
      const turn = latestRef.current.chat?.turns.find((candidate) => candidate.id === id);
      if (turn) activateChatAnswer(node.id, { turnId: turn.id,
        versionCreatedAt: useChatRuntimeStore.getState().views[node.id]?.previews[turn.id] ?? turn.selectedVersionCreatedAt });
    }, 130);
  };
  return <div className="node-body chat-node-body" style={style}>
    <div className={`chat-scroll${reading ? ' is-reading' : ''}`} ref={bodyRef} onScroll={onScroll} tabIndex={selected ? 0 : -1}
      style={{ scrollPaddingTop: CHAT_SCROLL_INSET }}
      onPointerDown={() => { requestedTurn.current = undefined; }}
      onKeyDown={() => { requestedTurn.current = undefined; }}
      role="region" aria-label="Conversation" data-chat-scroll={node.id}
      onWheel={(event) => {
        if (event.ctrlKey || event.metaKey) return;
        requestedTurn.current = undefined;
        event.stopPropagation();
      }}>
      <div className={`chat-turns${!node.chat?.turns.length ? ' is-empty' : ''}`}>
        {!node.chat?.turns.length && <div className="chat-empty">This chat can access {node.chat?.parentNodeId ? 'the parent node’s contents, project sources, ' : 'project sources '}and files sent here.</div>}
        {node.chat?.turns.map((turn, index) => {
          const createdAt = view.previews[turn.id] ?? turn.selectedVersionCreatedAt;
          const version = answerVersion(node, { turnId: turn.id, versionCreatedAt: createdAt });
          if (!version?.chat) return null;
          const ref = { turnId: turn.id, versionCreatedAt: createdAt };
          const alternative = turn.versionCreatedAts.indexOf(createdAt);
          const previous = node.chat!.turns[index - 1];
          const previousAnswer = previous && answerVersion(node, { turnId: previous.id, versionCreatedAt: previous.selectedVersionCreatedAt });
          const contextChanged = previousAnswer?.chat?.parentSnapshotId && version.chat.parentSnapshotId !== previousAnswer.chat.parentSnapshotId;
          const compactions = node.chat!.compactions.filter((item) => chatCompactionBoundary(node, item) === turn.id);
          return <Fragment key={turn.id}><section className={`chat-turn${view.active?.turnId === turn.id ? ' is-active' : ''}`}
            data-chat-turn={turn.id} data-chat-version={createdAt} onClickCapture={() => activateChatAnswer(node.id, ref)}>
            {contextChanged && <div className="chat-notice">Parent context updated</div>}
            {version.chat.reference && <div className="chat-notice">About: {version.chat.reference.title}</div>}
            <div className="chat-user-message" data-reading-exclude="true">
              {version.chat.question}
              {!!version.chat.attachments?.length && <div className="chat-attachment-list" aria-label="Message attachments">
                {version.chat.attachments.map((item) => <span key={item.id} className="chat-attachment-chip" title={item.name}>
                  <span>{item.name}</span>
                </span>)}
              </div>}
            </div>
            <ChatUserActions nodeId={node.id} question={version.chat.question} latest={index === node.chat!.turns.length - 1}
              turnId={turn.id} versionCreatedAt={createdAt} answerCount={turn.versionCreatedAts.length}
              busy={!!node.generating || view.compacting} />
            <div className="chat-assistant" data-chat-answer={turn.id} data-chat-answer-created-at={createdAt}>
              {turn.versionCreatedAts.length > 1 && <div className="chat-alternatives" data-reading-exclude="true">
                <button type="button" aria-label="Previous answer" disabled={alternative <= 0}
                  onClick={(event) => { event.stopPropagation(); showChatAlternative(node.id, { turnId: turn.id, versionCreatedAt: turn.versionCreatedAts[alternative - 1]! }); }}><ChevronLeft size={14} /></button>
                <VersionCounter current={alternative + 1} total={turn.versionCreatedAts.length} noun="Answer" />
                <button type="button" aria-label="Next answer" disabled={alternative >= turn.versionCreatedAts.length - 1}
                  onClick={(event) => { event.stopPropagation(); showChatAlternative(node.id, { turnId: turn.id, versionCreatedAt: turn.versionCreatedAts[alternative + 1]! }); }}><ChevronRight size={14} /></button>
                {createdAt !== turn.selectedVersionCreatedAt && <span className="chat-alternative-note">Alternative version — not used in later replies</span>}
              </div>}
              <ChatAnswer nodeId={node.id} version={version} />
              <ChatAssistantActions key={createdAt} nodeId={node.id} version={version} latest={index === node.chat!.turns.length - 1}
                busy={!!node.generating || view.compacting} />
            </div>
          </section>
            {compactions.map((entry) => <div key={entry.memory.id} className="chat-notice chat-compaction-notice"
              role="note" data-reading-exclude="true" data-chat-compaction={entry.memory.id}>
              Context compacted — earlier messages remain available
            </div>)}
          </Fragment>;
        })}
        {view.compacting && <div className="chat-notice chat-activity is-generating" style={pulse} role="status">Compacting conversation</div>}
      </div>
    </div>
  </div>;
}

export function ChatJumpToLatest({ nodeId }: { nodeId: string }) {
  const atBottom = useChatRuntimeStore((state) => state.views[nodeId]?.atBottom ?? true);
  return <button type="button" className="node-collapse-toggle chat-jump-latest" disabled={atBottom}
    data-tip="Jump to latest message" aria-label="Jump to latest message"
    onClick={(event) => { event.stopPropagation(); useChatRuntimeStore.getState().jumpTo(nodeId); }}>
    <ArrowDown size={14} />
  </button>;
}
