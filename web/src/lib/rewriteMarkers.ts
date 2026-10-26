/**
 * Invisible markers used to delimit each in-flight PARTIAL rewrite's
 * section inside a node's working body, so multiple partials targeting
 * different sections can stream concurrently without their splice
 * ranges interfering.
 *
 * Each rewrite owns a marker pair built from a unique id:
 *   start = '' + id + ''
 *   end   = '' + id + ''
 *
 * The chars come from the Unicode Private Use Area (U+E000-F8FF), which
 * by definition has no assigned glyphs — the renderer treats them as
 * undefined / invisible. We still STRIP them at display time (see
 * `stripMarkers`) so they don't:
 *  - take up width in line-wrap calculations,
 *  - confuse `parseBody`'s line/colon detection,
 *  - end up in committed version bodies.
 *
 * IDs are short fixed-width hex (8 chars) so the strip regex is exact
 * and won't accidentally match a non-marker PUA char if one ever sneaks
 * in via paste or model output.
 */

const PFX = '';
const START_SFX = '';
const END_SFX = '';

/** Matches both START and END markers for any 8-hex-char id. */
const MARKER_REGEX = /[0-9a-f]{8}[]/g;

let nextCounter = 0;
/** Allocate a fresh marker id (8 hex chars). Module-level monotonic
 *  counter; the wrap window (4 billion) is enormous for a single
 *  session, and the IDs only need to be unique among CURRENTLY IN-
 *  FLIGHT rewrites for one node — past IDs whose markers are gone
 *  can't collide with anything. */
export function nextMarkerId(): string {
  nextCounter = (nextCounter + 1) >>> 0; // unsigned 32-bit wrap
  return nextCounter.toString(16).padStart(8, '0');
}

export function startMarker(id: string): string {
  return PFX + id + START_SFX;
}

export function endMarker(id: string): string {
  return PFX + id + END_SFX;
}

/** Remove ALL markers from a body (any id). Used at render time and at
 *  commit time so neither the user nor the persisted version ever sees
 *  them. */
export function stripMarkers(body: string): string {
  return body.replace(MARKER_REGEX, '');
}

/** Char index of the text BETWEEN this rewrite's markers in `body`, or
 *  null if either marker is missing. Returns `{ start, end }` so
 *  `body.slice(start, end)` is exactly the text the rewrite owns. */
export function findMarkerBounds(
  body: string,
  id: string,
): { start: number; end: number } | null {
  const s = startMarker(id);
  const e = endMarker(id);
  const sIdx = body.indexOf(s);
  if (sIdx === -1) return null;
  const eIdx = body.indexOf(e, sIdx + s.length);
  if (eIdx === -1) return null;
  return { start: sIdx + s.length, end: eIdx };
}

/** Replace the text BETWEEN this rewrite's markers with `replacement`.
 *  Returns `body` unchanged if the markers are missing (a no-op rather
 *  than throw — protects against races where the rewrite was cancelled
 *  before this chunk landed). */
export function replaceBetweenMarkers(
  body: string,
  id: string,
  replacement: string,
): string {
  const bounds = findMarkerBounds(body, id);
  if (!bounds) return body;
  return body.slice(0, bounds.start) + replacement + body.slice(bounds.end);
}

/** Wrap `sectionText` with this rewrite's marker pair and splice it
 *  into `body` between `start` and `end` char offsets. The marker pair
 *  stays in `body` for the duration of the rewrite. */
export function insertMarkedSection(
  body: string,
  start: number,
  end: number,
  id: string,
  sectionText: string,
): string {
  return body.slice(0, start) + startMarker(id) + sectionText + endMarker(id) + body.slice(end);
}

/** Remove THIS rewrite's marker pair (start + end) from `body`,
 *  keeping the text between them. Use when a partial rewrite
 *  completes successfully — the section's final text stays in place,
 *  the markers go away. */
export function removeMarkers(body: string, id: string): string {
  return body.replace(startMarker(id), '').replace(endMarker(id), '');
}
