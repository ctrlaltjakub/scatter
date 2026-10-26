/**
 * Bullet-boundary commit gate for pass-1 streaming.
 *
 * Long-node streaming used to write the accumulator into the store every
 * frame; each write re-ran the parse/measure/physics pipeline over the whole
 * body (O(n) per frame → O(n²) per stream). The gate turns that into a
 * content-aware cadence: the opening paragraph still streams live word-by-
 * word (there are no bullets to measure yet, so it's cheap), but once the
 * first top-level bullet starts, commits land only when an L1 bullet
 * COMPLETES — i.e. when the NEXT L1 line starts. The in-progress bullet
 * (title + its indented children) is withheld and pops in whole; between
 * boundaries `next()` returns null and the store isn't touched at all.
 *
 * Grammar (mirrors bulletParse.ts): an L1 bullet is a line at indent 0
 * starting with `-`/`*`/`+` followed by whitespace; indented bullet lines are
 * its children and travel with it.
 *
 * Robustness: the committed text never shrinks. If the accumulator diverges
 * from what was already scanned (the `<<<EXPAND>>>` marker strip can
 * transiently shorten it), the gate rescans from scratch and simply waits
 * until the commit candidate grows past the last commit. `finalize()` always
 * returns the full text — the caller writes it once when the stream ends, so
 * the last bullet and any trailing prose are never lost.
 *
 * Pure and stateful-per-stream: make a fresh gate per streamChunks call.
 */

export interface CommitGate {
  /** Latest sanitized accumulator → the string to commit now, or null when
   *  the committable prefix hasn't changed since the last delivery. */
  next(acc: string): string | null;
  /** Stream complete → the full text, always. */
  finalize(acc: string): string;
}

/** An L1 line: indent 0, list marker, whitespace. */
const L1_START_RE = /^[-*+]\s/;
/** New-region scan for L1 line starts ('\n' + marker + whitespace). */
const L1_AFTER_NL_RE = /\n[-*+]\s/g;
/** An intro tail that might still become a bullet marker — withheld so a
 *  dangling '-' never flashes as prose and the commit never has to shrink. */
const NASCENT_TAIL_RE = /^\s*[-*+]?$/;

export function makeBulletCommitGate(): CommitGate {
  let prevAcc = '';
  /** Index (in the accumulator) of the start of the LAST started L1 line,
   *  or -1 while still in the intro phase. */
  let lastL1Start = -1;
  let lastCommit: string | null = null;

  const scan = (acc: string, from: number): void => {
    if (from === 0 && L1_START_RE.test(acc)) lastL1Start = 0;
    // The '\n'+marker+space pattern is 3 chars — back up that far so a match
    // straddling the old/new boundary isn't missed. Re-finding an already-
    // counted match is harmless (same index, same result).
    L1_AFTER_NL_RE.lastIndex = Math.max(0, from - 3);
    let m: RegExpExecArray | null;
    while ((m = L1_AFTER_NL_RE.exec(acc))) lastL1Start = m.index + 1;
  };

  const commitCandidate = (acc: string): string => {
    if (lastL1Start >= 0) return acc.slice(0, lastL1Start);
    const nl = acc.lastIndexOf('\n');
    const tail = acc.slice(nl + 1);
    return NASCENT_TAIL_RE.test(tail) ? acc.slice(0, Math.max(0, nl)) : acc;
  };

  return {
    next(acc: string): string | null {
      if (acc.length >= prevAcc.length && acc.startsWith(prevAcc)) {
        scan(acc, prevAcc.length); // append-only: scan just the new region
      } else {
        lastL1Start = -1; // diverged: rescan from scratch
        scan(acc, 0);
      }
      prevAcc = acc;

      const commit = commitCandidate(acc);
      if (commit.length === 0) return null;
      if (lastCommit !== null && commit.length < lastCommit.length) return null; // never shrink
      if (commit === lastCommit) return null;
      if (lastCommit !== null && commit.trimEnd() === lastCommit.trimEnd()) {
        // Whitespace-only growth (e.g. the newline before a starting bullet)
        // renders identically — remember it, but don't spend a store write.
        lastCommit = commit;
        return null;
      }
      lastCommit = commit;
      return commit;
    },
    finalize(acc: string): string {
      lastCommit = acc;
      return acc;
    },
  };
}
