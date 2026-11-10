import { RAMP_FLAT } from './ramp';

export const STATUS_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:-.,'()/&?!~+_\\|";
export function statusGlyphIndex(ch: string): number | null {
  const i = ch.length === 1 ? STATUS_CHARS.indexOf(ch) : -1;
  return i < 0 ? null : RAMP_FLAT.length + i;
}

export interface FallbackTile { run: string; width: number; tile: number }
export interface LabelInk { glyphIndex: number; fallback?: FallbackTile }
interface Letter extends LabelInk { offset: number }
const plain = /^[\x20-\x7e]*$/;
const rtlScript = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const rtlFirst = /^[^\p{Letter}]*[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null;
export function labelClusters(text: string): string[] {
  if (plain.test(text)) return text.split('');
  const normalized = text.normalize('NFC');
  return segmenter ? Array.from(segmenter.segment(normalized), s => s.segment)
    : normalized.match(/\P{Mark}\p{Mark}*|\p{Mark}+/gu) ?? [];
}
const cache = new Map<string, {width: number; letters: Letter[]}>();
export function labelWidth(text: string): number {
  return plain.test(text) ? text.length : labelLine(text).width;
}
/** Cells are in reading order, offsets in screen order. Shaped lines are sliced
 * after browser text layout: Arabic joins, bidi runs and Indic clusters survive. */
export function labelLine(text: string) {
  const saved = cache.get(text);
  if (saved) return saved;
  const chars = labelClusters(text);
  const letters: Letter[] = [];
  const shaped = rtlScript.test(text) || /\p{Script=Devanagari}/u.test(text);
  const rtl = rtlFirst.test(text);
  const run = chars.join('');
  for (let i = 0; i < chars.length; i++) {
    const offset = rtl ? chars.length - i - 1 : i;
    const char = chars[offset]!;
    // In a bidi run the browser positions the spaces; they are transparent ink.
    if (!shaped && /^[\s\p{Control}\p{Format}]+$/u.test(char)) continue;
    const index = shaped ? null : statusGlyphIndex(char);
    letters.push(index !== null ? {offset, glyphIndex: index} : {offset, glyphIndex: 255,
      fallback: shaped ? {run, width: chars.length, tile: offset} : {run: char, width: 1, tile: 0}});
  }
  const line = {width: chars.length, letters};
  if (cache.size >= 768) cache.delete(cache.keys().next().value!);
  cache.set(text, line);
  return line;
}
export function labelIsRTL(run: string) { return rtlFirst.test(run); }
