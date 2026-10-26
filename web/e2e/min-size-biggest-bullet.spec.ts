import { test, expect, type Page } from '@playwright/test';

// SKIPPED (backend-free migration): this is a LIVE-Gemini integration test — it
// hits the real Gemini API, which only worked through the old /api/proxy relay.
// That relay was removed (browsers can't call Gemini directly — CORS), so this
// can't run backend-free. To re-enable, convert onboarding to a mocked provider
// (see e2e/search-highlight.spec.ts) or route via OpenRouter.
test.beforeEach(() => { test.skip(true, 'live-Gemini test needs a backend proxy (removed); convert to a mock'); });

// User-reported bug: generate a node for "psychoanalysis" or "lactic
// fermentation", shrink to smallest allowed size, expand biggest bullet
// — text gets cut. User: "the bug happens every time i generate first
// node with a prompt 'psychoanalysis' or 'lactic fermentation'".

const GEMINI_KEY = process.env.SCATTER_GEMINI_TEST_KEY ?? '';
test.skip(!GEMINI_KEY, 'Set SCATTER_GEMINI_TEST_KEY to opt into this live-provider test.');

const TOPICS = ['psychoanalysis', 'lactic fermentation'];
const REPEATS = 3; // run each topic this many times — Gemini varies per call

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

async function onboardGemini(page: Page) {
  await page.locator('#sc-provider').selectOption({ value: 'gemini' });
  await page.locator('#sc-key').fill(GEMINI_KEY);
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible({ timeout: 15000 });
}

async function submitTopic(page: Page, topic: string) {
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

async function waitForStreamComplete(page: Page) {
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => {
    const cursor = document.querySelector('.node-body[data-sc-mode="adaptive"] .cursor');
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    const minSet = body && (body.getAttribute('data-sc-min-body') ?? '').length > 0;
    return !cursor && minSet;
  }, { timeout: 60000 });
  await page.waitForTimeout(1500);
}

async function shrinkToMinimum(page: Page) {
  const handle = page.locator('.node-resize.br').first();
  const box = await handle.boundingBox();
  if (!box) throw new Error('br handle not found');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(startX - 100, startY - 100);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

async function fullSnapshot(page: Page) {
  return page.evaluate(() => {
    const node = document.querySelector('.node') as HTMLElement | null;
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!node || !body) return null;
    const root = body.querySelector('.sc-ab-root') as HTMLElement | null;
    const ft = body.querySelector(".sc-ab-root > .sc-ab-freetext") as HTMLElement | null;
    const V = [...body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')];
    const HX = [...body.querySelectorAll<HTMLElement>('.sc-ab-measure > ul:nth-of-type(1) > .sc-ab-item')];
    const H0 = [...body.querySelectorAll<HTMLElement>('.sc-ab-measure > ul:nth-of-type(2) > .sc-ab-item')];
    const dump = (it: HTMLElement) => ({
      h: +it.getBoundingClientRect().height.toFixed(1),
      desc: it.querySelectorAll('.sc-ab-described').length,
      inline: !!it.querySelector('.sc-ab-inline'),
      active: it.classList.contains('is-active'),
    });
    return {
      nodeW: Math.round(node.getBoundingClientRect().width),
      bodyH: body.clientHeight,
      bodyScrollH: body.scrollHeight,
      rootW: root?.clientWidth,
      freetextH: +(ft?.getBoundingClientRect().height.toFixed(1) ?? 0),
      minH: body.getAttribute('data-sc-min-body'),
      overflowing: body.scrollHeight > body.clientHeight + 1,
      overflowPx: Math.max(0, body.scrollHeight - body.clientHeight),
      visible: V.map(dump),
      hiddenMax: HX.map(dump),
      hiddenM0: H0.map(dump),
      visibleSum: +V.reduce((s, it) => s + it.getBoundingClientRect().height, 0).toFixed(1),
      measureContainerWidth: (body.querySelector('.sc-ab-measure') as HTMLElement | null)?.style.width,
    };
  });
}

async function activateBullet(page: Page, idx: number) {
  await page.evaluate(() => {
    const ft = document.querySelector<HTMLElement>(".sc-ab-root > .sc-ab-freetext");
    ft?.click();
  });
  await page.waitForTimeout(150);
  await page.evaluate((i) => {
    const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[i];
    if (item) item.click();
  }, idx);
  await page.waitForTimeout(400);
}

for (const topic of TOPICS) {
  for (let attempt = 1; attempt <= REPEATS; attempt++) {
    test(`[run ${attempt}] '${topic}': shrink to min + activate every bullet — no overflow`, async ({ page }) => {
      test.setTimeout(180000);
      await clearOpfs(page);
      await page.goto('/');
      await onboardGemini(page);
      await submitTopic(page, topic);
      await waitForStreamComplete(page);

      const initial = await fullSnapshot(page);
      console.log(`\n[${topic} #${attempt}] INITIAL nodeW=${initial?.nodeW} bodyH=${initial?.bodyH} minH=${initial?.minH} bullets=${initial?.visible.length} measureW=${initial?.measureContainerWidth} hiddenMaxHeights=${JSON.stringify(initial?.hiddenMax.map(b => b.h))}`);
      expect(initial).not.toBeNull();
      expect(initial!.visible.length).toBeGreaterThan(0);

      await shrinkToMinimum(page);
      const shrunk = await fullSnapshot(page);
      console.log(`[${topic} #${attempt}] SHRUNK nodeW=${shrunk?.nodeW} bodyH=${shrunk?.bodyH} minH=${shrunk?.minH} freetext=${shrunk?.freetextH} visibleSum=${shrunk?.visibleSum} overflow=${shrunk?.overflowPx}`);
      expect(shrunk!.overflowing, `body overflowed at shrink-to-minimum on '${topic}' run ${attempt}`).toBe(false);

      // Activate EVERY bullet, not just biggest — the user's flow is "expand
      // a bullet", and any of them could be the one they click.
      const bulletCount = shrunk!.visible.length;
      for (let i = 0; i < bulletCount; i++) {
        await activateBullet(page, i);
        const s = await fullSnapshot(page);
        const desc = s?.visible[i]?.desc;
        console.log(`  [${topic} #${attempt}] Activate ${i} (full=${s?.hiddenMax[i]?.h}): bodyH=${s?.bodyH} sum=${s?.visibleSum} overflow=${s?.overflowPx} visibleH[${i}]=${s?.visible[i]?.h} desc=${desc}`);
        if (s?.overflowing) {
          console.log(`  *** BUG: overflow ${s.overflowPx} px on '${topic}' #${attempt} bullet ${i} ***`);
          console.log(`  ALL VISIBLE:`, JSON.stringify(s.visible, null, 2));
          console.log(`  ALL HIDDEN_MAX:`, JSON.stringify(s.hiddenMax, null, 2));
          console.log(`  ALL HIDDEN_M0:`, JSON.stringify(s.hiddenM0, null, 2));
        }
        expect(s?.overflowing, `'${topic}' run ${attempt} bullet ${i} overflowed`).toBe(false);
      }
    });
  }
}
