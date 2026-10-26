/** Portable font files, embedded in app settings rather than device-local URLs. */
export interface CustomNodeFont {
  id: string;
  name: string;
  fileName: string;
  format: 'ttf' | 'otf' | 'woff' | 'woff2';
  /** Base64 file bytes. Never a URL or user-supplied CSS. */
  data: string;
  byteLength: number;
}

export const MAX_CUSTOM_FONT_BYTES = 10 * 1024 * 1024;
export const MAX_CUSTOM_FONTS_BYTES = 20 * 1024 * 1024;
export const MAX_CUSTOM_FONTS = 20;
export const CUSTOM_FONT_ACCEPT = '.ttf,.otf,.woff,.woff2';

export function isCustomFontId(id: unknown): id is string {
  return typeof id === 'string' && /^custom-font-[a-f0-9]{64}$/.test(id);
}

export function customFontFamily(id: string): string | null {
  return isCustomFontId(id) ? `ScatterCustomFont_${id.slice(12)}` : null;
}

export function fontFormat(bytes: Uint8Array): CustomNodeFont['format'] | null {
  if (bytes.length < 12) return null;
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  if (signature === 'wOF2') return 'woff2';
  if (signature === 'wOFF') return 'woff';
  if (signature === 'OTTO') return 'otf';
  if (signature === '\x00\x01\x00\x00' || signature === 'true') return 'ttf';
  return null;
}

export function fontByteLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Cheap bounded validation on restore. The browser validates actual font
 * tables when the face is loaded; malformed faces never break other settings. */
export function normalizeCustomNodeFonts(raw: unknown): CustomNodeFont[] {
  if (!Array.isArray(raw)) return [];
  const fonts: CustomNodeFont[] = [];
  const ids = new Set<string>();
  const dataSeen = new Set<string>();
  let total = 0;
  for (const item of raw.slice(0, MAX_CUSTOM_FONTS)) {
    if (!item || typeof item !== 'object') continue;
    const font = item as Partial<CustomNodeFont>;
    if (!isCustomFontId(font.id) || ids.has(font.id) || typeof font.data !== 'string'
      || font.data.length < 16 || font.data.length > Math.ceil(MAX_CUSTOM_FONT_BYTES / 3) * 4
      || font.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(font.data)
      || dataSeen.has(font.data)) continue;
    const byteLength = font.data.length / 4 * 3 - (font.data.endsWith('==') ? 2 : font.data.endsWith('=') ? 1 : 0);
    if (byteLength > MAX_CUSTOM_FONT_BYTES || total + byteLength > MAX_CUSTOM_FONTS_BYTES) continue;
    const header = Uint8Array.from(atob(font.data.slice(0, 16)), char => char.charCodeAt(0));
    const format = fontFormat(header);
    if (!format || typeof font.name !== 'string' || !font.name.trim()) continue;
    const name = font.name.trim().slice(0, 80);
    fonts.push({ id: font.id, name, format, data: font.data, byteLength,
      fileName: typeof font.fileName === 'string' ? font.fileName.slice(0, 180) : `${name}.${format}` });
    ids.add(font.id);
    dataSeen.add(font.data);
    total += byteLength;
  }
  return fonts;
}

/** Used again at commit time: a cloud update may arrive while a file loads. */
export function appendCustomNodeFont(fonts: CustomNodeFont[], font: CustomNodeFont): CustomNodeFont[] {
  if (fonts.some(existing => existing.id === font.id || existing.data === font.data)) return fonts;
  if (fonts.length >= MAX_CUSTOM_FONTS) throw new Error('You can add up to 20 custom fonts. Remove one before adding another.');
  if (font.byteLength > MAX_CUSTOM_FONT_BYTES) throw new Error('Each font file must be 10 MB or smaller.');
  if (fonts.reduce((bytes, existing) => bytes + existing.byteLength, font.byteLength) > MAX_CUSTOM_FONTS_BYTES) {
    throw new Error('Custom fonts are limited to 20 MB in total to keep settings exports and sync manageable.');
  }
  return [...fonts, font];
}
