'use client';
import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import type { ScatterNode } from '@/store/types';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { collectSearchRanges } from '@/lib/searchHighlight';
import { ChatMarkdown } from './ChatMarkdown';
import { attachAnswerScrollFade } from './answerScrollFade';
import { useDisplayBody } from '@/store/useRewriteStore';
import { NodeGenerationError } from '@/components/node/NodeGenerationError';
import { useEditorStore } from '@/store/useEditorStore';
import { FilePenLine } from 'lucide-react';

/** A rich answer snapshot has the same reading viewport, but no conversation. */
export function AnswerBody({ node, selected, style }: { node: ScatterNode; selected: boolean; style?: CSSProperties }) {
  const version = node.versions[node.currentVersionIndex]!;
  const body = useDisplayBody(node.id, node.currentVersionIndex, version.body);
  const scroll = useRef<HTMLDivElement>(null);
  const saved = useRef(useChatRuntimeStore.getState().views[node.id]?.scrollTop ?? 0);
  const jump = useChatRuntimeStore((state) => state.views[node.id]?.jump);
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = saved.current; }, [node.id]);
  useLayoutEffect(() => {
    if (scroll.current) return attachAnswerScrollFade(scroll.current);
  }, [node.id]);
  useEffect(() => () => useChatRuntimeStore.getState().view(node.id, { scrollTop: saved.current }), [node.id]);
  useEffect(() => {
    const element = scroll.current;
    if (!element || !jump?.nonce) return;
    const range = jump.query ? collectSearchRanges(element, jump.query)[0] : undefined;
    if (range) element.scrollTo({ top: element.scrollTop + (range.getBoundingClientRect().top - element.getBoundingClientRect().top)
      / (useLiveViewportStore.getState().zoom || 1) - 14,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [jump]);
  return <div className="node-body chat-node-body answer-reading-window" style={style}>
    <div ref={scroll} className="chat-scroll answer-scroll" role="region" aria-label="Answer"
      tabIndex={selected ? 0 : -1} data-chat-scroll={node.id}
      onScroll={() => { saved.current = scroll.current?.scrollTop ?? 0; }}
      onWheel={(event) => { if (!event.ctrlKey && !event.metaKey) event.stopPropagation(); }}>
      <div className="chat-assistant" data-chat-answer={version.chat?.turnId} data-chat-answer-created-at={version.createdAt}>
        <NodeGenerationError error={node.generationError ?? (version.sourceLimitation?.kind === 'not-enough-information' ? version.sourceLimitation.message : undefined)} />
        {!body.trim() && version.markdownNote && !node.generating
          ? <div className="custom-text-empty"><p>Nothing here yet.<br />Add your own text, notes, or formatted content.</p>
            <button type="button" className="btn" onPointerDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); useEditorStore.getState().openEditor(node.id); }}><FilePenLine size={16} /> Add text</button></div>
          : <ChatMarkdown nodeId={node.id} version={body === version.body ? version : { ...version, body }} />}
      </div>
    </div>
  </div>;
}
