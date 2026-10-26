import { screenshotRenderer } from './screenshotRenderers';
import { appPath } from './deployment';
import { screenshotFontCSS } from './screenshotFonts';
import { normalizeScreenshotControls } from './screenshotRasterize';

export interface CaptureRect { x: number; y: number; width: number; height: number }
export const SCREENSHOT_LONG_EDGE = 2560;
export function screenshotDimensions(rect: CaptureRect) {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
    throw new Error('Select a non-empty capture area.');
  }
  const pixelRatio = SCREENSHOT_LONG_EDGE / Math.max(rect.width, rect.height);
  return { width: Math.round(rect.width * pixelRatio), height: Math.round(rect.height * pixelRatio), pixelRatio };
}

function overlaps(a: DOMRect, b: CaptureRect): boolean {
  return a.width > 0 && a.height > 0 && a.right > b.x && a.left < b.x + b.width && a.bottom > b.y && a.top < b.y + b.height;
}
let captureLibrary: Promise<string> | undefined;
function loadLibrary(): Promise<string> {
  return captureLibrary ??= fetch(appPath('/vendor/html-to-image-1.11.13.js')).then(async response => {
    if (!response.ok) throw new Error('Screenshot support could not load. Reload and retry.');
    return response.text();
  }).catch(error => { captureLibrary = undefined; throw error; });
}
async function captureFrame(frame: HTMLIFrameElement, pixelRatio: number): Promise<string> {
  const channel = frame.dataset.scCaptureChannel;
  if (!channel) throw new Error('This area includes an external embedded page that cannot be exported faithfully. Select an area without that embed.');
  if (frame.clientWidth * frame.clientHeight * pixelRatio * pixelRatio > 40_000_000) {
    throw new Error('This selection needs too large an interactive rendering surface. Enlarge the selection; no lower-resolution substitute was saved.');
  }
  const library = await loadLibrary();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', receive); };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.__scatterInteractive !== channel
        || event.data.type !== 'capture-result' || event.data.payload?.id !== id) return;
      cleanup();
      if (event.data.payload.error) reject(new Error(event.data.payload.error));
      else if (/^data:image\/png;base64,/.test(event.data.payload.png)) resolve(event.data.payload.png);
      else reject(new Error('The interactive screenshot was invalid.'));
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The interactive screenshot timed out. Focus the node once, then retry.')); }, 20_000);
    window.addEventListener('message', receive);
    frame.contentWindow?.postMessage({ __scatterInteractive: channel, type: 'capture', payload: { id, pixelRatio, library } }, '*');
  });
}

/** Rerasterize HTML/SVG at export density; never enlarge a screen capture.
 * Canvas adapters must supply sufficient source pixels or capture fails. */
let captureActive = false;
export async function captureAppScreenshot(rect: CaptureRect, pointer?: { x: number; y: number }): Promise<Blob> {
  if (captureActive) throw new Error('A screenshot is already rendering.');
  captureActive = true;
  try { return await renderScreenshot(rect, pointer); }
  finally { captureActive = false; }
}
async function renderScreenshot(rect: CaptureRect, pointer?: { x: number; y: number }): Promise<Blob> {
  const { width, height, pixelRatio } = screenshotDimensions(rect);
  if (pixelRatio > 32) throw new Error('Select a larger area (at least 80 px on its longer edge).');
  await document.fonts.ready;
  const { toSvg } = await import('html-to-image');
  const fontEmbedCSS = await screenshotFontCSS();
  const restores: Array<() => void> = [];
  const frames = new Map<string, string>();
  const visible = (element: Element) => !element.closest('[data-sc-capture-exclude]')
    && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
    && overlaps(element.getBoundingClientRect(), rect);
  try {
    await Promise.all(Array.from(document.images).filter(visible).map(async image => {
      try { await image.decode(); }
      catch { throw new Error('An image in the capture area is unavailable. Wait for it to load or select another area.'); }
    }));
    for (const canvas of document.querySelectorAll('canvas')) {
      if (!visible(canvas)) continue;
      const bounds = canvas.getBoundingClientRect();
      const render = screenshotRenderer(canvas);
      const original = Object.getOwnPropertyDescriptor(canvas, 'toDataURL');
      let png: string;
      if (render) png = await render(pixelRatio * bounds.width / (canvas.clientWidth || bounds.width));
      else {
        if (canvas.width + 1 < bounds.width * pixelRatio || canvas.height + 1 < bounds.height * pixelRatio) {
          throw new Error('This area contains a canvas without a high-resolution export renderer. Hide that panel or select another area; no upscaled image was saved.');
        }
        png = canvas.toDataURL('image/png');
      }
      Object.defineProperty(canvas, 'toDataURL', { configurable: true, value: () => png });
      restores.push(() => original ? Object.defineProperty(canvas, 'toDataURL', original) : delete (canvas as unknown as Record<string, unknown>).toDataURL);
    }
    await Promise.all(Array.from(document.querySelectorAll('iframe')).filter(visible).map(async frame => {
      const bounds = frame.getBoundingClientRect();
      const id = crypto.randomUUID();
      frames.set(id, await captureFrame(frame, pixelRatio * bounds.width / frame.clientWidth));
      frame.dataset.scCaptureFrame = id;
      restores.push(() => { delete frame.dataset.scCaptureFrame; });
    }));
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"],input[type="radio"]')) {
      const checked = input.hasAttribute('checked'); input.toggleAttribute('checked', input.checked);
      input.toggleAttribute('data-sc-capture-mixed', input.indeterminate);
      restores.push(() => { input.toggleAttribute('checked', checked); input.removeAttribute('data-sc-capture-mixed'); });
    }
    // SVG foreignObject keeps text and vector geometry until final rasterization.
    const dataUrl = await toSvg(document.documentElement, {
      width: innerWidth, height: innerHeight,
      fontEmbedCSS,
      filter: node => !(node instanceof Element) || (!node.hasAttribute('data-sc-capture-exclude')
        && !['SCRIPT', 'NOSCRIPT'].includes(node.tagName)
        && (!(node instanceof HTMLCanvasElement || node instanceof HTMLIFrameElement) || visible(node))),
    });
    const svg = new DOMParser().parseFromString(decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1)), 'image/svg+xml');
    if (svg.querySelector('parsererror')) throw new Error('The browser could not serialize this view.');
    normalizeScreenshotControls(svg);
    if (Array.from(svg.querySelectorAll('img')).some(image => !image.getAttribute('src') || /^https?:/.test(image.getAttribute('src')!))) {
      throw new Error('An external image could not be embedded. Its server may block browser exports; select another area or use a local image.');
    }
    for (const frame of svg.querySelectorAll('[data-sc-capture-frame]')) {
      const png = frames.get(frame.getAttribute('data-sc-capture-frame')!);
      if (!png) continue;
      const image = svg.createElementNS('http://www.w3.org/1999/xhtml', 'img');
      for (const attribute of Array.from(frame.attributes)) if (!['srcdoc', 'src', 'sandbox'].includes(attribute.name)) image.setAttribute(attribute.name, attribute.value);
      image.setAttribute('src', png); frame.replaceWith(image);
    }
    const root = svg.documentElement;
    // html-to-image uses 100% for this element. Fix it to the original layout
    // before changing viewBox; otherwise selected exports clip at the crop's
    // width/height instead of the app viewport's width/height.
    for (const foreign of Array.from(root.children).filter(element => element.localName === 'foreignObject')) {
      foreign.setAttribute('width', String(innerWidth)); foreign.setAttribute('height', String(innerHeight));
    }
    root.setAttribute('width', String(width)); root.setAttribute('height', String(height));
    root.setAttribute('viewBox', `${rect.x} ${rect.y} ${rect.width} ${rect.height}`);
    if (pointer && pointer.x >= rect.x && pointer.y >= rect.y && pointer.x <= rect.x + rect.width && pointer.y <= rect.y + rect.height) {
      // Vector pointer: no low-resolution OS cursor bitmap in the export.
      const path = svg.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M0 0L0 22L6 17L11 27L15 25L10 15L19 15Z');
      path.setAttribute('transform', `translate(${pointer.x} ${pointer.y})`);
      path.setAttribute('fill', '#fff'); path.setAttribute('stroke', '#171717'); path.setAttribute('stroke-width', '1.2');
      root.appendChild(path);
    }
    const source = new XMLSerializer().serializeToString(svg);
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
    await image.decode();
    const output = document.createElement('canvas'); output.width = width; output.height = height;
    const context = output.getContext('2d');
    if (!context) throw new Error('The screenshot canvas could not be created.');
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png'));
  } finally { restores.reverse().forEach(restore => restore()); }
}
