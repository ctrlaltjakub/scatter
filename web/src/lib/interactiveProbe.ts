import { buildInteractiveSrcDoc, type InteractiveHostTheme, validateInteractiveDocument, preferredInteractiveViewport, INTERACTIVE_MAX_DIMENSION } from './interactiveDocument';
import { interactiveProbeRuntime } from './interactiveProbeRuntime';
import { appPath } from './deployment';
import { normalizeScreenshotControls, rasterizeScreenshotSvg } from './screenshotRasterize';
import { alternateInteractiveTheme } from './interactiveTheme';
import { runVisibleInteractiveProbe, type InteractiveProbeLifecycle } from './interactiveVisibility';
import { validInteractiveActions, validInteractiveAssertions, type InteractiveCheck, type InteractiveProbeOptions, type InteractiveTestAction } from './interactiveTests';
export { INTERACTIVE_TEST_KEYS, type InteractiveCheck, type InteractiveTestAction } from './interactiveTests';

let captureSource: string | undefined;
async function loadCaptureSource(signal: AbortSignal): Promise<string> {
  // Cache successful loads only. Concurrent builds have separate abort
  // signals: cancelling one must not abort another build's asset request.
  if (captureSource) return captureSource;
  const response = await fetch(appPath('/vendor/html-to-image-1.11.13.js'), { signal });
  if (!response.ok) throw new Error('Screenshot support could not load. Reload the app and retry.');
  const source = await response.text();
  if (!source.includes('htmlToImage')) throw new Error('The screenshot renderer is unavailable. Reload the app and retry.');
  captureSource = source.replace(/<\/script/gi, '<\\/script').replace(/\/\/# sourceMappingURL=.*$/gm, '');
  return captureSource;
}

/** Short-lived opaque-origin verification frame. Capture runs INSIDE it: never
 * grant model code same-origin access to the parent, storage, or API keys. */
export async function checkInteractiveDocument(
  html: string, theme: InteractiveHostTheme, signal: AbortSignal, actions: InteractiveTestAction[] = [],
  options: InteractiveProbeOptions = {},
  lifecycle: InteractiveProbeLifecycle = {},
): Promise<InteractiveCheck> {
  if (typeof document === 'undefined') throw new Error('A browser is required to verify the interactive program.');
  return runVisibleInteractiveProbe(attempt => checkVisibleInteractiveDocument(html, theme, attempt, actions, options), signal, lifecycle);
}

async function checkVisibleInteractiveDocument(
  html: string, theme: InteractiveHostTheme, signal: AbortSignal, actions: InteractiveTestAction[],
  options: InteractiveProbeOptions,
): Promise<InteractiveCheck> {
  try {
    validateInteractiveDocument(html, { requireDesignTokens: true });
    if (!validInteractiveActions(actions)) throw new Error('Use at most six valid click/input/press actions.');
    if (options.assertions && !validInteractiveAssertions(options.assertions)) throw new Error('Provide one to eight valid outcome assertions.');
  } catch (error) { return { ok: false, errors: [(error as Error).message] }; }
  if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  if (typeof document === 'undefined') throw new Error('A browser is required to verify the interactive program.');
  let library = '';
  try { library = options.screenshot ? await loadCaptureSource(signal) : ''; }
  catch (error) {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    // An unavailable renderer is infrastructure failure, not feedback for the
    // coding model. The acceptance gate must stop rather than pay for repairs.
    const message = `Screenshot support could not load: ${(error as Error).message}. Reload the app and retry.`;
    return { ok: false, errors: [message], captureError: message };
  }
  if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  const channel = `interactive-check-${crypto.randomUUID()}`;
  const viewport = preferredInteractiveViewport(html);
  const effectiveTheme = options.alternateTheme ? alternateInteractiveTheme(theme) : theme;
  const payload = JSON.stringify({ channel, actions, ...options, background: effectiveTheme.background }).replace(/</g, '\\u003c');
  // The rasterizer awaits animation frames while decoding images. Chromium
  // throttles those in invisible iframes; give only this trusted library a
  // native-timer equivalent, without changing the model program's scheduler.
  const renderer = library ? `(function(){var later=window.setTimeout.bind(window);(function(requestAnimationFrame){${library}\n})(function(callback){return later(function(){callback(performance.now())},0)})})();` : '';
  const probe = `<script>${renderer}\n;(${interactiveProbeRuntime.toString()})(${payload}, (${rasterizeScreenshotSvg.toString()}), (${normalizeScreenshotControls.toString()}));</script>`;
  // Verification must execute normally (including sequencer clocks), but the
  // invisible draft must never be audible. This also covers capability tests.
  const compiled = buildInteractiveSrcDoc(html, channel, { active: true, theme: effectiveTheme }, viewport, { muteAudio: true });
  const src = compiled.replace(/<head(?:\s[^>]*)?>/i, tag => tag + probe);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true'); frame.title = 'Checking interactive program'; frame.tabIndex = -1;
  // This disposable, invisible verifier is not part of the app screenshot.
  frame.setAttribute('data-sc-capture-exclude', '');
  frame.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;pointer-events:none;opacity:0;z-index:-2147483647`;
  const errors: string[] = [];
  let layout: { width: number; height: number; clipped: number; negativeOverflow: boolean } | undefined;
  let adjustments = 0;
  return new Promise<InteractiveCheck>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout); window.removeEventListener('message', receive);
      signal.removeEventListener('abort', abort); frame.remove();
    };
    const abort = () => { cleanup(); reject(new DOMException('Stopped', 'AbortError')); };
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.__scatterInteractive !== channel) return;
      if (event.data.type === 'layout') {
        const measured = event.data.payload;
        if (!Number.isFinite(measured?.width) || !Number.isFinite(measured?.height)) return;
        layout = measured;
        if (adjustments < 3 && (measured.width > viewport.width + 2 || measured.height > viewport.height + 2)) {
          viewport.width = Math.min(INTERACTIVE_MAX_DIMENSION, Math.max(viewport.width, Math.ceil(measured.width)));
          viewport.height = Math.min(INTERACTIVE_MAX_DIMENSION, Math.max(viewport.height, Math.ceil(measured.height)));
          frame.style.width = `${viewport.width}px`; frame.style.height = `${viewport.height}px`;
          adjustments++;
        }
        return;
      }
      if (event.data.type === 'error') errors.push(String(event.data.payload?.message ?? 'Runtime error').slice(0, 1000));
      if (event.data.type !== 'check-result') return;
      const result = event.data.payload;
      errors.push(...(Array.isArray(result?.errors) ? result.errors.map(String).slice(0, 12) : []));
      if (layout && (layout.width > viewport.width + 2 || layout.height > viewport.height + 2 || layout.negativeOverflow)) {
        errors.push(`Content still extends outside the adapted ${viewport.width}×${viewport.height} viewport. Reflow the overflowing elements; dimensions may grow up to ${INTERACTIVE_MAX_DIMENSION}px per side.`);
      }
      const screenshot = typeof result?.screenshot === 'string' && /^data:image\/(?:png|jpeg);base64,/.test(result.screenshot)
        && result.screenshot.length < 5_000_000 ? result.screenshot : undefined;
      const captureError = result?.captureError || (options.screenshot && !screenshot
        ? typeof result?.screenshot === 'string' && result.screenshot.length >= 5_000_000
          ? 'The review image exceeded the capture payload limit. Run another pass to retry capture.'
          : errors.length ? `The browser check ended before returning a review image: ${errors.join(' ').slice(0, 1500)}`
            : 'The browser returned no usable review image. Wait for other screen captures to finish, then run another pass.' : undefined);
      cleanup(); resolve({ ok: !errors.length && !captureError, errors: errors.slice(0, 16), controls: result?.controls, text: result?.text, viewport,
        layoutNotes: layout?.clipped ? [`${layout.clipped} container(s) use clipping. This can be intentional decoration; inspect the screenshot for actual hidden text or controls before requesting repairs.`] : undefined,
        assertions: result?.assertions, screenshot, themeMode: effectiveTheme.mode, captureNotes: result?.captureNotes, captureError });
    };
    const timeout = setTimeout(() => { cleanup(); resolve({ ok: false, errors: ['The browser check timed out. Simplify the program or retry.'],
      captureError: options.screenshot ? 'Screenshot capture timed out.' : undefined }); }, options.screenshot ? 15_000 : 6000);
    window.addEventListener('message', receive); signal.addEventListener('abort', abort, { once: true });
    frame.srcdoc = src; document.body.appendChild(frame);
  });
}
