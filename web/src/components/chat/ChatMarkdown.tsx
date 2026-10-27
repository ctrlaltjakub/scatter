'use client';
import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type HTMLAttributes } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { annotateMarkdownExtras, normalizeEditorUrl } from '@/lib/chat/markdownExtras';
import { mappedSegment, type ChatMdNode } from '@/lib/chat/markdownFields';
import { toggleTaskCheckbox } from '@/lib/chat/taskCheckbox';
import { Copy, Maximize2, SquareArrowOutUpRight } from 'lucide-react';
import { copyTable } from '@/lib/chat/copyTable';
import { copyTableToNode, measureTableNode } from '@/lib/chat/tableNode';
import type { NodeVersion } from '@/store/types';
import { annotateChatMarkdown, annotateChatRelations } from '@/lib/chat/markdown';
import { useGraphStore } from '@/store/useGraphStore';
import { resolveArrowSourceSelection } from '@/lib/sourceSelection';
import { SourceSelectionMark } from '@/components/node/SourceSelectionMark';
import { ReferenceChip, useReferenceResolution, type ReferenceResolution } from '@/components/node/ReferenceChip';
import { CitationMarker } from '@/components/node/CitationMarker';
import { NodeContentInteractionProvider, useNodeContentInteraction } from '@/components/node/NodeContentInteractionContext';
import { activateReference } from '@/lib/referenceAction';
import { activateChatAnswer } from '@/lib/chat/actions';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { useChatTableStore } from '@/store/useChatTableStore';
import { nodeRelations, relatedSelectedNodeId, type NodeRelations } from '@/lib/nodeRelations';
import type { ChatAnswerRef } from '@/store/chatTypes';
import { languageInfo, languageDirection } from '@/lib/languages';
import { useReadingTypography } from '@/hooks/useReadingTypography';
import { factCheckBodyFingerprint } from '@/lib/factCheckCore';

type FactAttributes = HTMLAttributes<HTMLElement> & { 'data-chat-unit'?: string; 'data-fact-unit'?: string; 'data-tip'?: string };
interface MarkdownPresentation {
  nodeId: string;
  answer: ChatAnswerRef;
  resolution: ReferenceResolution;
  relations: NodeRelations;
  selectedChild: string | null;
  highlightedArrow: string | null;
  tableOnly?: number;
  factProps: (props: FactAttributes) => FactAttributes;
}
const MarkdownPresentationContext = createContext<MarkdownPresentation | null>(null);
const TaskOffsetContext = createContext<number | undefined>(undefined);
function useMarkdownPresentation(): MarkdownPresentation {
  const presentation = useContext(MarkdownPresentationContext);
  if (!presentation) throw new Error('Chat Markdown presentation is missing');
  return presentation;
}

// Stable component types retain table scroll, text selection, and DOM identity
// during highlight changes. Only these leaves consume presentation context;
// the cached Markdown parser/tree below does not.
const markdownComponents: Components = {
  blockquote: function Callout({ node: _node, children, ...props }) {
    const title = (props as { 'data-callout-title'?: string })['data-callout-title'];
    return <blockquote {...props}>{title && <strong className="markdown-callout-title">{title}</strong>}{children}</blockquote>;
  },
  li: function TaskItem({ node: _node, children, ...props }) {
    const offset = (props as { 'data-task-offset'?: number })['data-task-offset'];
    return <TaskOffsetContext.Provider value={offset == null ? undefined : Number(offset)}><li {...props}>{children}</li></TaskOffsetContext.Provider>;
  },
  input: function TaskCheckbox({ node: _node, ...props }) {
    const offset = useContext(TaskOffsetContext);
    const { nodeId, answer } = useMarkdownPresentation();
    return <input {...props} disabled={offset == null} aria-label="Task complete" tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onChange={() => { if (offset != null) toggleTaskCheckbox(nodeId, answer.versionCreatedAt, offset); }} />;
  },
  a: function ChatLink({ node: _node, href, children, ...props }) {
    const { nodeId, answer, resolution } = useMarkdownPresentation();
    if (href?.startsWith('#chat-term/')) {
      const term = decodeURIComponent(href.slice(11));
      return <ReferenceChip term={term} parentNodeId={nodeId} resolution={resolution}
        onClick={(value, opts) => { activateChatAnswer(nodeId, answer);
          activateReference(nodeId, value, { ...opts, sourceAnswer: answer }); }}>{children}</ReferenceChip>;
    }
    if (href?.startsWith('#chat-cite/')) {
      const [, kind, number] = href.split('/');
      return <CitationMarker parentNodeId={nodeId} n={Number(number)} internal={kind === 'internal'} />;
    }
    return <a {...props} href={href} target={href?.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">{children}</a>;
  },
  span: function ChatSpan({ node: _node, ...props }) {
    const { relations, selectedChild, highlightedArrow, factProps } = useMarkdownPresentation();
    const attrs = props as HTMLAttributes<HTMLSpanElement> & { 'data-chat-relation'?: string; 'data-chat-relation-start'?: boolean; 'data-chat-relation-end'?: boolean };
    const arrow = attrs['data-chat-relation'] && relations.sourceSelectionById.get(attrs['data-chat-relation']);
    return arrow ? <SourceSelectionMark arrow={arrow} active={selectedChild === arrow.toNodeId || highlightedArrow === arrow.id}
      startsSegment={attrs['data-chat-relation-start']} endsSegment={attrs['data-chat-relation-end']}>{props.children}</SourceSelectionMark>
      : <span {...factProps(props)} />;
  },
  tr: function ChatRow({ node: _node, ...props }) {
    const { factProps } = useMarkdownPresentation();
    const checked = factProps(props);
    return <tr {...checked} role={undefined} aria-roledescription={checked.role ? 'Fact-checked row; activate to review evidence' : undefined} />;
  },
  table: function ChatTable({ node: _node, children, ...props }) {
    const { nodeId, answer, tableOnly } = useMarkdownPresentation();
    const table = useRef<HTMLTableElement>(null);
    const [copyState, setCopyState] = useState('Copy table');
    const index = Number((props as { 'data-chat-table-index'?: number })['data-chat-table-index'] ?? 0);
    return <div className="chat-table-piece">
      <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Scrollable table"
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey
            && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) event.stopPropagation();
        }}>
        <table ref={table} {...props}>{children}</table>
      </div>
      <div className="chat-table-actions" data-reading-exclude="true">
      {tableOnly == null && <button type="button" className="chat-table-expand" data-tip="View this table fullscreen"
        onClick={(event) => { event.stopPropagation(); activateChatAnswer(nodeId, answer);
          useChatTableStore.getState().open({ nodeId, ...answer, tableIndex: index }); }}>
        <Maximize2 size={14} /> View table fullscreen
      </button>}
      <button type="button" className="chat-table-expand" data-tip="Copy only this table into a new Markdown text node"
        onClick={event => {
          event.stopPropagation();
          if (table.current) copyTableToNode(nodeId, answer, index, measureTableNode(table.current));
        }}><SquareArrowOutUpRight size={14} />Copy to node</button>
      <button type="button" className="chat-table-expand" data-tip="Copy this table to the clipboard" onClick={async event => {
        event.stopPropagation();
        if (!table.current) return;
        try { await copyTable(table.current); setCopyState('Copied'); }
        catch { setCopyState('Copy failed — retry'); }
      }} onBlur={() => setCopyState('Copy table')}><Copy size={14} />{copyState}</button>
      </div>
    </div>;
  },
};

export const ChatMarkdown = memo(function ChatMarkdown({ nodeId, version, tableOnly,
  localEvidence,
}: { nodeId: string; version: NodeVersion; tableOnly?: number;
  localEvidence?: { activeId: string | null; onUnit: (id: string) => void } }) {
  const ref = useMemo(() => ({ turnId: version.chat!.turnId, versionCreatedAt: version.createdAt }),
    [version.chat?.turnId, version.createdAt]);
  const typography = useReadingTypography(version.language, version.body);
  const resolution = useReferenceResolution(nodeId, ref);
  const relations = useGraphStore((s) => nodeRelations(s.project?.arrows, nodeId, ref));
  const selectedChild = useGraphStore((s) => relatedSelectedNodeId(s.project?.selection,
    nodeRelations(s.project?.arrows, nodeId, ref).sourceSelectionChildIds));
  const highlightedArrow = useGraphStore((s) => s.highlight?.arrowId
    && nodeRelations(s.project?.arrows, nodeId, ref).sourceSelectionById.has(s.highlight.arrowId)
    ? s.highlight.arrowId : null);
  const outerInteraction = useNodeContentInteraction();
  // History/source panels and evidence on other answers cannot change this
  // answer's text presentation. Local viewers own their evidence selection.
  const reviewingFacts = useCitationPanelStore((state) => !localEvidence && state.mode === 'fact-check'
    && state.nodeId === nodeId && state.factVersionCreatedAt === version.createdAt);
  const activeUnit = useCitationPanelStore((state) => !localEvidence && state.mode === 'fact-check'
    && state.nodeId === nodeId && state.factVersionCreatedAt === version.createdAt
    ? state.activeFactUnitId : null);
  const availableReport = localEvidence || reviewingFacts
    ? version.factCheck?.pending ?? version.factCheck?.complete : undefined;
  const bodyFingerprint = useMemo(() => availableReport ? factCheckBodyFingerprint(version) : undefined,
    // Incoming fact-check results do not change the prose being checked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [!!availableReport, version.body, version.header, version.chat?.question, !!version.chat]);
  const report = availableReport?.bodyFingerprint === bodyFingerprint ? availableReport : undefined;
  const units = useMemo(() => new Map(report?.units.map((unit) => [unit.id, unit])), [report]);
  const plugin = useMemo(() => () => (tree: unknown) => {
    annotateMarkdownExtras(tree as ChatMdNode, version.body, node => mappedSegment(node, version.body, false));
    annotateChatMarkdown(tree, { chunked: !!version.chat?.informationChunking, source: version.body,
      internalNumbers: new Set(version.internalSources?.map((source) => source.n)) });
    const marks = new Map<string, Array<{ start: number; end: number; arrowId: string }>>();
    for (const arrow of relations.sourceSelections) for (const part of resolveArrowSourceSelection(version.body, version.createdAt, arrow.sourceSelection)?.parts ?? []) {
      marks.set(part.sourceField, [...marks.get(part.sourceField) ?? [], { start: part.displayStart, end: part.displayEnd, arrowId: arrow.id }]);
    }
    annotateChatRelations(tree, marks);
    if (tableOnly != null) {
      type Element = { type: string; children?: Element[] };
      const root = tree as Element;
      const tables: Element[] = [];
      const collect = (item: Element) => { if (item.type === 'table') tables.push(item); else item.children?.forEach(collect); };
      collect(root); root.children = tables.slice(tableOnly, tableOnly + 1);
    }
  }, [version.chat?.informationChunking, version.internalSources, version.body, version.createdAt, tableOnly, relations.sourceSelections]);
  const content = useMemo(() => <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, plugin]} rehypePlugins={[rehypeKatex]} components={markdownComponents}
    remarkRehypeOptions={{ clobberPrefix: `sc-${nodeId}-${version.createdAt}-` }}
    urlTransform={(url, key) => /^data:/i.test(url) ? key === 'src' ? normalizeEditorUrl(url, true) ?? '' : '' : normalizeEditorUrl(url, key === 'src') ?? defaultUrlTransform(url)}>
    {version.body}
  </ReactMarkdown>, [nodeId, version.createdAt, version.body, plugin]);
  const interaction = useMemo(() => ({ ...outerInteraction,
    citationVersionCreatedAt: version.createdAt,
    citationSources: version.sources,
    citationInternalSources: version.internalSources,
  }), [version.createdAt, version.sources, version.internalSources, outerInteraction]);
  const factProps = useCallback((props: FactAttributes): FactAttributes => {
    const id = props['data-chat-unit'];
    const unit = id && units.get(id);
    if (!unit) return props;
    const verdict = unit.finding?.verdict ?? (unit.state === 'failed' ? 'failed' : 'pending');
    return { ...props, 'data-fact-unit': id,
      className: `${props.className ?? ''} fact-check-unit fact-${verdict}${(localEvidence?.activeId ?? activeUnit) === id ? ' fact-active' : ''}`,
      role: 'button', tabIndex: 0, 'aria-label': `Review evidence for: ${unit.text}`,
      'data-tip': 'Review evidence',
      onClick: (event: React.MouseEvent) => {
        if (!window.getSelection()?.isCollapsed || (event.target as Element).closest('a,button,.ref-chip,.cite-marker')) return;
        event.stopPropagation(); if (localEvidence) localEvidence.onUnit(id!); else useCitationPanelStore.getState().setFactUnit(nodeId, id!);
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation(); if (localEvidence) localEvidence.onUnit(id!); else useCitationPanelStore.getState().setFactUnit(nodeId, id!);
      },
    };
  }, [units, localEvidence, activeUnit, nodeId]);
  const presentation = useMemo<MarkdownPresentation>(() => ({
    nodeId, answer: ref, resolution, relations, selectedChild, highlightedArrow, tableOnly, factProps,
  }), [nodeId, ref, resolution, relations, selectedChild, highlightedArrow, tableOnly, factProps]);
  return <NodeContentInteractionProvider value={interaction}>
    <div className={`chat-markdown${version.chat?.informationChunking ? ' is-chunked' : ''}`} data-preview-version={version.createdAt}
      lang={languageInfo(version.language).locale} dir={languageDirection(version.language)} style={typography}>
      <MarkdownPresentationContext.Provider value={presentation}>{content}</MarkdownPresentationContext.Provider>
    </div>
  </NodeContentInteractionProvider>;
});
