import { describe, expect, it } from 'vitest';
import {
  buildInteractiveSrcDoc,
  DEFAULT_INTERACTIVE_HOST_STATE,
  formatInteractiveError,
  INTERACTIVE_VIEWPORT_HEIGHT,
  INTERACTIVE_VIEWPORT_WIDTH,
  LEGACY_INTERACTIVE_VIEWPORT_SIZE,
  resolveInteractiveViewport,
  preferredInteractiveViewport,
  interactiveDisplaySize,
  validateInteractiveDocument,
} from './interactiveDocument';

const VALID = '<!doctype html><html><head></head><body><button>Try it</button><script>document.body.dataset.ready="yes"</script></body></html>';

describe('interactive document isolation', () => {
  it('accepts a complete self-contained document and strips a markdown fence', () => {
    expect(validateInteractiveDocument(`\`\`\`html\n${VALID}\n\`\`\``)).toBe(VALID);
  });

  it.each([
    ['external script', '<!doctype html><html><body><script src="https://example.com/a.js"></script></body></html>'],
    ['network call', '<!doctype html><html><body><script>fetch("/secret")</script></body></html>'],
    ['storage', '<!doctype html><html><body><script>localStorage.x=1</script></body></html>'],
    ['navigation', '<!doctype html><html><body><script>location.href="/other"</script></body></html>'],
    ['blocking loop', '<!doctype html><html><body><script>while(true){}</script></body></html>'],
  ])('rejects %s', (_name, document) => {
    expect(() => validateInteractiveDocument(document)).toThrow();
  });

  it('injects flexible viewport, CSP, and separate layout/runtime channels before model code', () => {
    const srcDoc = buildInteractiveSrcDoc(VALID, 'channel-1');
    expect(srcDoc).toContain('width:100%;height:100%');
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain('__scatterInteractive');
    expect(srcDoc).toContain('channel-1');
    expect(srcDoc).toContain("'--sc-primary':theme.primary");
    expect(srcDoc).toContain('function pauseRuntime()');
    expect(srcDoc).toContain('function unlockAudioContexts()');
    expect(srcDoc).toContain("['click','pointerdown','pointerup','touchend','keydown']");
    expect(srcDoc).toContain("if(context.state==='suspended')context.resume()");
    expect(srcDoc).toContain('navigator.userActivation.isActive');
    expect(srcDoc).toContain("if(event.key!=='Escape')return");
    expect(srcDoc).toContain("send('escape')");
    expect(srcDoc).toContain('function reportLayoutOverflow()');
    expect(srcDoc).toContain("send('layout'");
    expect(srcDoc).toContain('nativeSetTimeout(reportLayoutOverflow,600)');
    expect(srcDoc).toContain("message.type!=='host-state'");
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('dataset.ready'));
  });

  it('retains a legacy square viewport without migrating it', () => {
    const viewport = resolveInteractiveViewport({ viewportSize: LEGACY_INTERACTIVE_VIEWPORT_SIZE });
    expect(viewport).toEqual({
      width: LEGACY_INTERACTIVE_VIEWPORT_SIZE,
      height: LEGACY_INTERACTIVE_VIEWPORT_SIZE,
    });
    const srcDoc = buildInteractiveSrcDoc(VALID, 'legacy', undefined, viewport);
    expect(srcDoc).toContain('width:100%;height:100%');
  });

  it('accepts bounded landscape, portrait and square preferences without changing legacy sizing', () => {
    expect(preferredInteractiveViewport('')).toEqual({ width: 960, height: 720 });
    expect(preferredInteractiveViewport('<meta name="scatter-viewport" content="width=720,height=960">')).toEqual({ width: 720, height: 960 });
    expect(preferredInteractiveViewport('<meta name="scatter-viewport" content="width=99999,height=1">')).toEqual({ width: 1600, height: 480 });
    expect(interactiveDisplaySize({ viewportWidth: 720, viewportHeight: 960 })).toEqual({ width: 573, height: 764 });
    expect(interactiveDisplaySize()).toEqual({ width: 764, height: 573 });
  });

  it('can require the core Scatter design tokens for newly generated programs', () => {
    expect(() => validateInteractiveDocument(VALID, { requireDesignTokens: true }))
      .toThrow(/--sc-bg/);
    const commentsOnly = VALID.replace('<body>', '<body><!-- --sc-bg --sc-text --sc-primary -->');
    expect(() => validateInteractiveDocument(commentsOnly, { requireDesignTokens: true }))
      .toThrow(/--sc-bg/);
    const themed = VALID.replace('<body>', '<body style="background:var(--sc-bg);color:var(--sc-text);border-color:var(--sc-primary)">');
    expect(validateInteractiveDocument(themed, { requireDesignTokens: true })).toBe(themed);
  });

  it('keeps the exact runtime location and stack in repair feedback', () => {
    expect(formatInteractiveError({
      message: 'oscillator is undefined',
      source: 'about:srcdoc',
      line: 42,
      column: 7,
      stack: 'stack detail',
    })).toContain('about:srcdoc:42:7\nStack:\nstack detail');
  });

  it('shares only presentation tokens and custom cursors with the sandbox', () => {
    const doc = buildInteractiveSrcDoc(VALID, 'theme', {
      active: true,
      theme: { ...DEFAULT_INTERACTIVE_HOST_STATE.theme, cursors: { click: 'url("data:image/svg+xml,test") 3 3, pointer' } },
    });
    expect(doc).toContain("'--sc-cursor-'");
    expect(doc).toContain('var(--sc-cursor-click,pointer)');
    expect(doc).toContain('event.source!==parent');
    expect(doc).toContain("'scatter:check-layout'");
  });
});
