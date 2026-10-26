/** Keep the complete toolbar on-screen as actions, zoom, and viewport change.
 * Runs imperatively so camera motion never causes a React render. */
export function positionSelectionToolbar(
  bar: HTMLElement,
  rect: Pick<DOMRect, 'left' | 'width' | 'top'>,
  zoom = 1,
): void {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  bar.style.setProperty('--sc-sel-zoom', String(scale));
  bar.style.maxWidth = `${Math.max(1, window.innerWidth - 16) / scale}px`;
  const halfWidth = bar.offsetWidth * scale / 2;
  const x = Math.max(8 + halfWidth, Math.min(rect.left + rect.width / 2, window.innerWidth - 8 - halfWidth));
  const y = Math.min(window.innerHeight - 8, Math.max(rect.top - 8, bar.offsetHeight * scale + 8));
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
}
