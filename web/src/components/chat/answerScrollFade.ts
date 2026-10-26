const MAX_FADE_PX = 32;

/** Fade native text without changing its layout or duplicating selectable content. */
export function attachAnswerScrollFade(viewport: HTMLElement): () => void {
  const update = () => {
    const extent = Math.min(MAX_FADE_PX, viewport.clientHeight / 5);
    const remaining = viewport.scrollHeight - viewport.clientHeight;
    const top = Math.min(extent, Math.max(0, viewport.scrollTop));
    const bottom = Math.min(extent, Math.max(0, remaining - viewport.scrollTop));
    viewport.style.setProperty('--answer-fade-top', `${top}px`);
    viewport.style.setProperty('--answer-fade-bottom', `${bottom}px`);
    // Keep keyboard reading in the fully opaque part of the viewport.
    viewport.dataset.readingInsetTop = String(top);
    viewport.dataset.readingInsetBottom = String(bottom);
  };
  const observer = new ResizeObserver(update);
  observer.observe(viewport);
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
  viewport.addEventListener('scroll', update, { passive: true });
  update();
  return () => {
    observer.disconnect();
    viewport.removeEventListener('scroll', update);
    viewport.style.removeProperty('--answer-fade-top');
    viewport.style.removeProperty('--answer-fade-bottom');
    delete viewport.dataset.readingInsetTop;
    delete viewport.dataset.readingInsetBottom;
  };
}
