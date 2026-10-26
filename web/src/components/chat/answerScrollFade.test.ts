import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAnswerScrollFade } from './answerScrollFade';

let viewport: HTMLDivElement;
let resize: () => void;
let dispose: (() => void) | undefined;
const disconnect = vi.fn();
const observe = vi.fn();
beforeEach(() => {
  disconnect.mockClear(); observe.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  viewport = document.createElement('div');
  viewport.append(document.createElement('article'));
  Object.defineProperties(viewport, {
    clientHeight: { value: 400, writable: true },
    scrollHeight: { value: 1600, writable: true },
  });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });
const fades = () => [viewport.style.getPropertyValue('--answer-fade-top'), viewport.style.getPropertyValue('--answer-fade-bottom')];
const scrollTo = (top: number) => { viewport.scrollTop = top; viewport.dispatchEvent(new Event('scroll')); };

describe('native answer edge fading', () => {
  it('fades only the overflowing edges at the start, middle, and end', () => {
    dispose = attachAnswerScrollFade(viewport);
    expect(fades()).toEqual(['0px', '32px']);
    scrollTo(600);
    expect(fades()).toEqual(['32px', '32px']);
    scrollTo(1200);
    expect(fades()).toEqual(['32px', '0px']);
    expect(viewport.dataset.readingInsetTop).toBe('32');
    expect(viewport.dataset.readingInsetBottom).toBe('0');
  });
  it('progressively removes the fade as the edge comes into view', () => {
    dispose = attachAnswerScrollFade(viewport);
    scrollTo(12);
    expect(fades()).toEqual(['12px', '32px']);
    scrollTo(1191);
    expect(fades()).toEqual(['32px', '9px']);
  });
  it('shows no fade when all content fits and responds to content or viewport resizing', () => {
    Object.defineProperty(viewport, 'scrollHeight', { value: 300, writable: true });
    dispose = attachAnswerScrollFade(viewport);
    expect(fades()).toEqual(['0px', '0px']);
    Object.defineProperty(viewport, 'scrollHeight', { value: 1000, writable: true });
    resize();
    expect(fades()).toEqual(['0px', '32px']);
    Object.defineProperty(viewport, 'clientHeight', { value: 100, writable: true });
    resize();
    expect(fades()).toEqual(['0px', '20px']);
    expect(observe).toHaveBeenCalledWith(viewport);
    expect(observe).toHaveBeenCalledWith(viewport.firstElementChild);
  });
  it('initializes an already restored scroll position without modifying text layout', () => {
    viewport.scrollTop = 600;
    viewport.firstElementChild!.textContent = 'Native, selectable text';
    const original = viewport.innerHTML;
    dispose = attachAnswerScrollFade(viewport);
    expect(fades()).toEqual(['32px', '32px']);
    expect(viewport.innerHTML).toBe(original);
    expect(viewport.style.fontSize).toBe('');
    expect(viewport.style.lineHeight).toBe('');
    expect(viewport.style.transform).toBe('');
    expect(viewport.style.clipPath).toBe('');
  });
  it('cleans up observers, scrolling handlers, and reading insets', () => {
    dispose = attachAnswerScrollFade(viewport);
    dispose(); dispose = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
    scrollTo(600);
    expect(fades()).toEqual(['', '']);
    expect(viewport.dataset.readingInsetTop).toBeUndefined();
    expect(viewport.dataset.readingInsetBottom).toBeUndefined();
  });
});
