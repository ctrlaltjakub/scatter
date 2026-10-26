// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { GoogleSearchSuggestions, googleSuggestionsDocument } from './GoogleSearchSuggestions';
import { mergeGoogleSearchSuggestions } from '@/lib/googleSearchSuggestions';

describe('Google Search attribution', () => {
  it('isolates and sanitizes the provider widget while preserving its style and links', () => {
    const html = googleSuggestionsDocument('<style>.chip{color:red}</style><div><svg width="20" height="20"><path d="M0 0h20v20z" fill="#fff"/></svg><a href="https://google.com/search?q=test" onclick="alert(1)">Test</a><script>alert(1)</script><iframe src="https://evil.test"></iframe></div>');
    expect(html).toContain('.chip{color:red}');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('noopener noreferrer');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('width="20"');
    expect(html).toContain('d="M0 0h20v20z"');
    const { container } = render(<GoogleSearchSuggestions snippets={['<div>Google</div>']} />);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // No provider scripts survive. The one permitted script is our resize
    // reporter, authorized by a per-document CSP nonce, without origin access.
    expect(doc.scripts).toHaveLength(1);
    expect(doc.scripts[0]?.textContent).toContain('ResizeObserver');
    expect(html).toContain(`script-src 'nonce-${doc.scripts[0]?.nonce}'`);
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });
  it('puts the small app label outside the unchanged provider document', () => {
    const { container } = render(<GoogleSearchSuggestions snippets={['<div>Google</div>']} />);
    expect(screen.getByText('Searched:')).toHaveClass('google-search-suggestions-label');
    const frame = container.querySelector('iframe')!;
    expect(frame.srcdoc).not.toContain('Searched:');
    expect(frame.style.height).toBe('50px');
  });
  it('leaves paint space for the supplied outline without modifying it', () => {
    const providerStyle = '.container{border-radius:8px;box-shadow:0 0 0 1px #ffffff26}';
    const html = googleSuggestionsDocument(`<style>${providerStyle}</style><div class="container">Google</div>`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(html).toContain(providerStyle);
    expect((doc.body.firstElementChild as HTMLElement).style.padding).toBe('1px');
  });
  it('sets the inner document color scheme to the app theme', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(googleSuggestionsDocument('<div>Google</div>', theme)).toContain(`color-scheme:${theme}`);
    }
    const palettes = '<style>@media (prefers-color-scheme: dark) {.chip{color:white}} @media (prefers-color-scheme: light) {.chip{color:black}}</style><div>Google</div>';
    expect(googleSuggestionsDocument(palettes, 'dark')).toContain('@media all {.chip{color:white}} @media not all {.chip{color:black}}');
    expect(googleSuggestionsDocument(palettes, 'light')).toContain('@media not all {.chip{color:white}} @media all {.chip{color:black}}');
  });
  it('accepts bounded height reports only from its own frame', () => {
    const { container } = render(<GoogleSearchSuggestions snippets={['<div>Google</div>']} />);
    const frame = container.querySelector('iframe')!;
    const report = (height: number, source: Window | null = frame.contentWindow) => fireEvent(window,
      new MessageEvent('message', { source, data: { type: 'scatter:google-suggestions-size', height } }));
    report(100, window);
    report(100, null);
    expect(frame.style.height).toBe('50px');
    report(53.4);
    expect(frame.style.height).toBe('54px');
    report(NaN);
    report(-10);
    expect(frame.style.height).toBe('54px');
    report(5000);
    expect(frame.style.height).toBe('640px');
  });
  it('shows scroll feedback only during horizontal scrolling, without changing frame height', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<GoogleSearchSuggestions snippets={['<div>Google</div>']} />);
      const frame = container.querySelector('iframe')!;
      const data = { type: 'scatter:google-suggestions-scroll', left: 200, viewport: 300, width: 900, scrolling: true };
      fireEvent(window, new MessageEvent('message', { source: window, data }));
      expect(container.querySelector('.google-search-suggestions-scrollbar')).toBeNull();
      fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data }));
      const bar = container.querySelector<HTMLElement>('.google-search-suggestions-scrollbar')!;
      expect(bar).toHaveAttribute('data-visible', 'true');
      expect(parseFloat(bar.style.width)).toBeCloseTo(100 / 3);
      expect(parseFloat(bar.style.left)).toBeCloseTo(200 / 600 * (100 - 100 / 3));
      expect(frame.style.height).toBe('50px');
      act(() => vi.advanceTimersByTime(800));
      expect(bar).toHaveAttribute('data-visible', 'false');
      expect(frame.style.height).toBe('50px');
    } finally { vi.useRealTimers(); }
  });
  it('prepares hidden thumbs for hover and removes them when there is no overflow', () => {
    const { container } = render(<GoogleSearchSuggestions snippets={['<div>One</div>', '<div>Two</div>']} />);
    const frames = container.querySelectorAll('iframe');
    const report = (index: number, width: number) => fireEvent(window, new MessageEvent('message', {
      source: frames[index]!.contentWindow,
      data: { type: 'scatter:google-suggestions-scroll', left: 0, viewport: 300, width, scrolling: false },
    }));
    report(0, 600);
    report(1, 900);
    const bars = container.querySelectorAll('.google-search-suggestions-scrollbar');
    expect(bars).toHaveLength(2);
    bars.forEach(bar => expect(bar).toHaveAttribute('data-visible', 'false'));
    report(0, 300);
    expect(container.querySelectorAll('.google-search-suggestions-scrollbar')).toHaveLength(1);
    expect(frames[0]!.srcdoc).toContain('scrollbar-width:none!important;scrollbar-gutter:auto!important');
    expect(frames[0]!.srcdoc).toContain('::-webkit-scrollbar{display:none!important');
  });
  it('deduplicates widgets and bounds payloads without adding them to answer text', () => {
    expect(mergeGoogleSearchSuggestions(['one'], ['one', 'two'])).toEqual(['one', 'two']);
    expect(mergeGoogleSearchSuggestions(['x'.repeat(100001)])).toBeUndefined();
    expect(render(<GoogleSearchSuggestions />).container.querySelector('iframe')).toBeNull();
  });
});
