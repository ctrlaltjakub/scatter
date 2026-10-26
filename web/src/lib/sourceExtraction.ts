'use client';

import type { ProjectSourceKind, SourceBlock } from '@/store/types';
import { transcribeSourceImage } from './secondaryTaskCompletion';
import { loadPdfJs } from './pdfJs';

const OCR_CONCURRENCY = 5;
let activeOcr = 0;
const waitingOcr: Array<() => void> = [];

async function withOcrSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeOcr >= OCR_CONCURRENCY) {
    await new Promise<void>((resolve) => waitingOcr.push(resolve));
  }
  activeOcr += 1;
  try {
    return await task();
  } finally {
    activeOcr -= 1;
    waitingOcr.shift()?.();
  }
}

export interface ExtractedSource {
  blocks: SourceBlock[];
  retainOriginal: boolean;
  pageCount?: number;
  capturedTitle?: string;
}

export interface SourceExtractionProgress {
  stage: 'ocr';
  page: number;
  pageCount: number;
  completedPages: number[];
  text: string;
}

export function sourceKindForFile(file: File): ProjectSourceKind | null {
  const name = file.name.toLocaleLowerCase();
  const type = file.type.toLocaleLowerCase();
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type.includes('wordprocessingml') || name.endsWith('.docx')) return 'docx';
  if (type.startsWith('image/')) return 'image';
  if (name.endsWith('.md') || name.endsWith('.markdown') || type === 'text/markdown') return 'markdown';
  if (type.startsWith('text/') || name.endsWith('.txt')) return 'text';
  return null;
}

function textBlocks(text: string): SourceBlock[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const sections = normalized.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return sections.map((value, index) => ({ id: `block-${index + 1}`, text: value }));
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read source image.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function extractPdf(
  blob: Blob,
  signal?: AbortSignal,
  onProgress?: (progress: SourceExtractionProgress) => void | Promise<void>,
  completedOcrPages: ReadonlyMap<number, string> = new Map(),
): Promise<ExtractedSource> {
  const pdfjs = await loadPdfJs();
  const pdfDocument = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  const blocks: SourceBlock[] = [];
  const ocrPages: number[] = [];
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const page = await pdfDocument.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
      .replace(/\s+/g, ' ').trim();
    if (text.length >= 40) {
      blocks.push({ id: `page-${pageNumber}`, text, page: pageNumber });
    } else {
      ocrPages.push(pageNumber);
    }
  }
  if (ocrPages.length > 0) {
    const completed = new Set<number>(
      ocrPages.filter((pageNumber) => completedOcrPages.has(pageNumber)),
    );
    const transcribed = await Promise.all(ocrPages.map((pageNumber) => withOcrSlot(async () => {
      const retained = completedOcrPages.get(pageNumber);
      if (retained !== undefined) {
        return { id: `page-${pageNumber}`, text: retained, page: pageNumber, aiTranscription: true } satisfies SourceBlock;
      }
      // The slot covers rendering as well as the network request. Previously
      // every scanned page allocated a canvas at once and only the AI calls
      // were capped, which could freeze or exhaust memory on a long scan.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.6 });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('This browser cannot render a scanned PDF page.');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      const text = await transcribeSourceImage(dataUrl, `page ${pageNumber}`, signal);
      canvas.width = 1;
      canvas.height = 1;
      completed.add(pageNumber);
      await onProgress?.({
        stage: 'ocr',
        page: pageNumber,
        pageCount: pdfDocument.numPages,
        completedPages: [...completed].sort((a, b) => a - b),
        text,
      });
      return { id: `page-${pageNumber}`, text, page: pageNumber, aiTranscription: true } satisfies SourceBlock;
    })));
    blocks.push(...transcribed.filter((block) => block.text.trim()));
  }
  blocks.sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  return {
    blocks,
    pageCount: pdfDocument.numPages,
    // Keep native PDFs; discard a fully scanned input after OCR succeeds.
    retainOriginal: ocrPages.length < pdfDocument.numPages,
  };
}

async function extractDocx(blob: Blob): Promise<ExtractedSource> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return { blocks: textBlocks(result.value), retainOriginal: true };
}

export async function extractSourceBlob(
  blob: Blob,
  kind: ProjectSourceKind,
  signal?: AbortSignal,
  onProgress?: (progress: SourceExtractionProgress) => void | Promise<void>,
  completedOcrPages: ReadonlyMap<number, string> = new Map(),
): Promise<ExtractedSource> {
  if (kind === 'pdf') return extractPdf(blob, signal, onProgress, completedOcrPages);
  if (kind === 'docx') return extractDocx(blob);
  if (kind === 'image') {
    const retained = completedOcrPages.get(1);
    if (retained !== undefined) {
      return {
        blocks: retained ? [{ id: 'page-1', text: retained, page: 1, aiTranscription: true }] : [],
        retainOriginal: false,
        pageCount: 1,
      };
    }
    const dataUrl = await blobToDataUrl(blob);
    const text = await withOcrSlot(() => transcribeSourceImage(dataUrl, 'the source image', signal));
    await onProgress?.({ stage: 'ocr', page: 1, pageCount: 1, completedPages: [1], text });
    return {
      blocks: text ? [{ id: 'page-1', text, page: 1, aiTranscription: true }] : [],
      retainOriginal: false,
      pageCount: 1,
    };
  }
  return { blocks: textBlocks(await blob.text()), retainOriginal: false };
}

function safePublicUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https webpage address.');
  const host = url.hostname.toLocaleLowerCase();
  if (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local')
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) throw new Error('Private and local webpages cannot be sent to the reader service.');
  return url;
}

function blocksFromArticle(title: string, text: string): SourceBlock[] {
  const blocks = textBlocks(text);
  return blocks.map((block, index) => ({ ...block, section: index === 0 ? title : undefined }));
}

export async function extractWebpage(
  urlText: string,
  signal?: AbortSignal,
  onFetchStage?: (stage: 'fetch-direct' | 'fetch-jina') => void | Promise<void>,
): Promise<ExtractedSource & { finalUrl: string }> {
  const url = safePublicUrl(urlText);
  let html = '';
  let finalUrl = url.href;
  try {
    await onFetchStage?.('fetch-direct');
    const response = await fetch(url.href, { signal, credentials: 'omit', redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    html = await response.text();
    finalUrl = response.url || url.href;
  } catch (directError) {
    if (signal?.aborted) throw directError;
    await onFetchStage?.('fetch-jina');
    const response = await fetch(`https://r.jina.ai/${url.href}`, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) throw new Error(`Could not fetch this webpage directly or through Jina Reader (HTTP ${response.status}).`);
    const text = await response.text();
    return {
      blocks: textBlocks(text),
      retainOriginal: false,
      capturedTitle: url.hostname,
      finalUrl: url.href,
    };
  }
  const [{ Readability }, DOMPurify] = await Promise.all([
    import('@mozilla/readability'),
    import('dompurify'),
  ]);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const article = new Readability(parsed.cloneNode(true) as Document).parse();
  const clean = DOMPurify.default.sanitize(article?.content ?? parsed.body.innerHTML, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'pre', 'code', 'blockquote'],
    ALLOWED_ATTR: [],
  });
  const inert = new DOMParser().parseFromString(clean, 'text/html');
  const text = inert.body.innerText || inert.body.textContent || '';
  const title = article?.title?.trim() || parsed.title.trim() || url.hostname;
  return {
    blocks: blocksFromArticle(title, text),
    retainOriginal: false,
    capturedTitle: title,
    finalUrl,
  };
}
