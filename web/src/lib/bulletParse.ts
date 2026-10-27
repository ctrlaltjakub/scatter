import { sliceWithInlineEmphasis } from './inlineEmphasis';

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
