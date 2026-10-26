/** Measure a document's natural content without the host's viewport-height
 * floor. Only used inside invisible verification frames, never in live nodes.
 * Self-contained because buildInteractiveSrcDoc serializes it into the frame. */
export function measureInteractiveContent(): { width: number; height: number } | undefined {
  const body = document.body;
  if (!body) return;
  const roots = [document.documentElement, body];
  // A HiDPI canvas can have a large backing buffer but a percentage CSS height.
  // Preserve its painted size while temporarily releasing the body's height;
  // otherwise measurement mistakes the backing pixels for useful content.
  const surfaces = Array.from(body.querySelectorAll<HTMLElement | SVGSVGElement>('canvas,svg,img,video'))
    .map(element => ({ element, height: getComputedStyle(element).height, rect: element.getBoundingClientRect() }))
    .filter(({ height, rect }) => parseFloat(height) > 0 && rect.width > 0 && rect.height > 0);
  const changed = [...roots, ...surfaces.map(surface => surface.element)];
  const styles = changed.map(element => element.getAttribute('style'));
  try {
    for (const element of roots) {
      element.style.setProperty('height', 'auto', 'important');
      element.style.setProperty('min-height', '0', 'important');
      element.style.setProperty('max-height', 'none', 'important');
    }
    for (const { element, height } of surfaces) element.style.setProperty('height', height, 'important');
    let left = Infinity, right = -Infinity, bottom = -Infinity, top = Infinity;
    const include = (rect: { left: number; right: number; top: number; bottom: number }) => {
      if (rect.right <= rect.left || rect.bottom <= rect.top) return;
      left = Math.min(left, rect.left); right = Math.max(right, rect.right);
      top = Math.min(top, rect.top); bottom = Math.max(bottom, rect.bottom);
    };
    for (const element of body.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      const box = element.getBoundingClientRect();
      const rect = { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      // Scrollable surfaces and deliberately clipped decoration keep their
      // visible bounds, rather than exposing their entire hidden contents.
      for (let ancestor = element.parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
        const parentStyle = getComputedStyle(ancestor), parentRect = ancestor.getBoundingClientRect();
        if (parentStyle.overflowX !== 'visible') {
          rect.left = Math.max(rect.left, parentRect.left); rect.right = Math.min(rect.right, parentRect.right);
        }
        if (parentStyle.overflowY !== 'visible') {
          rect.top = Math.max(rect.top, parentRect.top); rect.bottom = Math.min(rect.bottom, parentRect.bottom);
        }
      }
      include(rect);
    }
    for (const child of body.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      const range = document.createRange(); range.selectNode(child); include(range.getBoundingClientRect());
    }
    // A centered absolute layout can depend on a definite body height. Keep
    // its declared surface if removing that height makes its contents negative.
    if (!Number.isFinite(left) || left < -2 || top < -2) return;
    const bodyStyle = getComputedStyle(body), bodyRect = body.getBoundingClientRect();
    const px = (property: string) => parseFloat(bodyStyle.getPropertyValue(property)) || 0;
    return {
      width: Math.ceil(right - left + px('padding-left') + px('padding-right')
        + px('border-left-width') + px('border-right-width') + px('margin-left') + px('margin-right')),
      height: Math.ceil(Math.max(bodyRect.bottom, bottom + px('padding-bottom') + px('border-bottom-width')) + px('margin-bottom')),
    };
  } finally {
    changed.forEach((element, index) => {
      const previous = styles[index];
      if (previous == null) element.removeAttribute('style'); else element.setAttribute('style', previous);
    });
  }
}
