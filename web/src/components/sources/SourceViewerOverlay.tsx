'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Search, SquareArrowRight } from 'lucide-react';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useGraphStore } from '@/store/useGraphStore';
import { loadProjectById } from '@/opfs/projectsIO';
import { loadSourceAsset } from '@/opfs/sourceAssetsIO';
import { decodeSourceDocument } from '@/lib/sourceCodec';
import type { NormalizedSourceDocument, ProjectSource } from '@/store/types';
import { exitReading, SOURCE_VIEWER_READING_ID } from '@/lib/readingController';
import { NativePdfPage } from './NativePdfPage';

interface LoadedSource {
  source: ProjectSource;
  document: NormalizedSourceDocument;
  nativePdf?: Blob;
  pageCount?: number;
}

function highlightText(text: string, query: string) {
  const needle = query.trim();
  if (!needle) return text;
  const lower = text.toLocaleLowerCase();
  const target = needle.toLocaleLowerCase();
  const output: React.ReactNode[] = [];
  let at = 0;
  let match = lower.indexOf(target);
  while (match >= 0) {
    output.push(text.slice(at, match), <mark key={`${match}:${target}`}>{text.slice(match, match + target.length)}</mark>);
    at = match + target.length;
    match = lower.indexOf(target, at);
  }
  output.push(text.slice(at));
  return output;
}

export default function SourceViewerOverlay() {
  const target = useSourceUiStore((state) => state.viewer);
  const close = useSourceUiStore((state) => state.closeViewer);
  const activeProject = useGraphStore((state) => state.project);
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) { setLoaded(null); setError(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const project = activeProject?.id === target.projectId ? activeProject : await loadProjectById(target.projectId);
        const source = project?.sourceLibrary?.sources[target.sourceId];
        const revision = source?.revisions[target.revisionId];
        if (!source || !revision) throw new Error('This source revision is no longer available.');
        const blob = await loadSourceAsset(target.projectId, revision.contentAssetId);
        if (!blob) throw new Error('The extracted source text is not available on this device yet.');
        const [document, nativePdf] = await Promise.all([
          decodeSourceDocument(blob),
          source.kind === 'pdf' && revision.originalAssetId
            ? loadSourceAsset(target.projectId, revision.originalAssetId)
            : Promise.resolve(null),
        ]);
        if (!cancelled) {
          const targetChunk = target.passageId
            ? document.chunks.find((chunk) => chunk.id === target.passageId)
            : undefined;
          const firstPage = document.blocks.find((block) => block.page != null)?.page ?? null;
          setLoaded({ source, document, nativePdf: nativePdf ?? undefined, pageCount: revision.pageCount });
          setPage(
            document.blocks.find((block) => block.id === targetChunk?.blockId)?.page
              ?? firstPage,
          );
          setError(null);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [target, activeProject]);

  useEffect(() => {
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); exitReading(); close(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [target, close]);

  useEffect(() => {
    if (!loaded || !target?.passageId) return;
    requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-source-chunk="${CSS.escape(target.passageId!)}"]`)?.scrollIntoView({ block: 'center' }));
  }, [loaded, target?.passageId]);

  const pages = useMemo(() => {
    if (!loaded) return [];
    if (loaded.nativePdf && loaded.pageCount) {
      return Array.from({ length: loaded.pageCount }, (_, index) => index + 1);
    }
    return [...new Set(loaded.document.blocks.map((block) => block.page).filter((value): value is number => value != null))];
  }, [loaded]);
  const pageIndex = page == null ? -1 : pages.indexOf(page);
  const blocks = loaded?.document.blocks.filter((block) => page == null || block.page == null || block.page === page) ?? [];

  if (!target) return null;
  return (
    <div className="text-editor-backdrop source-viewer-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) { exitReading(); close(); } }}>
      <section
        className="source-viewer-window"
        role="dialog"
        aria-modal="true"
        aria-label={loaded?.source.title ?? 'Source viewer'}
        data-sc-reading-node-id={target.nodeId ?? SOURCE_VIEWER_READING_ID}
        data-sc-reading-standalone={target.nodeId ? undefined : ''}
        data-sc-reading-scale="1"
        onPointerDown={(event) => { event.stopPropagation(); exitReading(); }}
      >
        <header className="source-viewer-head">
          <div className="source-viewer-title">
            <strong>{loaded?.source.title ?? 'Opening source…'}</strong>
            <span>{loaded?.source.kind === 'image' ? 'AI transcription' : loaded?.source.kind.toUpperCase()}</span>
          </div>
          <label className="source-viewer-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this source…" /></label>
          {loaded?.source.originalUrl && <a href={loaded.source.originalUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Live page</a>}
          <button type="button" className="text-editor-exit" onClick={() => { exitReading(); close(); }}><SquareArrowRight size={15} /> Exit</button>
        </header>
        {pages.length > 1 && (
          <nav className="source-viewer-pages" aria-label="Source pages">
            <button type="button" disabled={pageIndex <= 0} onClick={() => setPage(pages[Math.max(0, pageIndex - 1)] ?? null)}><ChevronLeft size={15} /> Previous</button>
            <span>{page == null ? 'All pages' : `Page ${page}`}</span>
            <button type="button" disabled={pageIndex < 0 || pageIndex >= pages.length - 1} onClick={() => setPage(pages[pageIndex + 1] ?? null)}>Next <ChevronRight size={15} /></button>
          </nav>
        )}
        <div className="source-viewer-scroll" ref={scrollRef} data-reading-surface="source-viewer">
          {error && <div className="source-viewer-error" role="alert">{error}</div>}
          {!loaded && !error && <div className="source-viewer-loading">Opening extracted text…</div>}
          {loaded?.nativePdf && page != null && (
            <NativePdfPage
              blob={loaded.nativePdf}
              pageNumber={page}
              query={query}
              targetText={loaded.document.chunks.find((chunk) => chunk.id === target.passageId)?.text}
            />
          )}
          {loaded && !loaded.nativePdf && <article className="source-document" data-sc-anchor="ft">
            {blocks.map((block) => {
              const blockChunks = loaded.document.chunks.filter((chunk) => chunk.blockId === block.id);
              const targetChunk = blockChunks.find((chunk) => chunk.id === target.passageId);
              return (
                <section key={block.id} className={targetChunk ? 'source-passage-target' : ''} data-source-chunk={targetChunk?.id}>
                  {block.page != null && <div className="source-page-label">Page {block.page}{block.aiTranscription ? ' · AI transcription' : ''}</div>}
                  {block.section && <h2>{block.section}</h2>}
                  <p>{highlightText(block.text, query)}</p>
                </section>
              );
            })}
          </article>}
        </div>
      </section>
    </div>
  );
}
