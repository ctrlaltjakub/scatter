import { describe, expect, it } from 'vitest';
import { loadPdfJs, pdfWorkerUrl } from './pdfJs';

describe('PDF.js browser worker', () => {
  it('uses Scatter\'s same-origin, versioned public worker', async () => {
    const pdfjs = await loadPdfJs();

    expect(pdfWorkerUrl('6.2.108')).toBe('/pdf.worker.min.mjs?v=6.2.108');
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(pdfWorkerUrl(pdfjs.version));
  });
});
