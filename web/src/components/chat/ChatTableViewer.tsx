'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { SquareArrowRight } from 'lucide-react';
import { useChatTableStore } from '@/store/useChatTableStore';
import { useGraphStore } from '@/store/useGraphStore';
import { answerVersion } from '@/lib/chat/model';
import { colorToCss } from '@/lib/groupColor';
import { exitReading } from '@/lib/readingController';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { NodeContentInteractionProvider } from '@/components/node/NodeContentInteractionContext';
import { NodeFactCheckPanel } from '@/components/canvas/NodeCitationsPanel';
import { RelationHoverPreview } from '@/components/canvas/RelationHoverPreview';
import { ChatMarkdown } from './ChatMarkdown';

function TableWindow({ target }: { target: NonNullable<ReturnType<typeof useChatTableStore.getState>['target']> }) {
  const project = useGraphStore((s) => s.project);
  const node = project?.nodes[target.nodeId];
  const version = node && answerVersion(node, target);
  const close = useChatTableStore((s) => s.close);
  const [panel, setPanel] = useState<'fact-check' | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => { exitReading(); close(); }, [close]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus(); exitReading();
    const key = (event: KeyboardEvent) => {
      if (useSourceUiStore.getState().viewer) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); exitReading(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [dismiss]);
  useEffect(() => { if (!version) dismiss(); }, [version, dismiss]);
  const openUnit = useCallback((id: string) => { setUnit(id); setPanel('fact-check'); }, []);
  const interaction = useMemo(() => ({ ignoreCanvasZoomForTerms: true }), []);
  if (!node || !version) return null;
  const accent = colorToCss((node.groupId ? project?.groups[node.groupId]?.color : undefined) ?? project?.color ?? '#888888');
  const style = { '--node-accent': accent, '--control-accent': accent,
    '--tint-1': `color-mix(in oklab, ${accent} 5%, transparent)`,
    '--tint-2': `color-mix(in oklab, ${accent} 10%, transparent)`,
    '--tint-3': `color-mix(in oklab, ${accent} 22%, transparent)` } as CSSProperties;
  return <>
    <div className="text-editor-backdrop" />
    <div className="chat-table-stage" style={style} onPointerDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <article className="text-editor-card chat-table-viewer" data-chat-table-viewer ref={dialog}
        role="dialog" aria-modal="true" aria-label={`Table: ${version.chat?.title ?? node.chat?.title}`} tabIndex={-1}>
        <header className="chat-table-toolbar"><span>{version.chat?.title}</span>
          <button type="button" className="text-editor-exit" onClick={dismiss} data-tip="Exit (Esc)"><SquareArrowRight size={15} /> Exit</button>
        </header>
        <div className="chat-table-layout">
          <div ref={contentRef} className="chat-table-content" data-node-id={node.id} data-sc-reading-node-id={node.id} data-sc-reading-scale="1"
            data-sc-reading-table data-chat-answer={target.turnId} data-chat-answer-created-at={target.versionCreatedAt}>
            <NodeContentInteractionProvider value={interaction}>
              <ChatMarkdown nodeId={node.id} version={version} tableOnly={target.tableIndex}
                localEvidence={{ activeId: unit, onUnit: openUnit }} />
            </NodeContentInteractionProvider>
          </div>
          {panel && <aside className="chat-table-review">
            <NodeFactCheckPanel inline nodeId={node.id} versionCreatedAt={version.createdAt}
              factUnitPrefix={`chat-row:${target.tableIndex}:`} activeUnitId={unit} onUnit={openUnit} onClose={() => setPanel(null)} />
          </aside>}
        </div>
      </article>
      <RelationHoverPreview containerRef={contentRef} screenSized />
    </div>
  </>;
}
export default function ChatTableViewer() {
  const target = useChatTableStore((s) => s.target);
  return target ? <TableWindow key={`${target.nodeId}:${target.versionCreatedAt}:${target.tableIndex}`} target={target} /> : null;
}
