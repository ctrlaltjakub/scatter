import { inlineEmphasis, sliceWithInlineEmphasis } from './inlineEmphasis';

/** A level-2 child as parsed out of `name: description` markdown. */
export interface BulletChild {
  name: string;
  desc: string;
}

/** A level-1 bullet with its level-2 children. */
export interface Bullet {
  title: string;
  children: BulletChild[];
}

/** A parsed node body: opening free text + a structured 2-level bullet list. */
export interface ParsedBody {
  freeText: string;
  bullets: Bullet[];
}

const BULLET_RE = /^(\s*)([\-*+])\s+(.+)$/;
const ANY_BULLET_RE = /^\s*[\-*+]\s/;

function bulletEq(a: Bullet, b: Bullet): boolean {
  if (a.title !== b.title || a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const ca = a.children[i]!;
    const cb = b.children[i]!;
    if (ca.name !== cb.name || ca.desc !== cb.desc) return false;
  }
  return true;
}

/**
 * Re-use object identities from a PREVIOUS parse for every bullet whose
 * content is unchanged in `next`. parseBody mints all-new objects on every
 * call, so during a streaming pass ("words turn into chips") each frame's
 * re-parse would otherwise hand React an entirely new bullets array —
 * invalidating every per-bullet memo even though only the bullet at the
 * reveal boundary actually changed. Stable identities let React bail out of
 * the untouched bullets (visible list AND the hidden measurement labs).
 *
 * Identity rules (value-equality drives reuse, position-wise):
 *   - bullet i unchanged (title + all children) → previous object reused
 *   - all bullets unchanged → the previous bullets ARRAY is reused
 *   - everything (incl. freeText) unchanged → `prev` itself is returned
 */
export function stabilizeParsed(prev: ParsedBody | null, next: ParsedBody | null): ParsedBody | null {
  if (!prev || !next) return next;
  let bulletsAllSame = prev.bullets.length === next.bullets.length;
  const bullets = next.bullets.map((nb, i) => {
    const pb = prev.bullets[i];
    if (pb && bulletEq(pb, nb)) return pb;
    bulletsAllSame = false;
    return nb;
  });
  if (bulletsAllSame) {
    if (prev.freeText === next.freeText) return prev;
    return { freeText: next.freeText, bullets: prev.bullets };
  }
  return { freeText: next.freeText, bullets };
}

/**
 * Find the index of the `name: description` separator colon, skipping any
 * colon that lives INSIDE a `[[chip]]` span. Without this, a bullet like
 * `[[2001: A Space Odyssey]]: a film` would split on the colon inside `2001:`,
 * tearing the chip in half so it never renders as a chip (both halves leak
 * stray brackets). Returns -1 if there's no separator colon.
 */
export function separatorColonIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && text[i + 1] === '[') {
      const end = text.indexOf(']]', i + 2);
      if (end >= 0) {
        i = end + 1; // jump past the closing ]] (loop's i++ moves to the next char)
        continue;
      }
      // Unbalanced `[[` with no closer — stop skipping; treat rest normally.
    }
    if (text[i] === ':') return i;
  }
  return -1;
}

/**
 * Strip stray markdown the renderer can't display, so a model that ignores the
 * "no headings / no blockquotes" prompt rule never leaks literal `###` / `>`
 * onto the screen. Runs on every node (existing and new) at parse time, so it's
 * a render-time clean-up — the stored body is left untouched.
 *
 * - Leading heading markers (`### Foo` → `Foo`) — indentation preserved.
 * - Leading blockquote markers (`> Foo` → `Foo`, and `> - x` → `- x`, which then
 *   parses as a real bullet — a bonus fix for models that quote their lists).
 * Emphasis (`**`/`*`/`_`) and `[[refs]]` are handled by the rich-text renderer,
 * so they're left alone here.
 */
export function sanitizeBody(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)#{1,6}[ \t]+/, '$1')   // heading marker
        .replace(/^(\s*)>[ \t]?/, '$1'),       // blockquote marker
    )
    .join('\n');
}

/**
 * Parse a node body markdown into a free-text preamble plus a structured
 * 2-level bullet list.
 *
 * Lenient by design — we'd rather render the new layout for "almost
 * conformant" content than fall back to plain markdown. Concretely:
 *
 * - Lines indented 0 spaces with `- ` are level-1 bullets.
 * - Lines indented 1-3 spaces with `- ` are level-2 children. The `:`
 *   separator is optional — without it, the whole line becomes the name
 *   with an empty description.
 * - Lines indented 4+ spaces with `- ` are treated as continuation: their
 *   text is appended to the description of the most recent level-2 child.
 * - Indented prose lines (no bullet marker) also append to the most recent
 *   level-2 child's description.
 * - Inline emphasis and `[[refs]]` are kept intact for the rich-text renderer.
 * - Anything else (orphan level-2 with no preceding level-1, mid-list
 *   prose, etc.) is silently skipped.
 *
 * Returns null only if there's no bullet content at all AND we want to
 * signal "use plain markdown instead". With this lenient parser, that's
 * essentially never — even a body with one bullet returns a ParsedBody.
 */
export function parseBody(markdown: string): ParsedBody | null {
  const lines = sanitizeBody(markdown).split('\n');
  const firstBulletIdx = lines.findIndex((l) => ANY_BULLET_RE.test(l));
  if (firstBulletIdx === -1) {
    return { freeText: markdown.trim(), bullets: [] };
  }
  const freeText = lines.slice(0, firstBulletIdx).join('\n').trim();

  const bullets: Bullet[] = [];
  let current: Bullet | null = null;
  let lastChild: BulletChild | null = null;

  for (let i = firstBulletIdx; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      lastChild = null;
      continue;
    }

    const m = line.match(BULLET_RE);
    if (m) {
      const indent = (m[1] ?? '').length;
      const text = (m[3] ?? '').trim();

      if (indent === 0) {
        current = { title: text, children: [] };
        bullets.push(current);
        lastChild = null;
        continue;
      }

      // Any indented bullet — any depth — is a level-2 child of the
      // current level-1 bullet. Real-world AI markdown uses 2-space and
      // 4-space (and sometimes tab) indentation interchangeably. We
      // intentionally flatten 3+ level nesting onto the level-2 list
      // rather than rejecting or trying to render an arbitrary tree.
      if (!current) continue; // orphan; skip
      const colonIdx = separatorColonIndex(text);
      let name: string;
      let desc: string;
      if (colonIdx >= 0) {
        name = sliceWithInlineEmphasis(text, 0, colonIdx);
        desc = sliceWithInlineEmphasis(text, colonIdx + 1);
      } else {
        name = text;
        desc = '';
      }
      if (!name) continue;
      const child: BulletChild = { name, desc };
      current.children.push(child);
      lastChild = child;
      continue;
    }

    // Indented non-bullet line → continuation of the last child's desc.
    if (/^\s+\S/.test(line) && lastChild) {
      const cont = line.trim();
      lastChild.desc = lastChild.desc ? `${lastChild.desc} ${cont}` : cont;
      continue;
    }

    // Prose line at zero indent that isn't a bullet → end any in-progress
    // continuation but otherwise skip.
    lastChild = null;
  }

  return { freeText, bullets };
}

/**
 * Does a node body satisfy the required two-level structure — at least 2
 * level-1 bullets, each with at least 2 level-2 children? Used after a fresh
 * generation to decide whether to auto-trigger one corrective re-generation.
 */
export function isValidStructure(body: string): boolean {
  const parsed = parseBody(body);
  if (!parsed) return false;
  return parsed.bullets.filter((b) => b.children.length >= 2).length >= 2;
}

/** Strip `[[chip]]` markers down to their plain term (`[[X]]` → `X`). */
export function stripChips(s: string): string {
  return s.replace(/\[\[([^\]]+)\]\]/g, '$1');
}

/**
 * Abbreviations whose trailing period must NOT end a sentence. Compared
 * case-insensitively against the token immediately before the period (the
 * token may itself contain dots, e.g. `e.g`).
 */
const SENTENCE_ABBREVS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'dr', 'mr', 'mrs', 'ms',
  'prof', 'st', 'jr', 'sr', 'no', 'vol', 'fig', 'approx', 'op', 'opp',
  'z.b', 'd.h', 'bzw', 'usw', 'nr', 'hr', 'fr', 'ggf', 'ca',
  'np', 'itd', 'itp', 'tzn', 'mgr', 'inż', 'ul', 'r',
  'mme', 'mlle', 'm', 'ex', 'p.ex', 'sr', 'sra', 'dra', 'p.ej',
  'sig', 'sig.ra', 'dott', 'drs', 'bijv', 'dvs', 't.ex', 'bl.a',
  'např', 'tj', 'atd', 'ing', 'str', 'т.е', 'т.д', 'т.п', 'напр', 'ул', 'г', 'ім', 'вул',
]);
/** Chars that legitimately START a new sentence right after a boundary. */
const SENTENCE_OPENER_RE = /[\p{L}\p{N}"'“‘«¿¡「『（【〔〈《(\[]/u;
/** Closing punctuation that belongs to the sentence it trails (`."` `?)`). */
const SENTENCE_CLOSERS = `"'”’»」』）】〕〉》)]`;
const SENTENCE_TERMINATORS = '.!?。！？؟۔।॥';

/** Is the `.` at `dotIdx` an internal abbreviation/initial dot, not a sentence end? */
function isAbbreviationDot(s: string, dotIdx: number): boolean {
  // Dotted initialism / acronym: `U.S.`, `Ph.D.`, `a.m.` — char two back is a dot.
  if (s[dotIdx - 2] === '.') return true;
  // Token (non-space run) ending right before the dot.
  let k = dotIdx - 1;
  while (k >= 0 && !/\s/u.test(s[k]!)) k--;
  const token = s.slice(k + 1, dotIdx).replace(/^[*_"'“‘«「『（(\[]+/u, '');
  // Single capital initial: "J. R. R. Tolkien".
  if (token.length === 1 && /\p{Lu}/u.test(token)) return true;
  if (SENTENCE_ABBREVS.has(token.toLowerCase())) return true;
  // Known compound abbreviations also allow spaces: "z. B.", "d. h.".
  // Examine only the adjacent words, not the whole preceding paragraph at each
  // dot; this scanner is also used while rendering long answers.
  const forward = s.slice(k + 1).match(/^([\p{L}]+)\.\s+([\p{L}]+)\./u);
  if (forward && SENTENCE_ABBREVS.has(`${forward[1]}.${forward[2]}`.toLowerCase())) return true;
  let previousEnd = k;
  while (previousEnd >= 0 && /\s/u.test(s[previousEnd]!)) previousEnd--;
  if (s[previousEnd] === '.') {
    let previousStart = previousEnd - 1;
    while (previousStart >= 0 && /\p{L}/u.test(s[previousStart]!)) previousStart--;
    if (SENTENCE_ABBREVS.has(`${s.slice(previousStart + 1, previousEnd)}.${token}`.toLowerCase())) return true;
  }
  return false;
}

/**
 * Split a paragraph into individual sentences for per-sentence rendering.
 *
 * Marker-aware: never breaks a `[[chip]]`. Emphasis is transparent to sentence
 * detection; the returned slices reopen its delimiters where needed. Recognizes
 * Latin, CJK, Arabic and Indic sentence punctuation, quotes and citations.
 * CJK/Arabic/Indic punctuation does not require a following space. Decimal,
 * abbreviation and initialism guards are shared with the editor and chat.
 * Abbreviations are necessarily heuristic; no text is discarded when uncertain.
 */
/**
 * The core boundary scanner: given a string, return the offsets at which a NEW
 * sentence starts (the first sentence implicitly starts at 0). Each returned `k`
 * is the index of the opener char of the following sentence (after the
 * terminator + any closers + the inter-sentence whitespace). Same marker-skips
 * and guards as `splitSentences`; operates on the string AS GIVEN (no
 * normalization), so callers that need offsets into their own raw text (e.g. the
 * editor's live splitter) can map them straight to positions. Pure.
 */
export function sentenceSplitPoints(s: string): number[] {
  const points: number[] = [];
  const emphasis = inlineEmphasis(s);
  const emphasisClosers = new Map([...emphasis.values()].map(span => [span.contentEnd, span.end]));
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    // Skip whole [[chip]] spans — never split inside one.
    if (ch === '[' && s[i + 1] === '[') {
      const end = s.indexOf(']]', i + 2);
      if (end >= 0) { i = end + 2; continue; }
    }
    // Scan the content, not the delimiter: a bold sentence still ends a sentence.
    const span = emphasis.get(i);
    if (span) { i = span.contentStart; continue; }
    const closingEnd = emphasisClosers.get(i);
    if (closingEnd != null) { i = closingEnd; continue; }

    if (ch && SENTENCE_TERMINATORS.includes(ch)) {
      // Decimal guard: digit . digit.
      if (ch === '.' && /\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? '')) {
        i++;
        continue;
      }
      // Abbreviation / initial guard.
      if (ch === '.' && isAbbreviationDot(s, i)) {
        i++;
        continue;
      }
      // Swallow a run of terminators, any trailing closers (`?!`, `."`), and
      // any citation markers attached to the completed sentence. Citation
      // placement deliberately glues `⟦n⟧` to its claim, so without treating
      // those markers like trailing punctuation, `.⟦1⟧ Next sentence` was
      // mistaken for one long sentence by the information-chunking renderer.
      let j = i + 1;
      for (;;) {
        if (j < s.length && (SENTENCE_TERMINATORS.includes(s[j]!) || SENTENCE_CLOSERS.includes(s[j]!))) { j++; continue; }
        const close = emphasisClosers.get(j);
        if (close != null) { j = close; continue; }
        // Chat exposes citations as [n]; structured nodes use ⟦n⟧ / ⦅n⦆.
        // Spaces before/between citations do not detach them from their claim.
        const citation = s.slice(j).match(/^\s*(?:⟦\d+⟧|⦅\d+⦆|\[\d+\])/u);
        if (citation) { j += citation[0].length; continue; }
        break;
      }

      if (j >= s.length) {
        i = j; // tail end — no following sentence to start
        continue;
      }
      if (/\s/u.test(s[j]!) || '。！？؟۔।॥'.includes(ch)) {
        let k = j;
        while (k < s.length && /\s/u.test(s[k]!)) k++;
        // A new sentence may OPEN with inline markup (`**bold**`, `[[chip]]`, or
        // future `_underline_` / `*italic*`). Probe past any leading markup tokens
        // to find the first VISIBLE char and test that for the opener — but split
        // at `k` (the markup start) so the markup stays with the new sentence.
        let p = k;
        for (;;) {
          if (s[p] === '*' && s[p + 1] === '*') { p += 2; continue; }   // **bold**
          if (s[p] === '[' && s[p + 1] === '[') { p += 2; continue; }   // [[chip]]
          if (s[p] === '_' || s[p] === '*') { p += 1; continue; }       // _underline_ / *italic*
          if (/[\u200e\u200f\u061c]/u.test(s[p] ?? '')) { p++; continue; } // bidi controls
          break;
        }
        if (p < s.length && SENTENCE_OPENER_RE.test(String.fromCodePoint(s.codePointAt(p)!))) {
          points.push(k);
          i = k;
          continue;
        }
      }
      i = j; // not a boundary — keep scanning
      continue;
    }
    i++;
  }

  return points;
}

/** Source ranges keep zero-space sentence boundaries (CJK) aligned with text
 * selection/term highlights. Callers may normalize whitespace before this step. */
export function sentenceSegments(s: string): Array<{ text: string; start: number; end: number }> {
  if (!s) return [];
  const bounds = [0, ...sentenceSplitPoints(s), s.length];
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (let n = 0; n < bounds.length - 1; n++) {
    let start = bounds[n]!, end = bounds[n + 1]!;
    while (start < end && /\s/u.test(s[start]!)) start++;
    while (end > start && /\s/u.test(s[end - 1]!)) end--;
    const text = sliceWithInlineEmphasis(s, start, end);
    if (text) out.push({ text, start, end });
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return sentenceSegments(text.replace(/\s+/g, ' ').trim()).map(segment => segment.text);
}

/**
 * Reconstruct a clean, paste-friendly plain-text version of a parsed node
 * body: the opening paragraph, then each level-1 bullet as `- title` with its
 * level-2 children as `  - name: description`. Chip markers are stripped to
 * their terms and the decorative `•` glyphs / stray brackets never appear —
 * this is what the node's copy handler puts on the clipboard.
 */
export function bulletsToPlainText(parsed: ParsedBody): string {
  const blocks: string[] = [];
  const ft = stripChips(parsed.freeText).trim();
  if (ft) blocks.push(ft);
  for (const b of parsed.bullets) {
    const lines = [`- ${stripChips(b.title).trim()}`];
    for (const c of b.children) {
      const name = stripChips(c.name).trim();
      const desc = stripChips(c.desc).trim();
      lines.push(desc ? `  - ${name}: ${desc}` : `  - ${name}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
