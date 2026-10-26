import { customFontFamily, isCustomFontId } from './customNodeFonts';
import { loadCustomNodeFont } from './customNodeFontRuntime';

/**
 * Font registry for image-editor annotations and node reading text.
 *
 * Canvas text can't use CSS variables, so every font resolves to a concrete
 * family string before drawing. The app's default (Atkinson Hyperlegible via
 * next/font) has an obfuscated family name — it must be read from the
 * document at runtime, never hardcoded. The downloadable choices are self-hosted
 * font families whose woff2 subsets lazy-download on
 * first use; `ensureFontLoaded` forces that download to finish before the
 * canvas measures or bakes text.
 */

export interface AnnotationFont {
  id: string;
  /** Display name (the actual font name — no aliases). */
  label: string;
  /** One-line hint on what makes this font special (dropdown second line). */
  description: string;
  /** CSS family for canvas use; empty string = resolve the app font at runtime. */
  family: string;
}

export const APP_FONT_ID = 'app';

const app: AnnotationFont = { id: APP_FONT_ID, label: 'Atkinson Hyperlegible', description: 'The app’s font — built for maximum legibility', family: '' };
const noto: AnnotationFont = { id: 'noto-sans', label: 'Noto Sans', description: 'Neutral all-rounder, widest language coverage', family: '"Noto Sans", sans-serif' };
const playfair: AnnotationFont = { id: 'playfair', label: 'Playfair Display', description: 'Elegant high-contrast serif, great for titles', family: '"Playfair Display", serif' };
const caveat: AnnotationFont = { id: 'caveat', label: 'Caveat', description: 'Casual handwriting', family: '"Caveat", cursive' };
const dyslexic: AnnotationFont = { id: 'opendyslexic', label: 'OpenDyslexic', description: 'Weighted letterforms, easier with dyslexia', family: '"OpenDyslexic", sans-serif' };
const pixel: AnnotationFont = { id: 'press-start', label: 'Press Start 2P', description: 'The pixel font from the canvas background', family: '"Press Start 2P", monospace' };

/** Measured CSS ex-height of the bundled Atkinson Latin regular face at 100px.
 * CSS font-size-adjust uses this ratio for node text; image-editor canvas text
 * uses the same reference through adjustedCanvasFontSize below. */
export const APP_FONT_EX_HEIGHT_RATIO = 0.496;

/** Keep the image editor's established six choices and order unchanged. */
export const ANNOTATION_FONTS: AnnotationFont[] = [
  app, noto, playfair, caveat, dyslexic, pixel,
];

/** Node-only reading choices: accessibility and special faces first, then A–Z. */
export const NODE_TEXT_FONTS: AnnotationFont[] = [
  { ...app, description: 'Default — the app’s highly legible font' },
  dyslexic,
  { id: 'monospace', label: 'Monospace', description: 'Evenly spaced letters, useful for code', family: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: 'arial', label: 'Arial', description: 'Familiar, compact sans serif', family: 'Arial, Helvetica, sans-serif' },
  caveat,
  { id: 'comic-sans', label: 'Comic Sans MS', description: 'Playful lettering; Comic Neue if unavailable', family: '"Comic Sans MS", "Comic Neue", cursive' },
  { id: 'georgia', label: 'Georgia', description: 'Classic screen-friendly serif', family: 'Georgia, "Times New Roman", serif' },
  { id: 'inter', label: 'Inter', description: 'Clear modern interface font', family: 'Inter, sans-serif' },
  { id: 'lato', label: 'Lato', description: 'Warm, readable sans serif', family: 'Lato, sans-serif' },
  { id: 'merriweather', label: 'Merriweather', description: 'Comfortable serif for longer reading', family: 'Merriweather, Georgia, serif' },
  noto,
  { id: 'open-sans', label: 'Open Sans', description: 'Open shapes for everyday reading', family: '"Open Sans", sans-serif' },
  playfair,
  { id: 'roboto', label: 'Roboto', description: 'Versatile modern sans serif', family: 'Roboto, sans-serif' },
  { id: 'times-new-roman', label: 'Times New Roman', description: 'Traditional book and document serif', family: '"Times New Roman", Times, serif' },
  { id: 'verdana', label: 'Verdana', description: 'Wide, clear letters for screens', family: 'Verdana, Geneva, sans-serif' },
];

/** Unknown/obsolete settings values must never become arbitrary CSS. */
export function isKnownFontId(id: unknown): id is string {
  return typeof id === 'string' && NODE_TEXT_FONTS.some((font) => font.id === id);
}

/**
 * Text-size presets in IMAGE pixels. The UI shows them ÷10 (a "10" writes
 * 100-pixel letters) so the numbers stay small and readable.
 */
export const TEXT_SIZE_OPTIONS_PX: readonly number[] = [
  20, 30, 40, 50, 60, 80, 100, 120, 160, 200, 250, 320, 400,
];

/** Display form of a text size (image px ÷ 10, trimmed). */
export function textSizeLabel(px: number): string {
  const v = px / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Snap an arbitrary pixel size to the nearest preset. */
export function nearestTextSizePx(px: number): number {
  let best = TEXT_SIZE_OPTIONS_PX[0]!;
  for (const opt of TEXT_SIZE_OPTIONS_PX) {
    if (Math.abs(opt - px) < Math.abs(best - px)) best = opt;
  }
  return best;
}

/** The app's UI font stack, usable by the image-editor canvas. */
export function resolveAppFontFamily(): string {
  if (typeof document === 'undefined' || !document.body) return 'sans-serif';
  const fam = getComputedStyle(document.body).fontFamily;
  return fam || 'sans-serif';
}

/** Concrete canvas-ready family for a registry id (unknown ids → app font). */
export function fontFamilyFor(id: string): string {
  const customFamily = customFontFamily(id);
  if (customFamily) return `"${customFamily}", ${resolveAppFontFamily()}`;
  // Image-editor-only faces (notably Press Start 2P) still need to resolve
  // even when they are deliberately absent from the node-reading menu.
  const entry = NODE_TEXT_FONTS.find((f) => f.id === id)
    ?? ANNOTATION_FONTS.find((f) => f.id === id);
  if (!entry || entry.id === APP_FONT_ID || !entry.family) return resolveAppFontFamily();
  return entry.family;
}

// Konva paints into <canvas>, where CSS font-size-adjust has no effect. Measure
// the selected family with CSS's 1ex metric so its annotation pixels match the
// same lowercase-height reference as node reading text. The family may resolve
// to a different installed fallback on each device, so a static per-id scale
// would be wrong. Measure only after a font-load promise resolves: canvas
// rendering can then read the cached ratio without mutating DOM during React
// render or forcing layout on every text element.
const canvasExHeight = new Map<string, number>();

export function adjustedCanvasFontSize(fontSize: number, family: string): number {
  if (!Number.isFinite(fontSize)) return fontSize;
  const appFamily = resolveAppFontFamily();
  if (family === appFamily) return fontSize;
  const ex = canvasExHeight.get(family);
  return ex !== undefined && Number.isFinite(ex) && ex > 0
    ? fontSize * (APP_FONT_EX_HEIGHT_RATIO * 100 / ex)
    : fontSize;
}

function measureCanvasExHeight(family: string): void {
  if (!document.body) return;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font-size:100px;';
  probe.style.fontFamily = family;
  const unit = document.createElement('span');
  unit.style.cssText = 'display:block;height:1ex;width:1ex;';
  probe.append(unit);
  document.body.append(probe);
  const ex = unit.getBoundingClientRect().height;
  probe.remove();
  if (Number.isFinite(ex) && ex > 0) canvasExHeight.set(family, ex);
}

/**
 * Make sure a family's glyphs (for the given text) are downloaded and ready,
 * so canvas measurement/baking doesn't fall back to a substitute font.
 * Best-effort: resolves quietly where the Font Loading API is unavailable.
 */
export async function ensureFontLoaded(family: string, text?: string): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.all([
      document.fonts.load(`400 24px ${family}`, 'x'),
      ...(text && text.trim() && text !== 'x' ? [document.fonts.load(`400 24px ${family}`, text)] : []),
    ]);
  } catch {
    // Non-fatal — the browser falls back; baking still succeeds.
  } finally {
    // Every call loads Latin "x" first. Once measured, subsequent annotations
    // in this same family can reuse the metric without repeated forced layout.
    if (!canvasExHeight.has(family)) measureCanvasExHeight(family);
  }
}

const readingFontLoads = new Map<string, Promise<void>>();

/** Share the 400/700 download between every node in a large project. */
export function ensureReadingFontLoaded(id: string): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve();
  // The FontFace owns its promise. Never retain stale loads after a font is
  // removed/reimported, including a settings snapshot with the same id.
  if (isCustomFontId(id)) return loadCustomNodeFont(id).catch(() => {});
  const existing = readingFontLoads.get(id);
  if (existing) return existing;
  const family = fontFamilyFor(id);
  const loading = Promise.all([
    document.fonts.load(`400 14px ${family}`),
    document.fonts.load(`700 14px ${family}`),
  ]).then(() => undefined).catch(() => {
    readingFontLoads.delete(id);
  });
  readingFontLoads.set(id, loading);
  return loading;
}
