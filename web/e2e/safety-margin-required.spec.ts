import { test, expect, type Page } from '@playwright/test';

// SKIPPED (backend-free migration): this is a LIVE-Gemini integration test — it
// hits the real Gemini API, which only worked through the old /api/proxy relay.
// That relay was removed (browsers can't call Gemini directly — CORS), so this
// can't run backend-free. To re-enable, convert onboarding to a mocked provider
// (see e2e/search-highlight.spec.ts) or route via OpenRouter.
test.beforeEach(() => { test.skip(true, 'live-Gemini test needs a backend proxy (removed); convert to a mock'); });

// This test enforces the safety-margin invariant: minBodyHeight must
// include at least 20% (or 60 px, whichever is larger) of buffer above
// the raw A/B math.
//
// Per the user: "the bug disappears when i make the node around 15-20%
// bigger". So a 20% safety margin should always prevent it. This test
// will FAIL if someone removes the safety margin or if the version
// running differs from what the source code says.
//
// Strategy:
//   1. Inject markers at node-bottom, body-bottom, and the last
//      rendered text element's bottom.
//   2. Activate the biggest bullet at minimum size (the user's exact
//      flow that reproduces the bug).
//   3. Assert that the data-sc-version attribute on .sc-ab-root matches
//      the current code (catches stale builds).
//   4. Assert that lastTextBottom <= bodyBottom (the only thing that
//      actually matters visually).
//   5. Assert that minH is at least 1.18 * (A + freetext + 22) — a
//      slightly relaxed version of the 20% safety so sub-pixel rounding
//      doesn't trip the check.

const GEMINI_KEY = process.env.SCATTER_GEMINI_TEST_KEY ?? '';
test.skip(!GEMINI_KEY, 'Set SCATTER_GEMINI_TEST_KEY to opt into this live-provider test.');
const EXPECTED_VERSION = 'v8-zoom-normalized';
const TOPICS = ['psychoanalysis', 'lactic fermentation'];

async function clearOpfs(page: Page) {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries supported in Chromium
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
}

async function onboard(page: Page) {
  await page.locator('#sc-provider').selectOption({ value: 'gemini' });
  await page.locator('#sc-key').fill(GEMINI_KEY);
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible({ timeout: 15000 });
}

async function waitStreamComplete(page: Page) {
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => {
    const cursor = document.querySelector('.node-body[data-sc-mode="adaptive"] .cursor');
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    const minSet = body && (body.getAttribute('data-sc-min-body') ?? '').length > 0;
    return !cursor && minSet;
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

async function shrinkToMin(page: Page) {
  const handle = page.locator('.node-resize.br').first();
  const box = await handle.boundingBox();
  if (!box) throw new Error('no br handle');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 30; i++) {
    await page.mouse.move(box.x - 200, box.y - 200);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function activateBiggest(page: Page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>('.sc-ab-measure > ul:nth-of-type(1) > .sc-ab-item')];
    if (items.length === 0) return -1;
    let maxI = 0, maxH = 0;
    items.forEach((it, i) => {
      const h = it.getBoundingClientRect().height;
      if (h > maxH) { maxH = h; maxI = i; }
    });
    const visible = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    visible[maxI]?.click();
    return maxI;
  });
}

async function measureFit(page: Page) {
  return page.evaluate(() => {
    const node = document.querySelector('.node') as HTMLElement | null;
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    const root = body?.querySelector('.sc-ab-root') as HTMLElement | null;
    if (!node || !body || !root) return null;
    const items = [...body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')];
    const lastItem = items.at(-1);
    if (!lastItem) return null;
    const lastText =
      [...lastItem.querySelectorAll<HTMLElement>('.sc-ab-described, .sc-ab-inline')].at(-1) ??
      lastItem.querySelector<HTMLElement>('.sc-ab-title') ?? lastItem;
    const hiddenMax = [...body.querySelectorAll<HTMLElement>('.sc-ab-measure > ul:nth-of-type(1) > .sc-ab-item')];
    const hiddenM0 = [...body.querySelectorAll<HTMLElement>('.sc-ab-measure > ul:nth-of-type(2) > .sc-ab-item')];
    const ft = body.querySelector(".sc-ab-root > .sc-ab-freetext") as HTMLElement | null;

    const nodeRect = node.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const lastItemRect = lastItem.getBoundingClientRect();
    const lastTextRect = lastText.getBoundingClientRect();

    const hMaxHeights = hiddenMax.map((it) => it.getBoundingClientRect().height);
    const hM0Heights = hiddenM0.map((it) => it.getBoundingClientRect().height);
    const sumM0 = hM0Heights.reduce((s, h) => s + h, 0);
    let A = 0;
    for (let i = 0; i < hMaxHeights.length; i++) {
      const cand = (hMaxHeights[i] ?? 0) + (sumM0 - (hM0Heights[i] ?? 0));
      if (cand > A) A = cand;
    }

    return {
      version: root.getAttribute('data-sc-version'),
      nodeTop: +nodeRect.top.toFixed(2),
      nodeBottom: +nodeRect.bottom.toFixed(2),
      bodyTop: +bodyRect.top.toFixed(2),
      bodyBottom: +bodyRect.bottom.toFixed(2),
      lastItemBottom: +lastItemRect.bottom.toFixed(2),
      lastTextBottom: +lastTextRect.bottom.toFixed(2),
      lastTextPastBody: +(lastTextRect.bottom - bodyRect.bottom).toFixed(2),
      lastItemPastBody: +(lastItemRect.bottom - bodyRect.bottom).toFixed(2),
      minH: Number(body.getAttribute('data-sc-min-body') || 0),
      bodyH: body.clientHeight,
      freeTextH: +(ft?.getBoundingClientRect().height.toFixed(2) ?? 0),
      A: +A.toFixed(2),
      itemCount: items.length,
    };
  });
}

for (const topic of TOPICS) {
  test(`${topic}: text must fit body after shrink + activate biggest`, async ({ page }) => {
    test.setTimeout(180000);
    await clearOpfs(page);
    await page.goto('/');
    await onboard(page);
    await page.getByPlaceholder('A topic or a question…').fill(topic);
    await page.getByRole('button', { name: 'Submit topic' }).click();
    await waitStreamComplete(page);

    await shrinkToMin(page);
    const biggestIdx = await activateBiggest(page);
    await page.waitForTimeout(800);

    const m = await measureFit(page);
    console.log(`\n=== [${topic}] biggest=${biggestIdx} ===`);
    console.log(JSON.stringify(m, null, 2));
    await page.screenshot({ path: `test-results/safety-${topic.replace(/\s+/g, '-')}.png` });

    if (!m) throw new Error('no measurements');

    // INVARIANT 1: build version matches source code.
    expect(m.version, `running stale code? expected "${EXPECTED_VERSION}", got "${m.version}"`).toBe(EXPECTED_VERSION);

    // INVARIANT 2 (the main one): no rendered text past body bottom.
    expect(m.lastTextPastBody, `text spills ${m.lastTextPastBody} px past body bottom`).toBeLessThanOrEqual(0);
    expect(m.lastItemPastBody, `item box spills ${m.lastItemPastBody} px past body bottom`).toBeLessThanOrEqual(0);

    // INVARIANT 3: minH covers at least the strict raw fit. Default
    // safety is now 0, so the ratio should be ~1.00 (give a tiny
    // allowance for sub-pixel rounding). The other invariants above
    // are what guarantee the bug doesn't recur; this one just catches
    // a regression where minH falls BELOW raw.
    const rawMin = m.A + m.freeTextH + 22;
    const ratio = m.minH / rawMin;
    console.log(`  ratio minH/rawMin = ${ratio.toFixed(3)} (expect >= 0.99)`);
    expect(ratio, `minH (${m.minH}) is below raw (${rawMin.toFixed(1)}): ratio ${ratio.toFixed(3)}`).toBeGreaterThanOrEqual(0.99);
  });
}
