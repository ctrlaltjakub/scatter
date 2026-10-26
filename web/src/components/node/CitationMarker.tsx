'use client';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink } from 'lucide-react';
import { useGraphStore } from '@/store/useGraphStore';
import { useSourceUiStore } from '@/store/useSourceUiStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useNodeContentInteraction } from './NodeContentInteractionContext';

/** Never turn model-provided citation URLs into executable/navigation schemes. */
export function citationUrl(url: string | undefined): string | null {
  try { const parsed = new URL(url ?? ''); return /^https?:$/.test(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}

function CitationPreview({ anchor, text, id, screenSized }: { anchor: DOMRect; text: string; id: string; screenSized: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const canvasZoom = useLiveViewportStore(s => s.zoom);
  const scale = screenSized ? 1 : canvasZoom;
  useLayoutEffect(() => {
    if (!card.current) return;
    const width = card.current.offsetWidth * scale, height = card.current.offsetHeight * scale;
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, anchor.left + anchor.width / 2 - width / 2)),
      top: anchor.top - height - 6 >= 8 ? anchor.top - height - 6 : Math.max(8, Math.min(window.innerHeight - height - 8, anchor.bottom + 6)) });
  }, [anchor, scale, text]);
  return createPortal(<div ref={card} id={id} role="tooltip" className="relation-hover-preview citation-hover-preview"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden', transform: `scale(${scale})` }}>
    <span>{text}</span><ExternalLink size={14} aria-hidden="true" />
  </div>, document.body);
}

/** Citations open their source directly. Internal citations retain the exact
 * imported passage; web citations remain native new-tab links. */
export function CitationMarker({ n, parentNodeId, internal = false }: { n: number; parentNodeId: string; internal?: boolean }) {
  const interaction = useNodeContentInteraction();
  const source = useGraphStore(s => {
    if (internal && interaction?.citationInternalSources) return interaction.citationInternalSources.find(source => source.n === n);
    if (!internal && interaction?.citationSources) return interaction.citationSources.find(source => source.n === n);
    const node = s.project?.nodes[parentNodeId];
    const version = interaction?.citationVersionCreatedAt == null ? node?.versions[node.currentVersionIndex]
      : node?.versions.find(v => v.createdAt === interaction.citationVersionCreatedAt);
    return internal ? version?.internalSources?.find(s => s.n === n) : version?.sources?.find(s => s.n === n);
  });
  const id = useId();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; setAnchor(null); }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!anchor) return;
    document.addEventListener('wheel', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('wheel', clear, true); window.removeEventListener('resize', clear);
    };
  }, [anchor, clear]);
  const href = source && 'url' in source ? citationUrl(source.url) : null;
  const text = source && 'sourceTitle' in source ? `${source.sourceTitle}${source.page ? ` · Page ${source.page}` : ''}`
    : href ? (source && 'domain' in source && source.domain) || new URL(href).hostname.replace(/^www\./, '') : 'Source unavailable';
  const props = {
    className: 'cite-marker',
    'aria-label': `${internal ? 'Project source' : 'Source'} ${n}`,
    'aria-describedby': anchor ? id : undefined,
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      if (timer.current) clearTimeout(timer.current);
      const rect = event.currentTarget.getBoundingClientRect(); timer.current = setTimeout(() => setAnchor(rect), 120);
    },
    onMouseLeave: clear,
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; setAnchor(event.currentTarget.getBoundingClientRect());
    },
    onBlur: clear,
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); },
  };
  const label = internal ? `(${n})` : `[${n}]`;
  return <>
    {href ? <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={event => { event.stopPropagation(); clear(); }}>{label}</a>
      : source && 'sourceId' in source ? <button {...props} type="button" onClick={event => {
        event.stopPropagation(); clear();
        const projectId = useGraphStore.getState().project?.id;
        if (projectId) useSourceUiStore.getState().openViewer({ projectId, sourceId: source.sourceId, revisionId: source.revisionId,
          passageId: source.passageId, nodeId: parentNodeId });
      }}>{label}</button> : <span {...props} tabIndex={0}>{label}</span>}
    {anchor && <CitationPreview anchor={anchor} text={text} id={id} screenSized={!!interaction?.ignoreCanvasZoomForTerms} />}
  </>;
}
