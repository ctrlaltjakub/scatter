import { test, expect, type Page } from '@playwright/test';

/**
 * R6.2 — detect the two reload bugs the user still sees:
 *   (1) NUDGE: a node (dragged far from its parent) drifts a few px on
 *       reload before settling.
 *   (2) EXPAND/CONTRACT: ~1 in 10 reloads, a node's body visibly
 *       resizes after first paint.
 *
 * Strategy: install a requestAnimationFrame recorder via addInitScript
 * (runs BEFORE page JS, re-installs on every reload) so we capture the
 * FIRST frames — the exact window where the bug lives. After each
 * reload we read the per-node trace (x, y, offsetHeight over time) and
 * measure drift + height range. Loop several reloads to catch the
 * intermittent resize.
 */

const TRACE_INIT = () => {
  (window as unknown as { __trace: unknown[] }).__trace = [];
  const rec = () => {
    const arr = (window as unknown as { __trace: Array<unknown> }).__trace;
    const nodes = document.querySelectorAll('.node');
    if (nodes.length) {
      const frame: { t: number; n: Array<{ k: string; x: number; y: number; h: number; min: number }> } = {
        t: Math.round(performance.now()),
        n: [],
      };
      for (const el of Array.from(nodes)) {
        const m = new DOMMatrixReadOnly(getComputedStyle(el as HTMLElement).transform);
        // data-sc-minsize reflects AdaptiveBullets' computed minSize —
        // a stable observable for the measurement-oscillation bug even
        // when the body's offsetHeight masks it (content < the cap).
        const root = el.querySelector('.sc-ab-root') as HTMLElement | null;
        const min = root ? Number(root.getAttribute('data-sc-minsize') || 0) : 0;
        frame.n.push({
          k: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 14),
          x: Math.round(m.e * 100) / 100,
          y: Math.round(m.f * 100) / 100,
          h: (el as HTMLElement).offsetHeight,
          min,
        });
      }
      arr.push(frame);
    }
    requestAnimationFrame(rec);
  };
  requestAnimationFrame(rec);
};

interface Frame { t: number; n: Array<{ k: string; x: number; y: number; h: number; min: number }> }

async function readTrace(page: Page): Promise<Frame[]> {
  return page.evaluate(() => (window as unknown as { __trace: Frame[] }).__trace ?? []);
}

/** For each node key: drift = dist(first stable frame, last frame);
 *  heightRange = max(h) - min(h) across the whole trace. */
function analyze(trace: Frame[]) {
  const byKey = new Map<string, Array<{ t: number; x: number; y: number; h: number; min: number }>>();
  for (const f of trace) {
    for (const nd of f.n) {
      if (!byKey.has(nd.k)) byKey.set(nd.k, []);
      byKey.get(nd.k)!.push({ t: f.t, x: nd.x, y: nd.y, h: nd.h, min: nd.min });
    }
  }
  const out: Array<{ key: string; drift: number; heightRange: number; minRange: number; minVals: number[]; samples: number }> = [];
  for (const [key, samples] of byKey) {
    if (samples.length < 2) continue;
    const t0 = samples[0]!.t;
    const baseline = samples.find((s) => s.t - t0 >= 150) ?? samples[0]!;
    const last = samples[samples.length - 1]!;
    const drift = Math.hypot(last.x - baseline.x, last.y - baseline.y);
    let hMin = Infinity, hMax = -Infinity;
    // Distinct nonzero minSize values seen = measurement-oscillation
    // signal (the masked root cause).
    const distinctMin = new Set<number>();
    let mLo = Infinity, mHi = -Infinity;
    for (const s of samples) {
      hMin = Math.min(hMin, s.h); hMax = Math.max(hMax, s.h);
      if (s.min > 0) { distinctMin.add(s.min); mLo = Math.min(mLo, s.min); mHi = Math.max(mHi, s.min); }
    }
    out.push({
      key, drift, heightRange: hMax - hMin,
      minRange: distinctMin.size ? mHi - mLo : 0,
      minVals: Array.from(distinctMin).sort((a, b) => a - b),
      samples: samples.length,
    });
  }
  return out;
}

async function clearOpfsOnce(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__wiped')) return;
    sessionStorage.setItem('__wiped', '1');
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
}

async function mockApi(page: Page) {
  await page.route('https://api.openai.com/v1/models', async (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'm' }] }) }));
  const root = 'Fermentation with [[Pasteur]] across pathways.\\n\\n'
    + '- **Lactic** glucose to lactic acid under anaerobic conditions in muscle tissue during hard exertion over time\\n'
    + '- **Alcoholic** yeast turns sugars into ethanol plus carbon dioxide which makes bread dough rise in the oven\\n'
    + '- **Industrial** dairy cultures, sourdough starters, and brewing all rely on carefully controlled fermentation\\n';
  const child = 'Pasteur, French chemist and microbiologist, founded much of microbiology.\\n\\n'
    + '- **Germ theory** microbes cause disease and spoilage, not spontaneous generation from inert matter at all\\n'
    + '- **Pasteurization** gentle heating kills pathogens in milk and wine without wrecking the flavor or nutrition\\n';
  let calls = 0;
  await page.route('https://api.openai.com/v1/chat/completions', async (r) => {
    calls++;
    const content = calls === 1 ? root : child;
    await r.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\ndata: [DONE]\n\n` });
  });
}

test.use({ deviceScaleFactor: 1.5 });
test('reload is stable: no nudge, no resize, across many reloads', async ({ page }) => {
  test.setTimeout(120_000);
  await clearOpfsOnce(page);
  await page.addInitScript(TRACE_INIT);
  await mockApi(page);
  // Force the real-browser slow-font timing: delay the self-hosted web
  // fonts so document.fonts isn't 'loaded' at mount, making the
  // post-mount size settling race the measurement gate.
  await page.route('**/*.woff2', async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });

  // ── Build a graph and drag the child FAR from its parent. ──
  await page.goto('/');
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill('fermentation');
  await page.getByRole('button', { name: 'Submit topic' }).click();
  await expect(page.getByRole('button', { name: 'Pasteur' })).toBeVisible();
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent === 'Pasteur');
    b?.click();
  });
  await expect(page.getByText(/germ theory/i).first()).toBeVisible();
  await page.waitForTimeout(4000); // let it settle so the drag commits a true rest position

  // Drag the child node FAR (≈ 360px) from the parent.
  const child = page.locator('.node').filter({ hasText: /germ theory/i }).first();
  const box = (await child.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 360, box.y + 12 + 260, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(5000); // full settle + 1.5s settle-flush commit

  // ── Reload repeatedly; analyze the first-frames trace each time. ──
  const RELOADS = 8;
  let worstDrift = 0;
  let worstResize = 0;
  let worstMinRange = 0;
  const report: string[] = [];
  for (let i = 1; i <= RELOADS; i++) {
    await page.reload();
    await expect(page.getByText(/germ theory/i).first()).toBeVisible();
    await page.waitForTimeout(3500);
    const rows = analyze(await readTrace(page));
    for (const r of rows) {
      worstDrift = Math.max(worstDrift, r.drift);
      worstResize = Math.max(worstResize, r.heightRange);
      worstMinRange = Math.max(worstMinRange, r.minRange);
      report.push(`r${i} ${r.key.padEnd(14)} drift=${r.drift.toFixed(2)}px hRange=${r.heightRange} minVals=[${r.minVals.join(',')}] frames=${r.samples}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log('[reload-stability]\n  ' + report.join('\n  '));

  // Root cause: AdaptiveBullets' computed minSize must not oscillate
  // on reload (a flip there flips bodyMaxHeight → renderedHeight →
  // physics kick (nudge) + body animation (expand/contract)).
  expect(worstMinRange, 'AdaptiveBullets minSize oscillated on reload (root cause of nudge + expand/contract)').toBeLessThan(2);
  // Downstream DOM effects (masked in headless, real in-browser):
  expect(worstResize, 'a node body resized after first paint (expand/contract bug)').toBeLessThan(3);
  expect(worstDrift, 'a node drifted on reload (nudge bug)').toBeLessThan(1.5);
});
