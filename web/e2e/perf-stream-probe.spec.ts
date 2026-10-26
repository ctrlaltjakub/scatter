import { test, expect, type Page } from '@playwright/test';

/* Perf probe: main-thread health while a LONG node streams (pass 1) and while
 * its terms are marked (pass 2).
 *
 * Guards the "GLM 5.2 long node" regression: per-frame streaming work that
 * scales with the total body length (lab remounts, re-parses, whole-project
 * re-mints) saturates the main thread, so wheel input over the node goes
 * rubbery and long tasks grow toward the end of the stream.
 *
 * Method: fetch-override SSE (pattern from pan-during-stream.spec.ts) streams
 * a ~22k-char two-level body over real time, then a second call streams the
 * same text with [[term]] chips. 4× CPU throttle approximates a laptop. Two
 * PerformanceObservers record long tasks and wheel-event input delay while the
 * test wheels over the (selected) node through both passes.
 *
 * Assertions encode the ACCEPTANCE targets (they FAIL on the pre-fix build —
 * that is the point; the fix series turns them green):
 *  - pass 2 after the first [[ lands: near-zero long-task time (one-shot chip
 *    apply means the body never changes mid-pass),
 *  - pass 1: long-task time must not balloon toward the stream's end,
 *  - wheel p95 input delay stays responsive in both passes.
 */

/** Nominal wall-clock duration of each pass's stream. Pacing is TIME-based:
 *  each tick sends everything "due" by now, so main-thread jank coalesces
 *  deltas (like a real network buffer) instead of stretching the stream. */
const STREAM_MS = 10_000;
const TICK_MS = 12;

function syntheticBodies(): { plain: string; chipped: string } {
  const intro =
    'An encyclopedic overview of a deliberately long synthetic topic. The receptor ' +
    'sits in the membrane and couples an external signal to an internal enzyme cascade. ' +
    'Downstream, a gradient forms across each compartment and the substrate turnover ' +
    'rises measurably. This intro paragraph streams first, before any bullet arrives.';
  const sentence = (i: number, j: number) =>
    `The receptor for facet ${i}.${j} binds its substrate at the membrane interface and ` +
    'relays the signal through an enzyme cascade that amplifies it stepwise. The resulting ' +
    'gradient drives transport across the compartment boundary, and every repetition of the ' +
    'cycle adds structural detail that a reader would scroll through. Regulation depends on ' +
    'feedback that tunes receptor density and substrate affinity over time, which keeps the ' +
    'whole system inside its stable operating window.';
  const bullets: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const kids: string[] = [];
    for (let j = 1; j <= 5; j++) kids.push(`  - facet ${i}.${j}: ${sentence(i, j)}`);
    bullets.push(`- **Topic area ${i}**\n${kids.join('\n')}`);
  }
  const plain = `${intro}\n\n${bullets.join('\n')}`;
  // Deterministic "marking": wrap recurring terms as chips. plain(chipped)
  // must equal plain (only [[ ]] inserted) so validateChips accepts it.
  const chipped = plain.replace(/\b(membrane|enzyme cascade|gradient|substrate)\b/g, '[[$1]]');
  return { plain, chipped };
}

async function onboardAndSubmitTopic(page: Page, topic: string) {
  await expect(page.getByLabel('API key')).toBeVisible();
  await page.getByLabel('API key').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  // Step 2: tick the (mock) model so "Finish setup" enables.
  await page.getByRole('button', { name: /mock-model/ }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('long-node streaming + term marking keep the main thread responsive', async ({ page }) => {
  test.setTimeout(180_000);
  const bodies = syntheticBodies();

  if (process.env.PROBE_NO_AURA) {
    // Diagnostic mode: make WebGL2 unavailable so the ASCII-aura layer takes
    // its designed no-WebGL path and renders nothing — isolates the aura's
    // per-frame CPU share from the streaming pipeline's.
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (HTMLCanvasElement.prototype as any).getContext = function (type: string, ...args: unknown[]) {
        if (type === 'webgl2') return null;
        return (orig as any).call(this, type, ...args);
      };
    });
  }

  if (process.env.PROBE_BCR) {
    // Diagnostic mode: count getBoundingClientRect calls and sample stacks.
    await page.addInitScript(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const w = window as any;
      w.__bcr = { n: 0, stacks: {} as Record<string, number> };
      // Who mutates the DOM (and thereby dirties layout) frame-by-frame?
      w.__mut = [] as { t: number; key: string }[];
      const mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (w.__mut.length >= 8000) return;
          const el = r.target as Element;
          const key = `${r.type}:${el.nodeName}.${(el.className && String(el.className).split(' ')[0]) || ''}${r.attributeName ? `[${r.attributeName}]` : ''}`;
          w.__mut.push({ t: Math.round(performance.now()), key });
        }
      });
      window.addEventListener('DOMContentLoaded', () => {
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      });
      const orig = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function (this: Element) {
        w.__bcr.n++;
        if (w.__bcr.n % 97 === 0) {
          const s = (new Error().stack ?? '').split('\n').slice(2, 5).join(' | ');
          w.__bcr.stacks[s] = (w.__bcr.stacks[s] ?? 0) + 1;
        }
        return orig.call(this);
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    });
  }

  await page.addInitScript((cfg: { plain: string; chipped: string; streamMs: number; tick: number }) => {
    // Fresh OPFS so onboarding shows.
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    // Phase stamps written by the fetch mock; stats read them at the end.
    w.__probe = { calls: 0 };

    // Long tasks (>50ms uninterruptible main-thread blocks).
    w.__lt = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__lt.push({ t: e.startTime, d: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* longtask unsupported → stats stay empty and assertions fail loudly */ }

    // Wheel input delay, measured directly: e.timeStamp is when the event was
    // created/dispatched, performance.now() inside the handler is when the
    // main thread finally ran JS for it. (The Event Timing API can't do this —
    // it excludes continuous events like wheel.) Passive capture listener on
    // window runs before the app's own handlers and never blocks scrolling.
    w.__wheel = [];
    window.addEventListener(
      'wheel',
      (e: WheelEvent) => { w.__wheel.push({ t: e.timeStamp, delay: performance.now() - e.timeStamp }); },
      { capture: true, passive: true },
    );

    const realFetch = window.fetch.bind(window);
    w.fetch = (input: any, init: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (url.includes('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'mock-model' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/chat/completions')) {
        const reqBody = String(init?.body ?? '');
        const enc = new TextEncoder();
        w.__probe.reqs = w.__probe.reqs ?? [];
        w.__probe.reqs.push({ at: Math.round(performance.now()), body: reqBody.slice(0, 120) });

        // Tiny connectivity/capability probes ("hi", max_tokens:1) → instant.
        // Delimiter required: '"max_tokens":1' alone would also match 15000.
        if (/"max_tokens":\s*1\s*[,}]/.test(reqBody)) {
          const s = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
          return Promise.resolve(
            new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
          );
        }

        // Route by prompt content, not call order: the chip pass carries the
        // "precise text annotator" system prompt; everything else is pass 1.
        const isChipPass = reqBody.includes('text annotator');
        const text = isChipPass ? cfg.chipped : cfg.plain;
        if (isChipPass) {
          if (w.__probe.p2Start == null) w.__probe.p2Start = performance.now();
          else w.__probe.extraCalls = (w.__probe.extraCalls ?? 0) + 1;
        } else if (w.__probe.p1Start == null) {
          w.__probe.p1Start = performance.now();
        } else {
          w.__probe.extraCalls = (w.__probe.extraCalls ?? 0) + 1;
        }

        const t0 = performance.now();
        let pos = 0;
        const stream = new ReadableStream({
          start(controller) {
            const push = () => {
              const due = Math.min(
                text.length,
                Math.floor(((performance.now() - t0) / cfg.streamMs) * text.length),
              );
              if (due > pos) {
                const delta = text.slice(pos, due);
                pos = due;
                if (isChipPass && w.__probe.firstChipAt == null && delta.includes('[[')) {
                  w.__probe.firstChipAt = performance.now();
                }
                const evt = `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
                controller.enqueue(enc.encode(evt));
              }
              if (pos >= text.length) {
                if (isChipPass) w.__probe.p2End = performance.now();
                else w.__probe.p1End = performance.now();
                controller.enqueue(enc.encode('data: [DONE]\n\n'));
                controller.close();
              } else {
                setTimeout(push, cfg.tick);
              }
            };
            setTimeout(push, cfg.tick);
          },
          cancel(reason: unknown) {
            w.__probe.cancels = w.__probe.cancels ?? [];
            w.__probe.cancels.push({ at: Math.round(performance.now()), reason: String(reason ?? '') });
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      }
      return realFetch(input, init);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, { plain: bodies.plain, chipped: bodies.chipped, streamMs: STREAM_MS, tick: TICK_MS });

  await page.goto('/');

  // Throttle AFTER load so onboarding stays fast; streaming runs throttled.
  const cdp = await page.context().newCDPSession(page);
  await onboardAndSubmitTopic(page, 'synthetic perf probe');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const card = page.locator('[data-node-id]').first();
  await card.waitFor({ timeout: 20_000 });

  // Select the node (wheel over a selected node steps its sections — the real
  // "scrolling inside the node" path; unselected wheel would zoom the canvas).
  if (!process.env.PROBE_NO_SELECT) {
    await card.click({ position: { x: 24, y: 14 } });
    await expect(page.locator('.node.selected')).toHaveCount(1, { timeout: 5_000 });
  }

  // Diagnostic: capture a devtools.timeline trace across pass 2 and print the
  // main-thread cost by category + top named function calls.
  if (process.env.PROBE_TIMELINE) {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    for (;;) {
      const probe = await page.evaluate(() => (window as any).__probe);
      if (probe?.p1End) break;
      await page.waitForTimeout(300);
    }
    const tracePath = 'test-results/probe-timeline.json';
    await (page.context().browser() as any).startTracing(page, {
      path: tracePath, categories: ['devtools.timeline', 'toplevel'],
    });
    for (;;) {
      const probe = await page.evaluate(() => (window as any).__probe);
      if (probe?.p2End) break;
      await page.waitForTimeout(300);
    }
    await (page.context().browser() as any).stopTracing();
    const fs = await import('node:fs');
    const t = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
    const evts = t.traceEvents ?? t;
    const tid = evts.find((e: any) => e.name === 'thread_name' && e.args?.name === 'CrRendererMain')?.tid;
    const main = evts.filter((e: any) => e.tid === tid && e.ph === 'X' && e.dur > 0);
    const byName: Record<string, number> = {};
    for (const e of main) byName[e.name] = (byName[e.name] ?? 0) + e.dur;
    const cats = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([n, us]) => `${Math.round((us as number) / 1000)}ms ${n}`);
    const fns: Record<string, number> = {};
    for (const e of main) {
      if (e.name === 'FunctionCall' || e.name === 'TimerFire' || e.name === 'EventDispatch') {
        const d = e.args?.data ?? {};
        const key = `${e.name}:${d.functionName ?? d.type ?? '?'}@${String(d.url ?? '').split('/').slice(-1)[0]}:${d.lineNumber ?? ''}`;
        fns[key] = (fns[key] ?? 0) + e.dur;
      }
    }
    const topFns = Object.entries(fns).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([n, us]) => `${Math.round((us as number) / 1000)}ms ${n}`);
    console.log(`[perf-stream-probe timeline p2]\nCATEGORIES:\n${cats.join('\n')}\nTOP CALLS:\n${topFns.join('\n')}`);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // Diagnostic: sample-profile pass 2 and print top self-time functions.
  if (process.env.PROBE_PROFILE) {
    await cdp.send('Profiler.enable');
    /* eslint-disable @typescript-eslint/no-explicit-any */
    // Wait for pass 1 to end, then profile pass 2 end-to-end.
    for (;;) {
      const probe = await page.evaluate(() => (window as any).__probe);
      if (probe?.p1End) break;
      await page.waitForTimeout(300);
    }
    await cdp.send('Profiler.start');
    for (;;) {
      const probe = await page.evaluate(() => (window as any).__probe);
      if (probe?.p2End) break;
      await page.waitForTimeout(300);
    }
    const { profile } = (await cdp.send('Profiler.stop')) as any;
    const self = new Map<number, number>();
    const samples: number[] = profile.samples ?? [];
    const deltas: number[] = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      self.set(samples[i]!, (self.get(samples[i]!) ?? 0) + (deltas[i] ?? 0));
    }
    const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
    const rows = [...self.entries()]
      .map(([id, us]) => ({ us, cf: byId.get(id)?.callFrame }))
      .filter((r) => r.cf)
      .sort((a, b) => b.us - a.us)
      .slice(0, 20)
      .map((r) => `${Math.round(r.us / 1000)}ms  ${r.cf.functionName || '(anon)'}  ${String(r.cf.url).split('/').slice(-1)[0]}:${r.cf.lineNumber}`);
    console.log(`[perf-stream-probe profile p2]\n${rows.join('\n')}`);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  // Wheel over the node body through BOTH passes until pass 2 finishes. The
  // node's box is cached (refreshed occasionally) — a saturated renderer makes
  // boundingBox()/evaluate() round-trips take ~a second each, and re-querying
  // every iteration would starve the wheel dispatching we're here to measure.
  const t0 = Date.now();
  let down = true;
  let box = await card.boundingBox();
  for (let iter = 0; ; iter++) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const probe = await page.evaluate(() => (window as any).__probe);
    if (probe?.p2End) break;
    if (Date.now() - t0 > 90_000) throw new Error(`probe timed out; state=${JSON.stringify(probe)}`);
    if (iter % 8 === 0) box = (await card.boundingBox()) ?? box;
    if (box && !process.env.PROBE_NO_WHEEL) {
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height * 0.5, 320));
      for (let k = 0; k < 3; k++) {
        await page.mouse.wheel(0, down ? 140 : -140);
        await page.waitForTimeout(40);
      }
      down = !down;
    }
    await page.waitForTimeout(140);
  }
  // Let the post-stream measure/settle finish before reading stats.
  await page.waitForTimeout(2_000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const stats = await page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = window as any;
    const probe = w.__probe;
    const lts: { t: number; d: number }[] = w.__lt ?? [];
    const wheels: { t: number; delay: number }[] = w.__wheel ?? [];
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const bucket = (a?: number, b?: number) => {
      if (a == null || b == null) return { count: 0, total: 0, max: 0 };
      const xs = lts.filter((e) => e.t >= a && e.t <= b);
      return {
        count: xs.length,
        total: Math.round(xs.reduce((s, e) => s + e.d, 0)),
        max: Math.round(xs.reduce((m, e) => Math.max(m, e.d), 0)),
      };
    };
    const wheelP95 = (a?: number, b?: number) => {
      if (a == null || b == null) return -1;
      const xs = wheels.filter((e) => e.t >= a && e.t <= b).map((e) => e.delay).sort((x, y) => x - y);
      if (xs.length === 0) return -1;
      return Math.round(xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] ?? 0);
    };
    const third = (probe.p1End - probe.p1Start) / 3;
    return {
      phases: {
        p1Ms: Math.round(probe.p1End - probe.p1Start),
        p2Ms: Math.round(probe.p2End - probe.p2Start),
        firstChipAfterMs: probe.firstChipAt != null ? Math.round(probe.firstChipAt - probe.p2Start) : null,
        extraCalls: probe.extraCalls ?? 0,
      },
      p1: bucket(probe.p1Start, probe.p1End),
      p1FirstThird: bucket(probe.p1Start, probe.p1Start + third),
      p1LastThird: bucket(probe.p1End - third, probe.p1End),
      p2AfterFirstChip: bucket(probe.firstChipAt ?? probe.p2Start, probe.p2End),
      wheel: {
        count: wheels.length,
        p95DelayP1: wheelP95(probe.p1Start, probe.p1End),
        p95DelayP2: wheelP95(probe.p2Start, probe.p2End),
      },
      chipEls: document.querySelectorAll('.ref-chip').length,
    };
  });

  // Always print the table — this is the before/after record.
  console.log(`[perf-stream-probe] ${JSON.stringify(stats, null, 2)}`);

  if (process.env.PROBE_BCR) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const bcr = await page.evaluate(() => (window as any).__bcr);
    const top = Object.entries(bcr.stacks as Record<string, number>)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([s, n]) => `${n}× ${s}`);
    console.log(`[perf-stream-probe bcr] total=${bcr.n}\n${top.join('\n')}`);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const mut = await page.evaluate(() => {
      const w = window as any;
      const probe = w.__probe;
      const inP2 = (m: { t: number }) => m.t >= probe.p2Start && m.t <= probe.p2End;
      const by: Record<string, number> = {};
      for (const m of (w.__mut ?? []) as { t: number; key: string }[]) {
        if (inP2(m)) by[m.key] = (by[m.key] ?? 0) + 1;
      }
      const hist: Record<number, number> = {};
      for (const m of (w.__mut ?? []) as { t: number; key: string }[]) {
        if (inP2(m)) {
          const sec = Math.floor((m.t - probe.p2Start) / 1000);
          hist[sec] = (hist[sec] ?? 0) + 1;
        }
      }
      return { top: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12), hist };
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    console.log(`[perf-stream-probe mutations p2]\n${mut.top.map(([k, n]: [string, number]) => `${n}× ${k}`).join('\n')}\nper-second: ${JSON.stringify(mut.hist)}`);
  }

  // Sanity: both passes really ran, chips landed, wheels were measured.
  expect(stats.phases.extraCalls, 'unexpected extra generation calls').toBe(0);
  expect(stats.chipEls, 'chips rendered after the marking pass').toBeGreaterThan(5);
  // ≥3: even a fully-saturated baseline main thread lets a few through.
  expect(stats.wheel.count, 'wheel events were observed').toBeGreaterThanOrEqual(3);

  // ── Acceptance targets ──────────────────────────────────────────────────
  // Calibrated on prod builds, tracing off, 4× throttle. Fixed state vs
  // pre-fix state (commit 45ea946): p2 total 239ms vs 8423ms; p2 max 169 vs
  // 260; p1 share 16% vs 76%; wheel p95 117/69ms vs 399/269ms. Thresholds sit
  // between the two with headroom for machine noise.
  // Pass 2: once chips start landing, the body must not be re-processed per
  // frame — near-zero long-task time for the rest of the pass.
  expect(stats.p2AfterFirstChip.total, 'pass-2 long-task ms after first chip').toBeLessThan(800);
  expect(stats.p2AfterFirstChip.max, 'pass-2 worst long task').toBeLessThan(250);
  // Pass 1: the main thread must stay mostly free while text streams in.
  expect(
    stats.p1.total,
    'pass-1 long-task ms as a share of the stream',
  ).toBeLessThan(stats.phases.p1Ms * 0.3);
  // Wheel stays responsive through both passes.
  expect(stats.wheel.p95DelayP1, 'p95 wheel input delay during pass 1').toBeLessThan(250);
  expect(stats.wheel.p95DelayP2, 'p95 wheel input delay during pass 2').toBeLessThan(150);
});
