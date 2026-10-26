/** Operates only on the serialized clone. Firefox omits native checkbox/radio
 * painting inside SVG images. Vector equivalents preserve the live state at
 * any export density without modifying the visible app or custom controls. */
export function normalizeScreenshotControls(root: ParentNode): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"],input[type="radio"]')) {
    if (input.style.getPropertyValue('appearance') === 'none') continue;
    const radio = input.type === 'radio';
    const mixed = input.hasAttribute('data-sc-capture-mixed');
    const checked = mixed || input.hasAttribute('checked');
    const accent = input.style.getPropertyValue('accent-color');
    const fill = checked ? (accent && accent !== 'auto' ? accent : '#1675e0') : '#fff';
    const mark = !checked ? '' : mixed
      ? '<path d="M5 10H15" stroke="white" stroke-width="2.4"/>'
      : radio ? '<circle cx="10" cy="10" r="4" fill="white"/>'
        : '<path d="M5 10L8.5 13.5L15 6.5" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>';
    const graphic = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect x="1" y="1" width="18" height="18" rx="${radio ? 9 : 3}" fill="${fill.replace(/["<>]/g, '')}" stroke="${checked ? fill.replace(/["<>]/g, '') : '#818181'}" stroke-width="1.4"/>${mark}</svg>`;
    // Inline SVG also avoids Firefox's restrictions on nested SVG image URLs.
    const parsed = new DOMParser().parseFromString(graphic, 'image/svg+xml').documentElement;
    const image = input.ownerDocument.importNode(parsed, true) as unknown as SVGSVGElement;
    for (const attribute of Array.from(input.attributes)) if (['style', 'class', 'id'].includes(attribute.name)) image.setAttribute(attribute.name, attribute.value);
    const style = image.style;
    style.setProperty('appearance', 'none'); style.setProperty('border', '0');
    style.setProperty('background', 'transparent'); style.setProperty('padding', '0');
    style.setProperty('object-fit', 'contain');
    input.replaceWith(image);
  }
}

/** Self-contained so the same rasterizer can run inside an opaque sandbox. */
export async function rasterizeScreenshotSvg(dataUrl: string, pixelRatio: number, normalize: (root: ParentNode) => void, maxDataUrlLength = Infinity): Promise<string> {
  const svg = new DOMParser().parseFromString(decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1)), 'image/svg+xml');
  if (svg.querySelector('parsererror')) throw new Error('The browser could not serialize this view.');
  normalize(svg);
  const root = svg.documentElement;
  const width = Math.round(Number(root.getAttribute('width')) * pixelRatio);
  const height = Math.round(Number(root.getAttribute('height')) * pixelRatio);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('The screenshot dimensions are invalid. Return to this tab and retry verification.');
  }
  root.setAttribute('viewBox', `0 0 ${root.getAttribute('width')} ${root.getAttribute('height')}`);
  root.setAttribute('width', String(width)); root.setAttribute('height', String(height));
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The screenshot canvas could not be created.');
  context.drawImage(image, 0, 0);
  const png = canvas.toDataURL('image/png');
  if (!png.startsWith('data:image/png;base64,')) throw new Error(`The browser returned no usable screenshot (${width}×${height}). Return to this tab and retry verification.`);
  if (png.length <= maxDataUrlLength) return png;
  // Only model-review captures set a payload budget. Preserve every pixel of
  // geometry; photographic/noisy canvases compress much better as JPEG. User
  // promotional exports keep the default lossless PNG path.
  for (const quality of [0.92, 0.85, 0.75]) {
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    if (jpeg.startsWith('data:image/jpeg;base64,') && jpeg.length <= maxDataUrlLength) return jpeg;
  }
  throw new Error('The review image exceeds the capture payload limit even after compression. Simplify large photographic or noise textures, then run another pass.');
}
