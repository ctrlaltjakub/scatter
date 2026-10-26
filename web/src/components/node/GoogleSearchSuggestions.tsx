'use client';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useResolvedTheme } from '@/hooks/useResolvedTheme';
import { mergeGoogleSearchSuggestions } from '@/lib/googleSearchSuggestions';
import type { ResolvedTheme } from '@/lib/theme';

const SIZE_MESSAGE = 'scatter:google-suggestions-size';
const MEASURE_MESSAGE = 'scatter:google-suggestions-measure';
const SCROLL_MESSAGE = 'scatter:google-suggestions-scroll';
// Google's 48px widget plus room for its own 1px outer outline on both sides.
const INITIAL_FRAME_HEIGHT = 50;
const MAX_FRAME_HEIGHT = 640;

// Only this app-owned script may execute in the opaque-origin frame. Provider
// scripts are removed, and the CSP nonce authorizes this resize reporter alone.
const RESIZE_SCRIPT = `(() => {
  const content = document.body.firstElementChild;
  let lastHeight = 0;
  const reportScroll = (scroller, scrolling = false) => parent.postMessage({
    type: '${SCROLL_MESSAGE}', left: scroller?.scrollLeft ?? 0,
    viewport: scroller?.clientWidth ?? 0, width: scroller?.scrollWidth ?? 0, scrolling,
  }, '*');
  const findScroller = () => {
    for (const element of content.querySelectorAll('*')) {
      if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth
        && /auto|scroll|overlay/.test(getComputedStyle(element).overflowX)) return element;
    }
    const root = document.scrollingElement;
    return root?.scrollWidth > root?.clientWidth ? root : null;
  };
  const report = () => {
    const height = Math.ceil(Math.max(content.getBoundingClientRect().height, content.scrollHeight));
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      parent.postMessage({ type: '${SIZE_MESSAGE}', height }, '*');
    }
    // Supply thumb geometry before the first scroll, so hover works immediately.
    reportScroll(findScroller());
  };
  new ResizeObserver(report).observe(content);
  document.fonts?.ready?.then(report);
  let scrollFrame = 0;
  addEventListener('scroll', event => {
    const scroller = event.target === document ? document.scrollingElement : event.target;
    if (!(scroller instanceof Element) || scroller.scrollWidth <= scroller.clientWidth) return;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => reportScroll(scroller, true));
  }, { capture: true, passive: true });
  addEventListener('message', event => {
    if (event.source === parent && event.data === '${MEASURE_MESSAGE}') {
      lastHeight = 0;
      report();
    }
  });
  report();
})();`;

export function googleSuggestionsDocument(html: string, theme: ResolvedTheme = 'light'): string {
  // The supplied snippet starts with <style>. A body-fragment sanitizer would
  // discard that leading style element before examining the rest of the widget.
  const clean = DOMPurify.sanitize(`<div>${html}</div>`, { ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'meta', 'base', 'link', 'foreignObject'],
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  // Keep both supplied palettes unchanged, but select them using the app theme.
  // Sandboxed frames/media emulation can otherwise follow the OS preference
  // even when the iframe and the app explicitly use the opposite color scheme.
  doc.querySelectorAll('style').forEach(style => {
    style.textContent = style.textContent?.replace(
      /@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{/gi,
      (_query, palette: string) => `@media ${palette.toLowerCase() === theme ? 'all' : 'not all'} {`,
    ) ?? '';
  });
  doc.querySelectorAll('a').forEach(link => {
    if (!/^https?:\/\//i.test(link.getAttribute('href') ?? '')) link.removeAttribute('href');
    link.target = '_blank'; link.rel = 'noopener noreferrer';
  });
  const nonce = crypto.randomUUID();
  // Native scrollbars can reserve space inside the frame on some platforms.
  // Scrolling stays native; the app draws a non-layout overlay instead.
  // Keep the supplied outer shadow inside the iframe's paint area. Without
  // this 1px inset, straight edges are clipped while the curved parts survive.
  // The host must not add another border over the supplied outline.
  return `<!doctype html><html style="color-scheme:${theme}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;padding:0;background:transparent}body{overflow-x:auto}*{scrollbar-width:none!important;scrollbar-gutter:auto!important}*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}</style>${doc.head.innerHTML}</head><body><div style="display:flow-root;padding:1px">${doc.body.innerHTML}</div><script nonce="${nonce}">${RESIZE_SCRIPT}</script></body></html>`;
}

/** Google's supplied attribution is isolated from the app's CSS and scripts.
 * It never gains same-origin access, including when loaded from imported projects. */
export const GoogleSearchSuggestions = memo(function GoogleSearchSuggestions({ snippets, showLabel = true }: {
  snippets?: string[];
  showLabel?: boolean;
}) {
  const theme = useResolvedTheme();
  const documents = useMemo(() => typeof window === 'undefined' ? []
    : (mergeGoogleSearchSuggestions(snippets) ?? []).map(html => googleSuggestionsDocument(html, theme)), [snippets, theme]);
  const framesRef = useRef<(HTMLIFrameElement | null)[]>([]);
  const [measurements, setMeasurements] = useState<{ documents: string[]; heights: number[] }>();
  const [scrollFeedback, setScrollFeedback] = useState<{
    documents: string[];
    frames: Record<number, { left: number; width: number; visible: boolean } | undefined>;
  }>();
  const heights = measurements?.documents === documents ? measurements.heights : undefined;
  const scrollFrames = scrollFeedback?.documents === documents ? scrollFeedback.frames : undefined;

  useLayoutEffect(() => {
    if (!documents.length) return;
    const scrollTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const onMessage = (event: MessageEvent) => {
      if (!event.source || (event.data?.type !== SIZE_MESSAGE && event.data?.type !== SCROLL_MESSAGE)) return;
      const index = framesRef.current.findIndex(frame => frame?.contentWindow === event.source);
      if (index < 0 || index >= documents.length) return;
      if (event.data.type === SCROLL_MESSAGE) {
        const { left, viewport, width } = event.data;
        if (![left, viewport, width].every(value => typeof value === 'number' && Number.isFinite(value))
          || viewport < 0 || width < 0) return;
        const overflowing = viewport > 0 && width > viewport;
        const scrolling = event.data.scrolling === true;
        const thumbWidth = overflowing ? Math.max(4, 100 * viewport / width) : 0;
        const thumbLeft = overflowing ? Math.max(0, Math.min(1, left / (width - viewport))) * (100 - thumbWidth) : 0;
        setScrollFeedback(previous => {
          const frames = previous?.documents === documents ? previous.frames : {};
          const old = frames[index];
          const next = overflowing ? { left: thumbLeft, width: thumbWidth, visible: scrolling || !!old?.visible } : undefined;
          if (old?.left === next?.left && old?.width === next?.width && old?.visible === next?.visible) return previous;
          return { documents, frames: { ...frames, [index]: next } };
        });
        if (scrolling || !overflowing) {
          clearTimeout(scrollTimers.get(index));
          scrollTimers.delete(index);
        }
        if (scrolling && overflowing) scrollTimers.set(index, setTimeout(() => {
          scrollTimers.delete(index);
          setScrollFeedback(previous => {
            if (!previous || previous.documents !== documents) return previous;
            const frame = previous.frames[index];
            return frame?.visible ? { ...previous, frames: { ...previous.frames, [index]: { ...frame, visible: false } } } : previous;
          });
        }, 800));
        return;
      }
      if (typeof event.data.height !== 'number' || !Number.isFinite(event.data.height) || event.data.height <= 0) return;
      const height = Math.min(MAX_FRAME_HEIGHT, Math.ceil(event.data.height));
      setMeasurements(previous => {
        const next = previous?.documents === documents
          ? previous.heights : documents.map(() => INITIAL_FRAME_HEIGHT);
        if (previous?.documents === documents && next[index] === height) return previous;
        const updated = [...next];
        updated[index] = height;
        return { documents, heights: updated };
      });
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      scrollTimers.forEach(clearTimeout);
    };
  }, [documents]);

  if (!documents.length) return null;
  return <div className="google-search-suggestions" data-reading-exclude="true" onPointerDown={event => event.stopPropagation()}>
    {showLabel && <span className="google-search-suggestions-label">Searched:</span>}
    <div className="google-search-suggestions-frames">
      {documents.map((srcDoc, index) => {
        const feedback = scrollFrames?.[index];
        return <div className="google-search-suggestions-frame" key={srcDoc}>
          <iframe title={`Google Search suggestions ${index + 1}`}
            ref={frame => { framesRef.current[index] = frame; }}
            onLoad={event => event.currentTarget.contentWindow?.postMessage(MEASURE_MESSAGE, '*')}
            srcDoc={srcDoc} sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
            style={{ height: heights?.[index] ?? INITIAL_FRAME_HEIGHT, colorScheme: theme }} />
          {feedback && <div
            className="google-search-suggestions-scrollbar" aria-hidden="true" data-visible={feedback.visible}
            style={{ left: `${feedback.left}%`, width: `${feedback.width}%` }} />}
        </div>;
      })}
    </div>
  </div>;
});
