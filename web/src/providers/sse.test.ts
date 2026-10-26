import { describe, it, expect } from 'vitest';
import { sseEvents } from './sse';

/** Build a ReadableStream that emits the given string chunks as UTF-8 bytes. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of sseEvents(stream)) out.push(ev);
  return out;
}

describe('sseEvents', () => {
  it('splits events on blank lines', async () => {
    const events = await collect(streamOf(['data: a\n\ndata: b\n\n']));
    expect(events).toEqual(['data: a', 'data: b']);
  });

  it('reassembles events split across read chunks', async () => {
    const events = await collect(streamOf(['data: hel', 'lo\n\ndata: wo', 'rld\n\n']));
    expect(events).toEqual(['data: hello', 'data: world']);
  });

  it('flushes a trailing event with no final blank line (truncation fix)', async () => {
    // A stream that ends right after the last token, without a closing \n\n
    // (or a [DONE]) — the previous parser dropped this, truncating mid-word.
    const events = await collect(streamOf(['data: first\n\ndata: last chunk']));
    expect(events).toEqual(['data: first', 'data: last chunk']);
  });

  it('tolerates CRLF event separators', async () => {
    const events = await collect(streamOf(['data: a\r\n\r\ndata: b\r\n\r\n']));
    expect(events).toEqual(['data: a', 'data: b']);
  });

  it('tolerates a CRLF split across chunk boundaries', async () => {
    const events = await collect(streamOf(['data: a\r', '\n\r\ndata: b\r\n\r\n']));
    expect(events).toEqual(['data: a', 'data: b']);
  });
});
