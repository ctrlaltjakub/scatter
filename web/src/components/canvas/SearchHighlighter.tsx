'use client';
import { useEffect } from 'react';
import { useGraphStore } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import {
  collectSearchRanges,
  rowsWithVisibleMatch,
  updateBulletMarkers,
} from '@/lib/searchHighlight';

/* -------------------------------------------------------------------------
 * SearchHighlighter — paints the search match onto the node cards, two ways,
 * both as pure side-effects so the bullet cascade NEVER re-renders on typing:
 *
 *   1. Text highlight of the matched characters, via the CSS Custom Highlight
 *      API (no DOM mutation). Feature-detected; skipped on old browsers.
 *   2. Left-margin lines flagging bullets whose (possibly collapsed/hidden)
 *      detail matches — plain DOM, works everywhere.
 *
 * Renders nothing. Mounted once by Canvas; reads `searchQuery` from the store.
 * ------------------------------------------------------------------------*/

const HIGHLIGHT_NAME = 'sc-search';
const MARKER_CONTAINER = 'sc-bullet-markers';

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function bodyOf(nodeId: string): string | undefined {
  const n = useGraphStore.getState().project?.nodes[nodeId];
  return n ? n.versions[n.currentVersionIndex]?.body : undefined;
}

export function SearchHighlighter({
  containerRef,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const query = useGraphStore((s) => s.searchQuery);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const Ctor = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
    const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
    const clearText = () => registry?.delete(HIGHLIGHT_NAME);

    // Idle (no query): clear everything, don't bother observing.
    if (!query.trim()) {
      clearText();
      updateBulletMarkers(root, '', bodyOf, 1, new Set());
      return;
    }

    let raf = 0;
    const apply = () => {
      // Compute the visible matched ranges once (doesn't need the Highlight
      // API). They drive the text highlight AND tell the marker pass which
      // bullets are already shown so it can skip them.
      const ranges = collectSearchRanges(root, query);
      if (Ctor && registry) {
        if (ranges.length > 0) registry.set(HIGHLIGHT_NAME, new Ctor(...ranges));
        else clearText();
      }
      updateBulletMarkers(
        root,
        query,
        bodyOf,
        useLiveViewportStore.getState().zoom,
        rowsWithVisibleMatch(ranges),
      );
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    schedule();

    // React to node text/layout changes (streaming, bullets expand/collapse,
    // nodes added). MUST ignore our own marker writes, or appending line divs
    // would retrigger this forever. Physics moves nodes via CSS transforms,
    // which fire neither childList nor characterData, so this stays quiet
    // while the graph settles.
    const isOurs = (n: Node | null) => {
      const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
      return !!el?.closest('.' + MARKER_CONTAINER);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((r) => !isOurs(r.target))) schedule();
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      clearText();
      updateBulletMarkers(root, '', bodyOf, 1, new Set());
    };
  }, [query, containerRef]);

  return null;
}
