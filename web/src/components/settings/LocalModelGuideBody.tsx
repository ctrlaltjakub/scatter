'use client';

import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { markChatInline } from '@/lib/chat/markdown';
import { previewFormattedParts } from '@/lib/relationPreview';
import guide from './localModelGuide.generated.json';

const previews: Readonly<Record<string, string>> = guide.previews;
const termKey = (term: string) => term.trim().replace(/\s+/g, ' ').toLowerCase();
const remarkPlugins = [() => markChatInline];
const components: Components = {
  a: ({ children, href }) => {
    if (!href?.startsWith('#chat-term/')) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    const term = decodeURIComponent(href.slice('#chat-term/'.length));
    // Deliberately not a link/button or canvas relation: clicks cannot navigate
    // or create nodes. Keyboard focus offers the same explanation as hovering.
    return <span className="ref-chip unexplored local-guide-term" data-guide-term={term}
      tabIndex={previews[termKey(term)] ? 0 : undefined}>{children}</span>;
  },
};
const GuideMarkdown = memo(function GuideMarkdown() {
  return <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>{guide.body}</ReactMarkdown>;
});

interface PreviewTarget { element: HTMLElement; text: string }

function GuidePreview({ target, id }: { target: PreviewTarget; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = target.element.getBoundingClientRect();
    const box = ref.current!.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + (anchor.width - box.width) / 2, window.innerWidth - box.width - 8));
    const above = anchor.top - box.height - 6;
    const top = Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 6, window.innerHeight - box.height - 8));
    setPosition({ left, top });
    target.element.setAttribute('aria-describedby', id);
    return () => target.element.removeAttribute('aria-describedby');
  }, [target, id]);
  return <div ref={ref} id={id} role="tooltip" className="relation-hover-preview is-explanation local-guide-preview"
    style={position ?? { visibility: 'hidden' }}>
    <div className="relation-hover-preview-copy">{previewFormattedParts(target.text).map((part, index) => {
      const text = part.italic ? <em>{part.text}</em> : part.text;
      return part.bold ? <strong key={index}>{text}</strong> : <span key={index}>{text}</span>;
    })}</div>
  </div>;
}

/** Static, pre-generated enrichment: the same Markdown terms, preview copy
 * formatter and CSS as nodes, without their graph actions or model requests. */
export function LocalModelGuideBody() {
  const body = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const previewId = useId();
  const cancelTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  const hide = () => { cancelTimer(); setTarget(null); };
  const elementAt = (value: EventTarget | null) => value instanceof Element
    ? value.closest<HTMLElement>('[data-guide-term]') : null;
  const show = (element: HTMLElement | null, delay = 120) => {
    cancelTimer();
    const text = previews[termKey(element?.dataset.guideTerm ?? '')];
    if (!element || !text || !body.current?.contains(element)) { setTarget(null); return; }
    timer.current = setTimeout(() => { timer.current = null; setTarget({ element, text }); }, delay);
  };
  const leave = () => { cancelTimer(); timer.current = setTimeout(() => { timer.current = null; setTarget(null); }, 80); };
  useEffect(() => {
    const onResize = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; setTarget(null); };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); if (timer.current !== null) clearTimeout(timer.current); };
  }, []);
  return <>
    <div ref={body} className="local-guide-body" onScroll={hide}
      onMouseOver={event => { const element = elementAt(event.target); if (element !== elementAt(event.relatedTarget)) show(element); }}
      onMouseOut={event => { if (elementAt(event.target) !== elementAt(event.relatedTarget)) leave(); }}
      onFocus={event => show(elementAt(event.target), 0)} onBlur={leave}>
      <GuideMarkdown />
    </div>
    {target && <GuidePreview target={target} id={previewId} />}
  </>;
}
