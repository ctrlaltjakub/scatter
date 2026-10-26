/** Trusted host capture bridge, serialized into the opaque-origin sandbox.
 * No same-origin permission is added. Only the embedding parent can request it. */
export function installInteractiveCapture(channel: string,
  rasterize: (svg: string, ratio: number, normalize: (root: ParentNode) => void) => Promise<string>,
  normalize: (root: ParentNode) => void,
): void {
  const later = window.setTimeout.bind(window);
  let capturing = false;
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== parent || message?.__scatterInteractive !== channel || message.type !== 'capture') return;
    const { id, pixelRatio, library } = message.payload ?? {};
    if (capturing || typeof id !== 'string' || !Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 32) return;
    capturing = true;
    void (async () => {
      try {
        type Renderer = { toSvg: (el: HTMLElement, opts: Record<string, unknown>) => Promise<string> };
        const win = window as unknown as { htmlToImage?: Renderer; __scCaptureRaf?: (callback: FrameRequestCallback) => number };
        if (!win.htmlToImage && typeof library === 'string' && library.length < 200_000) {
          // The trusted rasterizer must work even when the program is paused.
          win.__scCaptureRaf = callback => later(() => callback(performance.now()), 0);
          const script = document.createElement('script');
          script.textContent = `(function(requestAnimationFrame){${library}\n})(window.__scCaptureRaf);`;
          document.head.appendChild(script); script.remove();
          delete win.__scCaptureRaf;
        }
        if (!win.htmlToImage) throw new Error('Interactive screenshot support could not load.');
        window.dispatchEvent(new CustomEvent('scatter:capture-density', { detail: { pixelRatio } }));
        for (const canvas of document.querySelectorAll('canvas')) {
          const r = canvas.getBoundingClientRect();
          if (r.width > 0 && (canvas.width + 1 < r.width * pixelRatio || canvas.height + 1 < r.height * pixelRatio)) {
            throw new Error('This interactive program contains a low-resolution canvas. Its drawing code must support high-density rendering; capture will not upscale it.');
          }
        }
        const restore: Array<() => void> = [];
        for (const input of document.querySelectorAll<HTMLInputElement>('input[type=checkbox],input[type=radio]')) {
          const checked = input.hasAttribute('checked'); input.toggleAttribute('checked', input.checked);
          restore.push(() => input.toggleAttribute('checked', checked));
          input.toggleAttribute('data-sc-capture-mixed', input.indeterminate);
          restore.push(() => input.removeAttribute('data-sc-capture-mixed'));
        }
        for (const option of document.querySelectorAll('option')) {
          const selected = option.hasAttribute('selected'); option.toggleAttribute('selected', option.selected);
          restore.push(() => option.toggleAttribute('selected', selected));
        }
        let png: string;
        try { png = await rasterize(await win.htmlToImage.toSvg(document.documentElement, {
          width: innerWidth, height: innerHeight, pixelRatio, skipFonts: true,
          filter: (el: HTMLElement) => el.tagName !== 'SCRIPT',
        }), pixelRatio, normalize); } finally { restore.reverse().forEach(fn => fn()); }
        parent.postMessage({ __scatterInteractive: channel, type: 'capture-result', payload: { id, png } }, '*');
      } catch (error) {
        parent.postMessage({ __scatterInteractive: channel, type: 'capture-result', payload: { id, error: String((error as Error).message || error) } }, '*');
      } finally {
        window.dispatchEvent(new CustomEvent('scatter:capture-density', { detail: { pixelRatio: window.devicePixelRatio || 1 } }));
        capturing = false;
      }
    })();
  });
}
