import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFrameCoalescer } from './frameCoalesce';

/**
 * Frame coalescer for streaming store writes: many push() calls per displayed
 * frame must collapse into ONE write per frame carrying the LATEST value.
 * rAF-aligned when the tab is visible; a ~100 ms setTimeout fallback keeps
 * streams progressing in hidden tabs (where rAF never fires).
 */

describe('makeFrameCoalescer — rAF path', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('many pushes within one frame → exactly one write with the latest value', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    c.push('ab');
    c.push('abc');
    expect(writes).toEqual([]); // nothing until the frame fires
    vi.advanceTimersByTime(16);
    expect(writes).toEqual(['abc']);
  });

  test('the timeout fallback does not double-fire after the rAF already wrote', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    vi.advanceTimersByTime(16); // rAF fires
    vi.advanceTimersByTime(500); // way past the fallback window
    expect(writes).toEqual(['a']);
  });

  test('a new push after a write schedules a fresh frame (streaming continues)', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    vi.advanceTimersByTime(16);
    c.push('b');
    c.push('bc');
    vi.advanceTimersByTime(16);
    expect(writes).toEqual(['a', 'bc']);
  });

  test('flush() writes pending synchronously and clears the schedule', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    c.flush();
    expect(writes).toEqual(['a']);
    vi.advanceTimersByTime(500); // neither rAF nor timeout may re-fire
    expect(writes).toEqual(['a']);
  });

  test('flush() with nothing pending is a no-op', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.flush();
    c.push('a');
    vi.advanceTimersByTime(16);
    c.flush(); // already written — must not write again
    expect(writes).toEqual(['a']);
  });

  test('cancel() drops the pending value — nothing is ever written', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    c.cancel();
    vi.advanceTimersByTime(500);
    c.flush(); // cancelled means dropped, not deferred
    expect(writes).toEqual([]);
  });
});

describe('makeFrameCoalescer — hidden-tab fallback (rAF never fires)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Simulate a backgrounded tab: rAF accepts callbacks but never runs them.
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('the setTimeout fallback delivers the latest value within ~100 ms', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    c.push('ab');
    vi.advanceTimersByTime(99);
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(writes).toEqual(['ab']);
  });

  test('streaming keeps progressing frame after frame on the fallback alone', () => {
    const writes: string[] = [];
    const c = makeFrameCoalescer<string>((v) => writes.push(v));
    c.push('a');
    vi.advanceTimersByTime(101);
    c.push('b');
    vi.advanceTimersByTime(101);
    expect(writes).toEqual(['a', 'b']);
  });
});
