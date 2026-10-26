/**
 * Shared Server-Sent-Events reader for the streaming chat adapters.
 *
 * Yields each raw event block (the text between blank-line separators) as a
 * string; the caller extracts the `data:` line(s) it cares about. Two
 * robustness properties that the per-adapter parsers previously lacked, both
 * of which could truncate a generation mid-word:
 *
 *   1. **Trailing flush.** When the stream ends WITHOUT a final blank-line
 *      separator (e.g. a network blip, or a server that closes right after the
 *      last token without sending `data: [DONE]`), the last buffered event was
 *      silently dropped. We now emit whatever remains in the buffer.
 *
 *   2. **CRLF tolerance.** Some providers / proxies separate events with
 *      `\r\n\r\n` instead of `\n\n`. We normalize CR-LF to LF on every read
 *      (re-scanning the small unconsumed tail), so the blank-line split works
 *      regardless. Stray `\r` left on a data line is removed by the caller's
 *      `.trim()`.
 */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let nl: number;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const event = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (event.trim()) yield event;
    }
  }
  // Flush the decoder and any remaining buffered event(s).
  buf = (buf + decoder.decode()).replace(/\r\n/g, '\n');
  for (const event of buf.split('\n\n')) {
    if (event.trim()) yield event;
  }
}
