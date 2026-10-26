import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { File } from 'node:buffer';
import { customFontFixture as font, fontBytes } from '@/test/customFontFixture';
import { loadCustomNodeFont, readCustomNodeFont, registerCustomNodeFonts } from './customNodeFontRuntime';
import { ensureReadingFontLoaded, fontFamilyFor } from './imageEditFonts';

const load = vi.fn(async () => undefined);
class FakeFontFace {
  loaded = Promise.resolve(this);
  load = load;
  constructor(public family: string, public source: string | ArrayBuffer) {}
}
const oldFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
const faces = { add: vi.fn(), delete: vi.fn(), load: vi.fn(async () => []) };
beforeEach(() => {
  vi.stubGlobal('FontFace', FakeFontFace);
  Object.defineProperty(document, 'fonts', { configurable: true, value: faces });
  load.mockResolvedValue(undefined);
});
afterEach(() => {
  registerCustomNodeFonts([]);
  vi.clearAllMocks(); vi.unstubAllGlobals();
  if (oldFonts) Object.defineProperty(document, 'fonts', oldFonts);
  else Reflect.deleteProperty(document, 'fonts');
});

describe('custom font loading', () => {
  it('validates a real font and embeds identical bytes with a stable content id', async () => {
    const result = await readCustomNodeFont(new File([fontBytes], 'My-Caveat.woff2') as unknown as globalThis.File);
    expect(result).toEqual({ ...font, name: 'My Caveat' });
    expect(load).toHaveBeenCalledOnce();
    expect(faces.add).not.toHaveBeenCalled();
  });
  it('rejects unsupported, oversized, and unparseable files before saving', async () => {
    await expect(readCustomNodeFont(new File(['hi'], 'hi.txt') as unknown as globalThis.File)).rejects.toThrow('TTF');
    await expect(readCustomNodeFont({ name: 'large.ttf', size: 11 * 1024 * 1024 } as globalThis.File)).rejects.toThrow('10 MB');
    await expect(readCustomNodeFont(new File(['not a font at all'], 'bad.ttf') as unknown as globalThis.File)).rejects.toThrow('damaged');
    load.mockRejectedValueOnce(new Error('Invalid font tables'));
    await expect(readCustomNodeFont(new File([fontBytes], 'bad.woff2') as unknown as globalThis.File)).rejects.toThrow('could not be loaded');
  });
  it('shares one lazy face across nodes, retains it on rename, and releases it on removal', async () => {
    registerCustomNodeFonts([font]);
    registerCustomNodeFonts([{ ...font, name: 'Renamed' }]);
    expect(faces.add).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    await loadCustomNodeFont(font.id);
    expect(fontFamilyFor(font.id)).toContain('ScatterCustomFont_');
    registerCustomNodeFonts([]);
    expect(faces.delete).toHaveBeenCalledOnce();
    await expect(loadCustomNodeFont(font.id)).rejects.toThrow('unavailable');
    // A removed/reimported id must not reuse the old reading-font promise.
    registerCustomNodeFonts([font]);
    await ensureReadingFontLoaded(font.id);
    expect(load).toHaveBeenCalledTimes(2);
  });
  it('replaces bytes changed by a restored snapshot and tolerates unsupported browsers', () => {
    registerCustomNodeFonts([font]);
    registerCustomNodeFonts([{ ...font, data: font.data + 'AAAA' }]);
    expect(faces.delete).toHaveBeenCalledOnce();
    expect(faces.add).toHaveBeenCalledTimes(2);
    vi.stubGlobal('FontFace', undefined);
    expect(() => registerCustomNodeFonts([font])).not.toThrow();
  });
});
