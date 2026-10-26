'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ExternalLink, FileText, GripVertical, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useSourceRuntimeStore } from '@/store/useSourceRuntimeStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { activeRevision, orderedSources, sourceLibrary } from '@/lib/projectSources';
import { permanentlyDeleteSource, removeSourceJob, retrySourceJob } from '@/lib/sourceProcessing';
import { colorToCss } from '@/lib/groupColor';
import type { ProjectSource } from '@/store/types';
import { reorderProjectSourcesWithoutHistory } from '@/lib/sourceProjectMutations';
import { sidebarDragScrollStep } from '@/lib/sidebarDragScroll';
import { SourceControls } from './SourceControls';

export function stageLabel(job: {
  status: string;
  statusDetail?: string;
  waitingForConnection?: boolean;
  completedPages?: number[];
  pageCount?: number;
  indexingCompleted?: number;
  indexingTotal?: number;
}): string {
  if (job.waitingForConnection) return 'Waiting for connection';
  if (job.status === 'queued') return 'Waiting';
  if (job.status === 'fetching') return job.statusDetail === 'fetch-jina'
    ? 'Fetching through Jina'
    : 'Fetching directly';
  if (job.status === 'extracting') return 'Extracting text';
  if (job.status === 'ocr') {
    const complete = job.completedPages?.length ?? 0;
    return job.pageCount
      ? `Reading page ${Math.min(complete + 1, job.pageCount)} / ${job.pageCount} with AI`
      : 'Reading images with AI';
  }
  if (job.status === 'indexing') return job.indexingTotal
    ? `Semantic indexing ${job.indexingCompleted ?? 0} / ${job.indexingTotal}`
    : 'Preparing semantic index';
  return 'Needs attention';
}

function sourceKindLabel(source: ProjectSource): string {
  return source.kind === 'webpage' ? 'Webpage' : source.kind === 'image' ? 'AI transcription' : source.kind.toUpperCase();
}

function SortableSourceRow({
  id,
  children,
}: {
  id: string;
  children: (input: {
    setNodeRef: (node: HTMLElement | null) => void;
    handleProps: Record<string, unknown>;
    style: React.CSSProperties;
    dragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    transition: { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  });
  return children({
    setNodeRef,
    handleProps: { ...attributes, ...listeners },
    style: {
      transform: CSS.Transform.toString(transform),
      transition,
      zIndex: isDragging ? 2 : undefined,
      position: 'relative',
    },
    dragging: isDragging,
  });
}

export function SourceManager({
  anchor = 'sidebar',
  onInteractionLockChange,
  embedded = false,
  virtualEmpty = false,
}: {
  anchor?: 'sidebar' | 'floating' | 'welcome';
  onInteractionLockChange?: (locked: boolean) => void;
  /** Topic-picker variant: participates in the shared window instead of
   * creating a second floating portal. It stays mounted while collapsed so
   * the shared shell can animate without losing its contents. */
  embedded?: boolean;
  /** Hide the project underneath a not-yet-committed new-project picker. */
  virtualEmpty?: boolean;
}) {
  const open = useSourceUiStore((state) => state.managerOpen);
  const close = useSourceUiStore((state) => state.closeManager);
  const openImport = useSourceUiStore((state) => state.openImport);
  const openViewer = useSourceUiStore((state) => state.openViewer);
  const project = useGraphStore((state) => state.project);
  const setChecked = useGraphStore((state) => state.setSourceChecked);
  const setAllChecked = useGraphStore((state) => state.setAllSourcesChecked);
  const jobsRecord = useSourceRuntimeStore((state) => state.jobs);
  const embeddingStatus = useSourceRuntimeStore((state) => state.embeddingStatus);
  const embeddingProgress = useSourceRuntimeStore((state) => state.embeddingProgress);
  const embeddingError = useSourceRuntimeStore((state) => state.embeddingError);
  const [filter, setFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ source: ProjectSource; rect: DOMRect } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollFrame = useRef(0);
  const dragPointerY = useRef(0);
  const dragMaxScroll = useRef(0);
  const pointerMoveListener = useRef<((event: PointerEvent) => void) | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const projectId = project?.id;
  const library = sourceLibrary(virtualEmpty ? null : project);
  const sources = orderedSources(library);
  const jobs = useMemo(() => virtualEmpty ? [] : Object.values(jobsRecord)
    .filter((job) => job.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt), [jobsRecord, projectId, virtualEmpty]);
  const visible = sources.filter((source) => source.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  const accent = project?.color ? colorToCss(project.color) : 'var(--blue)';

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrame.current) cancelAnimationFrame(autoScrollFrame.current);
    autoScrollFrame.current = 0;
    dragMaxScroll.current = 0;
    if (pointerMoveListener.current) {
      window.removeEventListener('pointermove', pointerMoveListener.current);
      pointerMoveListener.current = null;
    }
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    stopAutoScroll();
    if (!(event.activatorEvent instanceof PointerEvent) || !listRef.current) return;
    const list = listRef.current;
    // Freeze the genuine scroll range before transforms can create temporary
    // overflow. This is the same guard used by Projects and Groups.
    dragMaxScroll.current = Math.max(0, list.scrollHeight - list.clientHeight);
    if (dragMaxScroll.current <= 1) return;
    dragPointerY.current = event.activatorEvent.clientY;
    const listener = (pointerEvent: PointerEvent) => { dragPointerY.current = pointerEvent.clientY; };
    pointerMoveListener.current = listener;
    window.addEventListener('pointermove', listener, { passive: true });
    const tick = () => {
      const current = listRef.current;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const step = sidebarDragScrollStep({
        pointerY: dragPointerY.current,
        viewportTop: rect.top,
        viewportBottom: rect.bottom,
        scrollTop: current.scrollTop,
        maxScrollTop: dragMaxScroll.current,
      });
      if (step) current.scrollTop += step;
      autoScrollFrame.current = requestAnimationFrame(tick);
    };
    autoScrollFrame.current = requestAnimationFrame(tick);
  }, [stopAutoScroll]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    stopAutoScroll();
    const fromId = String(event.active.id);
    const toId = event.over ? String(event.over.id) : '';
    if (projectId && toId && fromId !== toId) {
      void reorderProjectSourcesWithoutHistory(projectId, fromId, toId);
    }
  }, [projectId, stopAutoScroll]);

  useEffect(() => {
    if (!open) setDeleteTarget(null);
  }, [open]);
  useEffect(() => {
    // The embedded topic-picker manager is part of the picker itself. Its
    // backdrop owns closing the whole picker, so collapsing this pane first
    // would expose an awkward half-second transition before the picker leaves.
    if (!open || embedded) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(
        '[data-source-manager-trigger], .source-import-window, .source-viewer-window, .source-delete-confirmation',
      )) return;
      close();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [close, embedded, open]);
  useEffect(() => {
    onInteractionLockChange?.(Boolean(deleteTarget));
    return () => onInteractionLockChange?.(false);
  }, [deleteTarget, onInteractionLockChange]);
  useEffect(() => {
    if (!deleteTarget) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      setDeleteTarget(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setDeleteTarget(null); };
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', escape);
    };
  }, [deleteTarget]);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  if ((!open && !embedded) || !projectId) return null;
  const embedding = embeddingStatus === 'loading'
    ? 'Embedding model: loading from this device'
    : embeddingStatus === 'downloading'
    ? embeddingProgress > 0
      ? `Embedding model: downloading ${Math.round(embeddingProgress)}%`
      : 'Embedding model: downloading'
    : embeddingStatus === 'ready'
      ? 'Embedding model: ready'
      : embeddingStatus === 'failed'
        ? 'Embedding model: failed, using keyword search'
        : 'Embedding model: preparing';

  const panel = (
    <section
      ref={panelRef}
      className={`source-manager source-manager--${embedded ? 'embedded' : anchor}`}
      style={{ '--control-accent': accent } as React.CSSProperties}
      aria-label="Project sources"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="source-manager-head">
        <div>
          <strong>Project sources</strong>
          <span title={embeddingError}>{embedding}</span>
        </div>
        {!embedded && <button type="button" onClick={close} aria-label="Close sources" data-tip="Close sources"><X size={15} /></button>}
      </header>
      <div className="source-manager-mode">
        <span className="source-manager-mode-label">Use sources for generation:</span>
        <SourceControls showManagerButton={false} virtualEmpty={virtualEmpty} />
      </div>
      <div className="source-manager-tools">
        <label className="source-filter">
          <Search size={14} />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter sources…" />
        </label>
        <button type="button" onClick={() => setAllChecked(true)} disabled={!sources.length}>All</button>
        <button type="button" onClick={() => setAllChecked(false)} disabled={!sources.length}>None</button>
        <button type="button" className="source-add-compact" onClick={openImport}><Plus size={14} /> Add</button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        autoScroll={false}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={stopAutoScroll}
      >
      <div className="source-manager-list" ref={listRef}>
        {jobs.map((job) => (
          <div className={`source-row source-row--job ${job.status === 'failed' ? 'failed' : ''}`} key={job.id}>
            <span className="source-drag-placeholder"><GripVertical size={15} /></span>
            <span className="source-checkbox-placeholder" aria-hidden="true" />
            <div className="source-row-main">
              <strong>{job.title}</strong>
              <small>{job.status === 'failed' ? job.error : stageLabel(job)}</small>
            </div>
            {job.status === 'failed' && (
              <button type="button" onClick={() => { void retrySourceJob(job.id); }} data-tip="Retry source processing"><RotateCcw size={15} /></button>
            )}
            <button type="button" onClick={() => { void removeSourceJob(job.id); }} data-tip="Remove failed import"><Trash2 size={15} /></button>
          </div>
        ))}
        <SortableContext items={visible.map((source) => source.id)} strategy={verticalListSortingStrategy}>
        {visible.map((source) => {
          const revision = activeRevision(source);
          return (
            <SortableSourceRow id={source.id} key={source.id}>{({ setNodeRef, handleProps, style, dragging }) => (
            <div
              ref={setNodeRef}
              className={`source-row${dragging ? ' dragging' : ''}`}
              style={style}
            >
              <button {...handleProps} className="source-drag" type="button" aria-label={`Reorder ${source.title}`} data-tip="Drag to reorder"><GripVertical size={15} /></button>
              <label className="source-check" data-tip={source.checked ? 'Active for future generation' : 'Not used for future generation'}>
                <input type="checkbox" checked={source.checked} onChange={(event) => setChecked(source.id, event.target.checked)} />
              </label>
              <button
                type="button"
                className="source-row-main"
                onClick={() => revision && openViewer({ projectId, sourceId: source.id, revisionId: revision.id })}
                disabled={!revision}
                data-tip="Open this source"
              >
                <strong>{source.title}</strong>
                <small>{sourceKindLabel(source)}{revision?.pageCount ? ` · ${revision.pageCount} pages` : ''} · Ready</small>
              </button>
              {source.originalUrl && (
                <a href={source.originalUrl} target="_blank" rel="noreferrer" data-link-control data-tip="Visit live webpage" aria-label={`Visit ${source.title}`}><ExternalLink size={15} /></a>
              )}
              <button
                type="button"
                className="source-delete"
                onClick={(event) => setDeleteTarget({ source, rect: event.currentTarget.getBoundingClientRect() })}
                data-tip="Delete source permanently"
                aria-label={`Delete ${source.title}`}
              ><Trash2 size={15} /></button>
            </div>
            )}</SortableSourceRow>
          );
        })}
        </SortableContext>
        {!jobs.length && !visible.length && (
          <div className="source-manager-empty">
            <FileText size={24} />
            <strong>{filter ? 'No matching sources' : 'Add material to ground this project'}</strong>
            {!filter && <button type="button" onClick={openImport}><Plus size={14} /> Add sources</button>}
          </div>
        )}
      </div>
      </DndContext>
    </section>
  );
  const confirmation = deleteTarget ? (
      <div
        className="project-delete-confirmation source-delete-confirmation"
        style={{
          left: Math.min(window.innerWidth - 170, deleteTarget.rect.right + 6),
          top: Math.max(8, Math.min(window.innerHeight - 48, deleteTarget.rect.top - 4)),
          '--project-delete-accent': accent,
        } as React.CSSProperties}
        role="dialog"
        aria-label="Delete source?"
      >
        <span className="project-delete-question">Delete source?</span>
        <div className="project-delete-actions">
          <button autoFocus type="button" className="project-delete-button project-delete-no" onClick={() => setDeleteTarget(null)}>No</button>
          <button type="button" className="project-delete-button project-delete-yes" onClick={() => {
            const sourceId = deleteTarget.source.id;
            setDeleteTarget(null);
            void permanentlyDeleteSource(projectId, sourceId);
          }}>Yes</button>
        </div>
      </div>
  ) : null;
  if (embedded) return <>{panel}{confirmation && createPortal(confirmation, document.body)}</>;
  return createPortal(<>{panel}{confirmation}</>, document.body);
}
