import { labelIsRTL, statusGlyphIndex, type FallbackTile } from '../labelGlyphs';

// Independent of DPR: nearest-neighbour sampling retains the wide pixel style.
// The largest page is 2048×2048, supported by every WebGL2 implementation.
export const LABEL_TILE = 16;
export const LABEL_COLUMNS = 128;
export const LABEL_INDEX_BASE = 256;
export function labelFont(run: string): string {
  const family = /\p{Script=Arabic}/u.test(run) ? 'Noto Sans Arabic'
    : /\p{Script=Devanagari}/u.test(run) ? 'Noto Sans Devanagari'
    : /\p{Script=Hangul}/u.test(run) ? 'Noto Sans KR'
    : /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run) ? 'Noto Sans JP'
    : /\p{Script=Han}/u.test(run) ? 'Noto Sans SC' : 'Scatter Label Pixel';
  // Mixed-script labels need the same bundled fallbacks, not whichever fonts
  // happen to be installed on the operating system.
  const families = [family];
  if (/\p{Script=Arabic}/u.test(run)) families.push('Noto Sans Arabic');
  if (/\p{Script=Devanagari}/u.test(run)) families.push('Noto Sans Devanagari');
  if (/\p{Script=Han}/u.test(run)) families.push('Noto Sans SC');
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) families.push('Noto Sans JP');
  if (/\p{Script=Hangul}/u.test(run)) families.push('Noto Sans KR');
  return `16px ${[...new Set(families)].map(name => `"${name}"`).join(', ')}, "Noto Sans", monospace`;
}

/** Paint the entire run before slicing: fillText supplies native shaping and bidi. */
export function paintLabelRun(run: string, width: number, font = labelFont(run)): HTMLCanvasElement | null {
  const strip = document.createElement('canvas');
  strip.width = width * LABEL_TILE;
  strip.height = LABEL_TILE;
  const ctx = strip.getContext('2d');
  if (!ctx) return null;
  ctx.font = font;
  ctx.direction = labelIsRTL(run) ? 'rtl' : 'ltr';
  ctx.textAlign = 'left';
  const m = ctx.measureText(run);
  const left = Math.max(0, m.actualBoundingBoxLeft);
  const advance = Math.max(1, m.width, m.actualBoundingBoxRight) + left;
  const ascent = Math.max(1, m.actualBoundingBoxAscent);
  const descent = Math.max(0, m.actualBoundingBoxDescent);
  const sx = (strip.width - 1) / advance;
  const sy = Math.min(1, (LABEL_TILE - 1) / (ascent + descent));
  ctx.scale(sx, sy);
  ctx.fillStyle = 'white';
  ctx.fillText(run, left + 0.5 / sx, (LABEL_TILE / sy - ascent - descent) / 2 + ascent);
  return strip;
}

/** Only instantiated for visible fallback text. Caches shaped runs, batches
 * texture uploads and recycles slots between frames, never during a draw. */
export class LabelAtlas {
  private runs = new Map<string, number>();
  private next = 0;
  private sheet?: HTMLCanvasElement;
  private rows = 0;
  private dirty = false;
  private invalid = false;
  private loads = new Set<string>();
  texture: WebGLTexture | null = null;
  constructor(private wake: () => void) {}

  beginFrame() {
    if (this.invalid) {
      this.runs.clear(); this.next = 0; this.invalid = false;
    }
  }
  index({run, width, tile}: FallbackTile): number {
    const cached = this.runs.get(run);
    if (cached !== undefined) return LABEL_INDEX_BASE + cached + tile;
    if (this.next + width > LABEL_COLUMNS ** 2) {
      this.invalid = true;
      return statusGlyphIndex('?')!;
    }
    const font = labelFont(run);
    if (document.fonts && !document.fonts.check(font, run) && !this.loads.has(run)) {
      this.loads.add(run);
      void document.fonts.load(font, run).then(() => { this.invalid = true; this.wake(); }, () => {}).finally(() => this.loads.delete(run));
    }
    const strip = paintLabelRun(run, width, font);
    if (!strip) return statusGlyphIndex('?')!;
    const requiredRows = Math.ceil((this.next + width) / LABEL_COLUMNS);
    if (requiredRows > this.rows) {
      const old = this.sheet;
      this.rows = 2 ** Math.ceil(Math.log2(requiredRows));
      this.sheet = document.createElement('canvas');
      this.sheet.width = LABEL_COLUMNS * LABEL_TILE; this.sheet.height = this.rows * LABEL_TILE;
      if (old) this.sheet.getContext('2d')?.drawImage(old, 0, 0);
    }
    const ctx = this.sheet!.getContext('2d');
    if (!ctx) return statusGlyphIndex('?')!;
    const start = this.next;
    for (let i = 0; i < width;) {
      const column = this.next % LABEL_COLUMNS, row = Math.floor(this.next / LABEL_COLUMNS);
      const n = Math.min(width - i, LABEL_COLUMNS - column), x = column * LABEL_TILE, y = row * LABEL_TILE;
      ctx.clearRect(x, y, n * LABEL_TILE, LABEL_TILE);
      ctx.drawImage(strip, i * LABEL_TILE, 0, n * LABEL_TILE, LABEL_TILE, x, y, n * LABEL_TILE, LABEL_TILE);
      i += n; this.next += n;
    }
    this.runs.set(run, start); this.dirty = true;
    return LABEL_INDEX_BASE + start + tile;
  }
  upload(gl: WebGL2RenderingContext) {
    if (!this.dirty || !this.sheet) return;
    this.texture ??= gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.sheet);
    this.dirty = false;
  }
}
