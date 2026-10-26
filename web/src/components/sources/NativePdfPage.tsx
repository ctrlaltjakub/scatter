'use client';

import { useEffect, useRef, useState } from 'react';
import { loadPdfJs } from '@/lib/pdfJs';

interface NativePdfPageProps {
  blob: Blob;
  pageNumber: number;
  query: string;
  targetText?: string;
}

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Fitted PDF canvas with a transparent selectable text layer. Keeping the
 * canvas and spans in the same measured viewport gives native PDFs the same
 * comfortable reader behavior as normalized documents without uploading the
 * retained original anywhere new. */
export function NativePdfPage({ blob, pageNumber, query, targetText }: NativePdfPageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = useState(0);
  const [textLayerEpoch, setTextLayerEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostWidth(Math.max(1, Math.floor(host.clientWidth)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = textLayerRef.current;
    if (!canvas || !layer || !hostWidth) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let destroyPdf: (() => void | Promise<void>) | null = null;
    void (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const loadingTask = pdfjs.getDocument({ data: await blob.arrayBuffer() });
        destroyPdf = () => loadingTask.destroy();
        const openedPdf = await loadingTask.promise;
        const page = await openedPdf.getPage(pageNumber) as {
          getViewport: (options: { scale: number }) => { width: number; height: number; transform: number[] };
          getTextContent: () => Promise<{ items: unknown[] }>;
          render: (options: object) => { cancel: () => void; promise: Promise<unknown> };
        };
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.max(0.5, Math.min(1.65, (hostWidth - 2) / base.width));
        const viewport = page.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.ceil(viewport.width * ratio);
        canvas.height = Math.ceil(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        layer.style.width = `${viewport.width}px`;
        layer.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('This browser cannot display the PDF page.');
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        const content = await page.getTextContent();
        await renderTask.promise;
        if (cancelled) return;

        const items = content.items.filter((item): item is PdfTextItem => {
          if (!item || typeof item !== 'object') return false;
          const candidate = item as Partial<PdfTextItem>;
          return typeof candidate.str === 'string'
            && Array.isArray(candidate.transform)
            && candidate.transform.length >= 6
            && typeof candidate.width === 'number';
        });
        const flattened = normalized(items.map((item) => item.str).join(' '));
        const target = normalized(targetText ?? '');
        const targetAt = target ? flattened.indexOf(target) : -1;
        let textOffset = 0;
        layer.replaceChildren();
        layer.dataset.flattenedText = flattened;
        for (const item of items) {
          const itemText = normalized(item.str);
          const start = textOffset;
          const end = start + itemText.length;
          textOffset = end + 1;
          if (!item.str) continue;
          const transform = pdfjs.Util.transform(viewport.transform, item.transform);
          const angle = Math.atan2(transform[1], transform[0]);
          const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
          const span = document.createElement('span');
          span.textContent = item.str;
          span.style.left = `${transform[4]}px`;
          span.style.top = `${transform[5] - fontHeight}px`;
          span.style.fontSize = `${fontHeight}px`;
          span.style.transform = angle ? `rotate(${angle}rad)` : '';
          span.dataset.textStart = String(start);
          span.dataset.textEnd = String(end);
          if (targetAt >= 0 && start < targetAt + target.length && end > targetAt) {
            span.classList.add('source-pdf-target');
          }
          layer.append(span);
          const measured = span.getBoundingClientRect().width;
          const desired = item.width * scale;
          if (measured > 0 && desired > 0) {
            const stretch = desired / measured;
            span.style.transform = `${angle ? `rotate(${angle}rad) ` : ''}scaleX(${stretch})`;
          }
        }
        setTextLayerEpoch((value) => value + 1);
        setError(null);
      } catch (reason) {
        if (!cancelled && (reason as Error)?.name !== 'RenderingCancelledException') {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      void destroyPdf?.();
    };
  }, [blob, hostWidth, pageNumber, targetText]);

  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;
    const needle = normalized(query);
    const queryAt = needle ? (layer.dataset.flattenedText ?? '').indexOf(needle) : -1;
    for (const span of layer.querySelectorAll<HTMLElement>('span')) {
      const start = Number(span.dataset.textStart ?? -1);
      const end = Number(span.dataset.textEnd ?? -1);
      span.classList.toggle(
        'source-pdf-match',
        queryAt >= 0 && start < queryAt + needle.length && end > queryAt,
      );
    }
  }, [query, hostWidth, pageNumber, textLayerEpoch]);

  return (
    <div className="source-native-pdf" ref={hostRef}>
      {error && <div className="source-viewer-error" role="alert">{error}</div>}
      <div className="source-native-pdf-page" data-sc-anchor="ft">
        <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
        <div ref={textLayerRef} className="source-native-pdf-text" aria-label={`Selectable text for page ${pageNumber}`} />
      </div>
    </div>
  );
}
