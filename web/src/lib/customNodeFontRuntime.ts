import { customFontFamily, fontFormat, MAX_CUSTOM_FONT_BYTES, type CustomNodeFont } from './customNodeFonts';

const registered = new Map<string, { data: string; face: FontFace }>();

/** Register once per file, not per node. URL-backed faces decode lazily: an
 * unselected font costs no layout work until its settings preview is visible. */
export function registerCustomNodeFonts(fonts: readonly CustomNodeFont[]): void {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts?.add) return;
  const wanted = new Map(fonts.map(font => [font.id, font]));
  for (const [id, current] of registered) {
    if (wanted.get(id)?.data !== current.data) {
      document.fonts.delete(current.face);
      registered.delete(id);
    }
  }
  for (const font of fonts) {
    const family = customFontFamily(font.id);
    if (!family || registered.has(font.id)) continue;
    const face = new FontFace(family, `url("data:font/${font.format};base64,${font.data}")`, { display: 'swap' });
    // CSS can trigger a load before explicit selection. Consume that rejection
    // here as well; the settings panel reports failures through loadCustomNodeFont.
    void face.loaded.catch(() => {});
    document.fonts.add(face);
    registered.set(font.id, { data: font.data, face });
  }
}

export async function loadCustomNodeFont(id: string): Promise<void> {
  const entry = registered.get(id);
  if (!entry) throw new Error('This custom font is unavailable. Upload it again or choose another font.');
  await entry.face.load();
}

/** Validate the actual file before changing any settings. No server request. */
export async function readCustomNodeFont(file: File): Promise<CustomNodeFont> {
  if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('Choose a TTF, OTF, WOFF, or WOFF2 font file.');
  if (file.size > MAX_CUSTOM_FONT_BYTES) throw new Error('Each font file must be 10 MB or smaller.');
  if (typeof FontFace === 'undefined') throw new Error('This browser cannot load custom fonts. Try a current browser.');
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const format = fontFormat(bytes);
  if (!format) throw new Error('This file is not a supported font, or its data is damaged.');
  try {
    await new FontFace('ScatterFontValidation', buffer).load();
  } catch {
    throw new Error('This font could not be loaded. It may be damaged or use an unsupported format.');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const id = `custom-font-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  // Avoid argument limits on multi-megabyte font files.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 80) || 'Custom font';
  return { id, name, fileName: file.name.slice(0, 180), format, data: btoa(binary), byteLength: bytes.length };
}
