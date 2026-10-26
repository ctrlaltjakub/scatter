import type { Citation } from '@/providers/types';
import type { NodeSource } from '@/store/types';
import { parseChatMarkdown, type ChatMdNode } from './chat/markdownFields';

/**
 * Turn a stream of web-search citations into numbered node sources and place
 * inline ⟦n⟧ markers in the body.
 *
 * PRIMARY path: `placeCitationMarkersExact` inserts markers at the citation
 * end-offsets into the PRE-chip body (the text the offsets index into), and the
 * chip pass then preserves the ⟦n⟧ tokens verbatim (its prompt copies text
 * unchanged — verified). `renumberCitations` cleans the numbering afterward.
 * FALLBACK: `placeCitationMarkers` re-locates a citation by matching its cited
 * text's tail against an already-mutated body, for the rare token that goes
 * missing. All pure + fully testable.
 */

/** Inline citation marker, e.g. ⟦1⟧. Uncommon glyphs so it can't collide with
 *  prose; recognized by the body renderer and by stripEmphasis. */
export const CITATION_MARKER_RE = /⟦(\d+)⟧/g;
export const marker = (n: number): string => `⟦${n}⟧`;

/** Best domain label for a source. OpenRouter/Gemini return a grounding-redirect
 *  URL but put the real domain in `title`, so prefer the title when the URL is a
 *  redirect; otherwise derive it from the hostname. */
export function sourceDomain(url: string, title?: string): string | undefined {
  let host: string | undefined;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = undefined;
  }
  const isRedirect = !host || /vertexaisearch|grounding-api-redirect|\.google\.com$/i.test(host);
  if (isRedirect && title && title.trim()) return title.trim();
  return host ?? (title?.trim() || undefined);
}

/** Dedupe citations by URL and assign 1-based numbers in first-seen order. */
export function buildSources(citations: Citation[]): NodeSource[] {
  const byUrl = new Map<string, NodeSource>();
  for (const c of citations) {
    if (!c.url || byUrl.has(c.url)) continue;
    byUrl.set(c.url, {
      n: byUrl.size + 1,
      url: c.url,
      title: c.title?.trim() || undefined,
      domain: sourceDomain(c.url, c.title),
    });
  }
  return [...byUrl.values()];
}

/** A destination may itself contain balanced parentheses (common on Wikipedia).
 * Do not mistake its first closing parenthesis for the end of the link. */
function inlineWebLinks(body: string): Array<{ start: number; end: number; label: string; url: string }> {
  const links: Array<{ start: number; end: number; label: string; url: string }> = [];
  const opening = /\[([^\]\n]*)\]\((?=https?:\/\/)/g;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(body))) {
    const start = opening.lastIndex;
    let depth = 1;
    for (let end = start; end < body.length; end++) {
      const char = body[end];
      if (/\s/.test(char!)) break;
      if (char === '\\' && /[()\\]/.test(body[end + 1] ?? '')) { end++; continue; }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) {
        links.push({ start: match.index, end: end + 1, label: match[1]!,
          url: body.slice(start, end).replace(/\\([()\\])/g, '$1') });
        opening.lastIndex = end + 1;
        break;
      }
    }
  }
  return links;
}

/** Recover source links that a model placed in its visible answer when an
 * OpenAI-compatible gateway omitted the parallel `url_citation` annotation.
 * This is deliberately used only by callers that requested web search. */
export function extractInlineCitations(body: string): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const add = (url: string, title?: string) => {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({
      url: trimmed,
      title: title?.trim() && !/^(?:source|link|citation|https?:\/\/)/i.test(title.trim())
        ? title.trim()
        : undefined,
      offsetKind: 'citation-label',
    });
  };

  for (const link of inlineWebLinks(body)) add(link.url, link.label);
  for (const match of body.matchAll(/\[(https?:\/\/[^\]\s]+)\](?!\()/g)) add(match[1]!);
  // Gemini native grounding also emits a redirect as plain text. Restrict the
  // bare-URL recovery to that provider-owned citation form so normal links in
  // prose are not silently reclassified.
  for (const match of body.matchAll(/https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[A-Za-z0-9._~%+=-]+/g)) {
    const before = body.slice(Math.max(0, (match.index ?? 0) - 180), match.index ?? 0);
    // A URL inside unfinished `[label](URL` / `[URL` syntax is not a complete
    // citation. Let the terminal guard hide and reject it instead of turning
    // its partial prefix into a marker.
    if (/\[[^\]\n]{0,160}\]\($/.test(before) || /\[$/.test(before)) continue;
    add(match[0]);
  }
  return out;
}

/** Normalize a string for matching (drop [[/]]/** markup, lowercase, collapse
 *  whitespace) while recording, for each normalized char, its index in the
 *  original — so a match position maps back to where to insert in the original. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let i = 0;
  let lastSpace = false;
  while (i < s.length) {
    if (s.startsWith('[[', i) || s.startsWith(']]', i) || s.startsWith('**', i)) { i += 2; continue; }
    const ch = s[i]!;
    if (/\s/.test(ch)) {
      if (!lastSpace && norm.length) { norm += ' '; map.push(i); lastSpace = true; }
      i += 1;
      continue;
    }
    norm += ch.toLowerCase();
    map.push(i);
    lastSpace = false;
    i += 1;
  }
  return { norm, map };
}

/** The last `n` words of a cited span, normalized — our matching anchor. */
function tailAnchor(citedText: string, words = 6): string {
  const norm = normalizeWithMap(citedText).norm.trim();
  if (!norm) return '';
  const parts = norm.split(' ').filter(Boolean);
  return parts.slice(-words).join(' ');
}

export interface MarkerPlacement {
  n: number;
  citedText: string;
}

/**
 * Insert ⟦n⟧ markers into `body`. Each placement is located by matching the tail
 * of its cited text against the body; duplicates (same n) are placed once, at
 * the first citation. Anything that can't be located is appended as a trailing
 * cluster so every source is still reachable from a marker.
 */
export function placeCitationMarkers(body: string, placements: MarkerPlacement[]): string {
  const { norm, map } = normalizeWithMap(body);
  const inserts: { pos: number; n: number }[] = [];
  const placed = new Set<number>();
  const unplaced: number[] = [];
  const seenN = new Set<number>();

  for (const p of placements) {
    if (seenN.has(p.n)) continue; // one marker per source
    seenN.add(p.n);
    const anchor = tailAnchor(p.citedText);
    if (anchor.length < 3) { unplaced.push(p.n); continue; }
    const idx = norm.indexOf(anchor);
    if (idx === -1) { unplaced.push(p.n); continue; }
    const endNorm = idx + anchor.length;
    const pos = endNorm < map.length ? map[endNorm]! : body.length; // original index just past the anchor
    inserts.push({ pos, n: p.n });
    placed.add(p.n);
  }

  // Apply inline inserts right-to-left so earlier offsets stay valid.
  inserts.sort((a, b) => b.pos - a.pos);
  let out = body;
  for (const ins of inserts) {
    out = out.slice(0, ins.pos) + marker(ins.n) + out.slice(ins.pos);
  }

  // Unplaced markers → a trailing cluster (skip any that DID get placed).
  const trailing = unplaced.filter((n) => !placed.has(n));
  if (trailing.length) {
    out = out.replace(/\s*$/, '') + ' ' + trailing.map(marker).join('');
  }
  return out;
}

/** Normalize a URL for tolerant equality: lowercase host, drop a leading
 *  `www.`, and drop a trailing slash; keep the path + query (they distinguish
 *  pages). Falls back to a trimmed lowercase string if the URL won't parse. */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return host + path + url.search;
  } catch {
    return u.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Place ⟦n⟧ markers by honoring the MODEL's OWN inline citations. Some models
 * (notably GLM via OpenRouter) return url_citation annotations with useless
 * offsets (every `start`/`end` is 0) yet write their citations inline in the
 * text — as markdown links at the end of the sentence/paragraph they support.
 * Trusting the offsets clusters every marker at char 0; instead we read the
 * inline links, map each to its numbered source (tolerant URL match), and drop
 * the matching marker exactly where the model cited it. Unknown-URL links are
 * stripped (they'd otherwise render as broken `[text](url)`), and the citation
 * punctuation (wrapping parens, `,`/`;` separators, the space before the group)
 * is collapsed so the markers glue to the preceding word like every other path.
 *
 * Returns `null` when the body has NO markdown links, so the caller falls back
 * to offset-based `placeCitationMarkersExact` (e.g. Gemini, whose offsets are
 * valid). Pure + fully testable.
 */
export function placeCitationMarkersFromLinks(body: string, sources: NodeSource[], preserveLabels = false): string | null {
  const links = inlineWebLinks(body);
  if (!links.length) return null;
  // A parenthesis containing only links (and citation separators) is an
  // attribution group, not part of the sentence's grammar. Its labels may be
  // publisher names rather than domains, so domain equality is insufficient.
  // Determine this against raw Markdown before replacements lose that context.
  const attributionLinks = new Set<number>();
  for (let i = 0; i < links.length; i++) {
    if (!/\([ \t]*$/.test(body.slice(0, links[i]!.start))) continue;
    let end = i;
    while (end + 1 < links.length
      && /^[\s,;]*$/.test(body.slice(links[end]!.end, links[end + 1]!.start))) end++;
    if (/^[ \t]*\)/.test(body.slice(links[end]!.end))) {
      for (let j = i; j <= end; j++) attributionLinks.add(links[j]!.start);
      i = end;
    }
  }
  const exact = new Map(sources.map((s) => [s.url, s.n]));
  const norm = new Map(sources.map((s) => [normalizeUrl(s.url), s.n]));
  const nFor = (url: string): number | undefined => exact.get(url) ?? norm.get(normalizeUrl(url));

  let out = body;
  for (const { start, end, label, url } of links.reverse()) {
    const n = nFor(url);
    // Conversational Markdown often links a phrase that is part of the claim,
    // not a disposable citation label. Never delete those words.
    const citationOnly = attributionLinks.has(start)
      || /^(?:source(?:\s*\d+)?|reference|citation|ref\.?|\d+)$/i.test(label.trim())
      || normalizeSourceLabel(label) === normalizeSourceLabel(url)
      || sources.some((source) => source.n === n && normalizeSourceLabel(label) === normalizeSourceLabel(source.domain ?? ''));
    const text = preserveLabels && !citationOnly ? label : '';
    out = out.slice(0, start) + text + (n ? marker(n) : '') + out.slice(end);
  }

  out = out
    // Empty parens left by a stripped unknown link: `text ()` → `text`.
    .replace(/\s*\(\s*\)/g, '')
    // A parenthesized group of only markers + separators → the markers, glued
    // (leading space dropped): ` (⟦1⟧, ⟦2⟧)` → `⟦1⟧⟦2⟧`.
    .replace(/\s*\(\s*((?:⟦\d+⟧[\s,;]*)+)\)/g, (_m, g: string) => g.replace(/[\s,;]+/g, ''))
    // Separators between adjacent bare (unparenthesized) markers: `⟦1⟧, ⟦2⟧` → `⟦1⟧⟦2⟧`.
    .replace(/(⟦\d+⟧)[\s,;]+(?=⟦\d+⟧)/g, '$1')
    // Glue a bare marker run to the preceding word: `Fact ⟦1⟧` → `Fact⟦1⟧`.
    .replace(/[ \t]+(⟦\d+⟧)/g, '$1')
    // Tidy any space left before sentence punctuation by the strips above.
    .replace(/[ \t]+([.,;:!?])/g, '$1');

  return out;
}

/** Canonical form used only for matching a model-written citation label to a
 * returned source. Keeping this deliberately conservative prevents ordinary
 * square-bracket prose from being mistaken for a citation. */
function normalizeSourceLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function sourceLabelKeys(source: NodeSource): string[] {
  const keys = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const normalized = normalizeSourceLabel(value);
    if (normalized) keys.add(normalized);
  };
  add(source.domain);
  add(source.title);
  // Exa-backed models commonly write `[https://actual-source.example/page]`.
  // The complete URL is unambiguous and should map to its structured source.
  add(source.url);
  try {
    add(new URL(source.url).hostname);
  } catch {
    // A malformed provider URL is still retained in Sources, but it cannot
    // safely identify a bare source label in the answer.
  }
  return [...keys];
}

/** True when the response ends inside citation syntax. Gemini native search
 * has been observed returning `finish_reason: "stop"` while cutting the body
 * in the middle of a grounding URL, so finish reason alone is insufficient. */
export function hasIncompleteCitationTail(body: string, citations: Citation[] = []): boolean {
  const trimmed = body.trimEnd();
  if (/\[[^\]\n]{0,160}\]\(https?:\/\/[^)\s]*$/i.test(trimmed)) return true;
  if (/\[https?:\/\/[^\]\s]*$/i.test(trimmed)) return true;
  const urlStart = trimmed.lastIndexOf('http');
  if (urlStart < 0) return false;
  const tail = trimmed.slice(urlStart);
  if (/^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i.test(tail)
    && citations.some((citation) => citation.url.length > tail.length && citation.url.startsWith(tail))) {
    return true;
  }
  return false;
}

/** Hide unfinished provider citation syntax from the live node. The raw stream
 * remains untouched for validation and final source placement. */
export function stripIncompleteCitationTail(body: string, citations: Citation[] = []): string {
  if (!hasIncompleteCitationTail(body, citations)) return body;
  const trimmed = body.trimEnd();
  const withoutMarkdownTail = trimmed
    .replace(/\[[^\]\n]{0,160}\]\(https?:\/\/[^)\s]*$/i, '')
    .replace(/\[https?:\/\/[^\]\s]*$/i, '');
  if (withoutMarkdownTail !== trimmed) return withoutMarkdownTail.trimEnd();
  const urlStart = trimmed.lastIndexOf('http');
  return urlStart >= 0 ? trimmed.slice(0, urlStart).trimEnd() : body;
}

/** Normalize only citations the model visibly placed. Unlike
 * `placeCitationMarkersReliable`, this streaming helper never falls back to an
 * unrelated paragraph location while the response is still incomplete. */
export function placeVisibleCitationMarkers(body: string, citations: Citation[]): string {
  const merged = [...citations, ...extractInlineCitations(body)];
  const sources = buildSources(merged);
  if (!sources.length) return stripIncompleteCitationTail(stripProviderCitationWrappers(body), merged);
  let out = placeCitationMarkersFromAnnotationSpans(body, merged, sources) ?? body;
  out = placeCitationMarkersFromLinks(out, sources) ?? out;
  out = placeCitationMarkersFromLabels(out, sources) ?? out;
  out = placeCitationMarkersFromBareUrls(out, sources) ?? out;
  return stripIncompleteCitationTail(stripProviderCitationWrappers(out, sources), merged);
}

/** Some providers occasionally wrap references in HTML <cite> tags. Unwrap
 * only citation-only contents (never book titles or code examples), after all
 * raw annotation offsets have been consumed. Escaped tags are also possible.
 * Unknown numeric references in such a group are not evidence: drop them at
 * finalization, but keep them while streaming before the source catalog arrives. */
function stripProviderCitationWrappers(body: string, sources?: NodeSource[]): string {
  const pattern = /[ \t]*(?:\\?<|&lt;)cite\s*(?:\\?>|&gt;)([\s\S]*?)(?:\\?<|&lt;)\/cite\s*(?:\\?>|&gt;)((?:[ \t]*(?:\[\d+(?:\s*[,;]\s*\d+)*\]|⟦\d+⟧))*)/gi;
  if (!pattern.test(body)) return body;
  pattern.lastIndex = 0;
  const literals: Array<[number, number]> = [];
  const visit = (node: ChatMdNode) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      if (node.position?.start.offset != null && node.position.end.offset != null) {
        literals.push([node.position.start.offset, node.position.end.offset]);
      }
    } else node.children?.forEach(visit);
  };
  visit(parseChatMarkdown(body));
  const numbers = sources && new Set(sources.map(source => source.n));
  const out = body.replace(pattern, (whole, inside: string, after: string, start: number) => {
    if (literals.some(([from, to]) => start < to && start + whole.length > from)
      || !/^(?:⟦\d+⟧|\[\d+(?:\s*[,;]\s*\d+)*\]|[\s,;])*$/.test(inside)) return whole;
    return (inside + after).replace(/\[(\d+(?:\s*[,;]\s*\d+)*)\]/g, (label, list: string) => numbers
      ? list.split(/\s*[,;]\s*/).map(Number).filter(n => numbers.has(n)).map(marker).join('') : label).trim();
  });
  return out === body ? body : tidyCitationSpacing(out);
}

function tidyCitationSpacing(body: string): string {
  return body
    // Bare URLs are sometimes wrapped in angle brackets or parentheses.
    .replace(/<\s*(⟦\d+⟧)\s*>/g, '$1')
    .replace(/\s*\(\s*((?:⟦\d+⟧[\s,;]*)+)\)/g, (_match, keys: string) => (
      keys.replace(/[\s,;]+/g, '')
    ))
    .replace(/(⟦\d+⟧)[\s,;]+(?=⟦\d+⟧)/g, '$1')
    // Provider labels are commonly preceded by a normal prose space. Scatter's
    // keys deliberately attach to the supported word/sentence instead.
    .replace(/[ \t]+(⟦\d+⟧)/g, '$1')
    // Gemini sometimes emits `[source].Next sentence` without whitespace.
    // Restoring it here also lets the sentence parser split the prose correctly.
    .replace(/(⟦\d+⟧[.!?])(?=[A-ZÀ-Þ])/g, '$1 ');
}

/** Remove citation-looking text when the provider supplied no structured
 * source behind it. Gemini can occasionally answer from memory while printing
 * `[1]` references anyway; leaving those visible would imply a clickable,
 * verifiable source that Scatter never received. */
export function stripUnbackedCitationLabels(body: string): string {
  const unwrapped = stripProviderCitationWrappers(body, []);
  let changed = unwrapped !== body;
  const replace = () => {
    changed = true;
    return '';
  };
  const out = unwrapped
    .replace(/[ \t]*\[[^\]\n]{1,160}\]\(https?:\/\/[^)\s]+\)/gi, replace)
    .replace(
      /[ \t]*\[(?:\d+(?:\s*[,;]\s*\d+)*|(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\]\s]*)?)\](?!\()/gi,
      replace,
    );
  if (!changed) return body;
  return stripProviderCitationWrappers(out, []).replace(/([.!?])(?=[A-ZÀ-Þ])/g, '$1 ');
}

/**
 * Replace bare provider citation labels such as `[met.ie]` or `[1, 2]` with
 * Scatter's own numbered keys. OpenRouter's native Gemini path can return
 * these labels in the visible answer *and* the same sources as structured
 * annotations; without this pass the user sees two citation systems at once.
 *
 * A non-numeric label is replaced only when it exactly matches the domain,
 * title, or hostname of a returned source. Ordinary bracketed prose is left
 * untouched. Returns `null` when no provider label was found so reliable
 * character offsets remain usable by the caller.
 */
export function placeCitationMarkersFromLabels(
  body: string,
  sources: NodeSource[],
): string | null {
  if (!sources.length || !body.includes('[')) return null;
  const sourceByNumber = new Map(sources.map((source) => [source.n, source]));
  const numberByLabel = new Map<string, number>();
  for (const source of sources) {
    for (const key of sourceLabelKeys(source)) {
      if (!numberByLabel.has(key)) numberByLabel.set(key, source.n);
    }
  }

  let changed = false;
  const out = body.replace(/\[([^\]\n]{1,160})\](?!\()/g, (whole, rawLabel: string) => {
    const numericParts = rawLabel.split(/\s*[,;]\s*/);
    const numeric = numericParts
      .map((part) => Number(part))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (numeric.length && numeric.length === numericParts.length
      && numeric.every((n) => sourceByNumber.has(n))) {
      changed = true;
      return [...new Set(numeric)].map(marker).join('');
    }

    const n = numberByLabel.get(normalizeSourceLabel(rawLabel));
    if (!n) return whole;
    changed = true;
    return marker(n);
  });
  return changed ? tidyCitationSpacing(out) : null;
}

/** Replace a provider-written bare URL only when it exactly equals a URL in
 * the structured citation catalog. Gemini's native grounding sometimes writes
 * its long Google redirect URL directly after a claim instead of formatting a
 * Markdown link; the separate annotation still gives us an unambiguous source
 * number. Unknown or ordinary URLs remain untouched. */
export function placeCitationMarkersFromBareUrls(
  body: string,
  sources: NodeSource[],
): string | null {
  let out = body;
  let changed = false;
  // Longest first prevents a shorter URL from consuming the prefix of another.
  const ordered = [...sources].sort((a, b) => b.url.length - a.url.length);
  for (const source of ordered) {
    if (!source.url || !out.includes(source.url)) continue;
    out = out.replaceAll(source.url, marker(source.n));
    changed = true;
  }
  return changed ? tidyCitationSpacing(out) : null;
}

function bracketedCitationRange(
  body: string,
  startIndex: number | undefined,
  endIndex: number | undefined,
): { start: number; end: number } | null {
  if (startIndex == null || endIndex == null || endIndex <= startIndex
    || startIndex < 0 || endIndex > body.length) return null;
  const candidates = [
    { start: startIndex, end: endIndex },
    // Providers do not all agree whether brackets belong to the annotation
    // range; accept the narrowly expanded forms without searching elsewhere.
    { start: Math.max(0, startIndex - 1), end: endIndex },
    { start: startIndex, end: Math.min(body.length, endIndex + 1) },
    { start: Math.max(0, startIndex - 1), end: Math.min(body.length, endIndex + 1) },
  ];
  for (const candidate of candidates) {
    const raw = body.slice(candidate.start, candidate.end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const trimmed = raw.trim();
    if (/^\[[^\]\n]{1,160}\]$/.test(trimmed)
      || /^\[[^\]\n]{1,160}\]\(https?:\/\/[^)\s]+\)$/.test(trimmed)) {
      return { start: candidate.start + leading, end: candidate.end - trailing };
    }
  }
  return null;
}

/** Replace a bracketed citation only when the provider explicitly annotated
 * that exact character span. This is the reliable path for Google grounding
 * redirect URLs whose stored title does not necessarily equal the visible
 * domain label. It never searches the prose for lookalike brackets. */
function placeCitationMarkersFromAnnotationSpans(
  body: string,
  citations: Citation[],
  sources: NodeSource[],
  preserveLinks = false,
): string | null {
  const numByUrl = new Map(sources.map((source) => [normalizeUrl(source.url), source.n]));
  const byRange = new Map<string, { start: number; end: number; numbers: Set<number> }>();
  for (const citation of citations) {
    const n = numByUrl.get(normalizeUrl(citation.url));
    if (!n) continue;
    const range = bracketedCitationRange(body, citation.startIndex, citation.endIndex);
    if (!range) continue;
    // Let the link converter preserve grammatical labels such as God-image.
    // Some annotations cover just [label], others cover the whole link.
    if (preserveLinks && (/^\[[^\]]*\]\(https?:\/\//.test(body.slice(range.start, range.end))
      || /^\(https?:\/\//.test(body.slice(range.end)))) continue;
    const key = `${range.start}:${range.end}`;
    const existing = byRange.get(key);
    if (existing) existing.numbers.add(n);
    else byRange.set(key, { ...range, numbers: new Set([n]) });
  }
  if (!byRange.size) return null;
  const replacements = [...byRange.values()].sort((a, b) => b.start - a.start);
  let out = body;
  for (const replacement of replacements) {
    const keys = [...replacement.numbers].sort((a, b) => a - b).map(marker).join('');
    out = out.slice(0, replacement.start) + keys + out.slice(replacement.end);
  }
  return tidyCitationSpacing(out);
}

/**
 * Normalize the two citation styles returned by hosted search providers.
 *
 * Gemini/OpenAI normally provide useful character offsets. GLM-style models
 * often provide `(0, 0)` for every annotation but write a subset of their
 * citations as markdown links. We preserve those model-chosen link positions,
 * then put only the still-unplaceable sources at a deterministic fallback:
 * before the opening paragraph's terminal punctuation for full nodes, or at
 * the end of a partial-rewrite fragment. We never guess which claim a source
 * supports.
 */
export function placeCitationMarkersReliable(
  body: string,
  citations: Citation[],
  sources: NodeSource[],
  fallback: 'opening-paragraph' | 'fragment-end' | 'sources-only' | 'message-end' = 'opening-paragraph',
): string {
  if (!sources.length) return stripProviderCitationWrappers(body, []);
  const numByUrl = new Map(sources.map((s) => [normalizeUrl(s.url), s.n]));
  const preserveLinks = fallback === 'sources-only' || fallback === 'message-end';
  const fromAnnotationSpans = placeCitationMarkersFromAnnotationSpans(body, citations, sources, preserveLinks);
  let out = fromAnnotationSpans ?? body;
  const fromLinks = placeCitationMarkersFromLinks(out, sources, preserveLinks);
  if (fromLinks !== null) out = fromLinks;
  const fromLabels = placeCitationMarkersFromLabels(out, sources);
  if (fromLabels !== null) out = fromLabels;
  const fromBareUrls = placeCitationMarkersFromBareUrls(out, sources);
  if (fromBareUrls !== null) out = fromBareUrls;
  let present = new Set([...out.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])));

  // Offsets index the provider's raw text. Once markdown links have been
  // replaced their positions no longer map safely, so use offsets only on the
  // offset-native path. A zero-length range carries no placement information.
  if (fromAnnotationSpans === null && fromLinks === null
    && fromBareUrls === null && fromLabels === null) {
    const placements = citations
      // OpenAI-compatible `url_citation` offsets locate provider citation
      // annotations, not necessarily the supported prose. Gemini sometimes
      // reports such an offset inside a Markdown word or at the next bullet.
      // A visible bracket/link was already consumed above; any remaining
      // citation-label offset is therefore unplaceable and must use fallback.
      .filter((c) => c.offsetKind !== 'citation-label')
      .map((c) => ({
        n: numByUrl.get(normalizeUrl(c.url)) ?? 0,
        endIndex: c.endIndex ?? -1,
        startIndex: c.startIndex ?? -1,
      }))
      .filter((p) => p.n > 0 && !present.has(p.n) && p.endIndex > p.startIndex && p.endIndex > 0);
    if (placements.length) out = placeCitationMarkersExact(out, placements);
    present = new Set([...out.matchAll(/⟦(\d+)⟧/g)].map((m) => Number(m[1])));
  }

  const unwrapped = stripProviderCitationWrappers(out, sources);
  if (unwrapped !== out) {
    out = unwrapped;
    present = new Set([...out.matchAll(/⟦(\d+)⟧/g)].map(match => Number(match[1])));
  }
  const unplaced = sources.filter((s) => !present.has(s.n));
  if (!unplaced.length || fallback === 'sources-only') return out;
  const cluster = unplaced.map((s) => marker(s.n)).join('');
  if (fallback === 'message-end') return out.trimEnd() + (out.trim() ? '\n\n' : '') + cluster;
  if (fallback === 'fragment-end') return out.replace(/\s*$/, '') + cluster;

  const blankLine = out.search(/\r?\n[ \t]*\r?\n/);
  const firstBullet = out.search(/\r?\n(?=- )/);
  const boundaries = [blankLine, firstBullet].filter((n) => n >= 0);
  const paragraphEnd = boundaries.length ? Math.min(...boundaries) : out.length;
  let insertAt = paragraphEnd;
  while (insertAt > 0 && /\s/.test(out[insertAt - 1]!)) insertAt -= 1;
  if (insertAt > 0 && /[.!?]/.test(out[insertAt - 1]!)) insertAt -= 1;
  return out.slice(0, insertAt) + cluster + out.slice(insertAt);
}

export interface ExactPlacement {
  n: number;
  endIndex: number;
}

/**
 * Insert ⟦n⟧ markers at exact character offsets — the citation `end_index` into
 * the model content. Reliable when applied to the PRE-chip body the offsets
 * index into (the chip pass then preserves the tokens). One marker per `n`
 * (first occurrence); offsets clamped; inserted right-to-left so earlier offsets
 * stay valid. Ties at the same position render in ascending-n order.
 */
export function placeCitationMarkersExact(body: string, placements: ExactPlacement[]): string {
  const seen = new Set<number>();
  const inserts: { pos: number; n: number }[] = [];
  for (const p of placements) {
    if (seen.has(p.n)) continue;
    seen.add(p.n);
    inserts.push({ pos: Math.max(0, Math.min(p.endIndex, body.length)), n: p.n });
  }
  inserts.sort((a, b) => b.pos - a.pos || b.n - a.n);
  let out = body;
  for (const ins of inserts) out = out.slice(0, ins.pos) + marker(ins.n) + out.slice(ins.pos);
  return out;
}

/**
 * Renumber the ⟦n⟧ markers in `body` to 1..k in reading order, rewriting both
 * the tokens and the matching `sources`. Prunes sources whose marker is absent;
 * drops orphan markers with no source. Returns cleaned body + sources (by new n).
 */
export function renumberCitations(
  body: string,
  sources: NodeSource[],
  startAt = 1,
  keepUnplaced = false,
): { body: string; sources: NodeSource[] } {
  const byOldN = new Map(sources.map((s) => [s.n, s]));
  const remap = new Map<number, number>(); // oldN → newN, in first-appearance order
  let next = startAt;
  for (const m of body.matchAll(/⟦(\d+)⟧/g)) {
    const oldN = Number(m[1]);
    if (!remap.has(oldN) && byOldN.has(oldN)) remap.set(oldN, next++);
  }
  const newBody = body.replace(/⟦(\d+)⟧/g, (_whole, d: string) => {
    const nn = remap.get(Number(d));
    return nn ? marker(nn) : ''; // drop orphan markers (no matching source)
  });
  // A provider can return useful search sources without claim locations.
  // Keep those in the source panel without inventing an inline attribution.
  if (keepUnplaced) for (const source of sources) {
    if (!remap.has(source.n)) remap.set(source.n, next++);
  }
  const newSources = [...remap.entries()]
    .map(([oldN, nn]) => ({ ...byOldN.get(oldN)!, n: nn }))
    .sort((a, b) => a.n - b.n);
  return { body: newBody, sources: newSources };
}
