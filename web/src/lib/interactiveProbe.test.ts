import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERACTIVE_HOST_STATE } from './interactiveDocument';

const html = '<!doctype html><html><body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)">Hello</body></html>';
let checkInteractiveDocument: typeof import('./interactiveProbe').checkInteractiveDocument;
beforeEach(async () => {
  // Isolate the cached screenshot renderer, including its load-failure tests.
  vi.resetModules();
  ({ checkInteractiveDocument } = await import('./interactiveProbe'));
});
afterEach(() => vi.unstubAllGlobals());

describe('silent generation and model-capability checks', () => {
  it.each([false, true])('always mutes active verification frames (screenshot: %s)', async screenshot => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'var htmlToImage = {};' })));
    const controller = new AbortController();
    const check = checkInteractiveDocument(html, DEFAULT_INTERACTIVE_HOST_STATE.theme, controller.signal, [], { screenshot });
    const cancelled = expect(check).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
      const frame = document.querySelector('iframe')!;
      expect(frame.srcdoc).toContain('silentDestination');
      expect(frame.srcdoc).toContain('"active":true');
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    } finally { controller.abort(); }
    await cancelled;
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('screenshot renderer loading', () => {
  it('reports asset failure as unavailable capture, not a program defect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const result = await checkInteractiveDocument(html, DEFAULT_INTERACTIVE_HOST_STATE.theme, new AbortController().signal, [], { screenshot: true });
    expect(result.ok).toBe(false);
    expect(result.captureError).toContain('Screenshot support could not load');
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('preserves cancellation during asset loading', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw new DOMException('Stopped', 'AbortError'); }));
    await expect(checkInteractiveDocument(html, DEFAULT_INTERACTIVE_HOST_STATE.theme, controller.signal, [], { screenshot: true }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(document.querySelector('iframe')).toBeNull();
  });
  it('preserves the actual browser error when verification exits before capture', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => 'var htmlToImage = {};' })));
    const result = checkInteractiveDocument(html, DEFAULT_INTERACTIVE_HOST_STATE.theme, new AbortController().signal, [], { screenshot: true });
    await vi.waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    const frame = document.querySelector('iframe')!;
    const channel = frame.srcdoc.match(/"channel":"(interactive-check-[^"]+)"/)![1];
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: {
      __scatterInteractive: channel, type: 'check-result', payload: { errors: ['Browser verification failed: the page became unavailable.'] },
    } }));
    const check = await result;
    expect(check.ok).toBe(false);
    expect(check.captureError).toContain('the page became unavailable');
    expect(check.captureError).not.toContain('No valid screenshot');
    expect(document.querySelector('iframe')).toBeNull();
  });
});
