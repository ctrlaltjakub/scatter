'use client';

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfJsPromise: Promise<PdfJsModule> | null = null;

export function pdfWorkerUrl(version: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/pdf.worker.min.mjs?v=${encodeURIComponent(version)}`;
}

/** Load PDF.js once and point it at the worker emitted by Scatter's own
 * webpack build. Keeping the URL same-origin avoids a CDN dependency and makes
 * extraction and the source viewer behave identically online and locally. */
export function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
      if (typeof window !== 'undefined') {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl(pdfjs.version);
      }
      return pdfjs;
    });
  }
  return pdfJsPromise;
}
