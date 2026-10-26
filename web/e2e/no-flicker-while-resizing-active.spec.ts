import { test, expect, type Page } from '@playwright/test';

const BODY = `[[Photosynthesis]] is a complex multi-stage [[biochemical process]] used by [[plants]], [[algae]], and certain [[bacteria]] to convert [[light energy]] into [[chemical energy]].

- [[Light-dependent reactions occurring in the thylakoid membranes of chloroplast organelles]]
    - [[Photosystem II]]: absorbs light at [[680 nm]] and splits [[water molecules]] into [[oxygen]], [[protons]], and [[electrons]]
    - [[Photosystem I]]: absorbs light at [[700 nm]] and re-energizes electrons
    - [[ATP synthase]]: uses the [[proton gradient]] to phosphorylate [[ADP]] into [[ATP]]
    - [[Cytochrome b6f]]: pumps protons across the membrane
- [[Carbon-fixation reactions of the Calvin-Benson cycle]]
    - [[Carboxylation]]: [[RuBisCO]] attaches [[CO2]] to [[ribulose-1,5-bisphosphate]]
    - [[Reduction]]: [[ATP]] and [[NADPH]] reduce [[3-phosphoglycerate]]
    - [[Regeneration]]: G3P regenerates [[RuBP]]
- [[Photorespiration and oxidative side-reactions]]
    - [[Oxygenase activity]]: [[RuBisCO]] reacts with [[O2]]
    - [[Glycolate pathway]]: salvages carbon`;

async function setup(page: Page) {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
  await page.route('https://api.openai.com/v1/models', async (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock-model' }] }) }));
  await page.route('https://api.openai.com/v1/chat/completions', async (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: BODY } }] })}\n\n` +
        `data: [DONE]\n\n`,
    }));
}

async function onboardAndSubmit(page: Page, topic: string) {
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('active bullet stays expanded throughout a resize drag (no flicker)', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'photosynthesis');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  // Activate the longest bullet.
  await page.evaluate(() => {
    const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[0];
    if (item) item.click();
  });
  await page.waitForTimeout(300);

  const beforeResize = await page.evaluate(() => {
    const items = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
    return {
      activeIdx: Array.from(items).findIndex((it) => it.classList.contains('is-active')),
      activeHeight: items[0] ? Math.round(items[0].getBoundingClientRect().height) : 0,
      isExpanded: items[0]?.getAttribute('aria-expanded') === 'true',
    };
  });
  console.log('BEFORE RESIZE', JSON.stringify(beforeResize));
  expect(beforeResize.activeIdx).toBe(0);
  expect(beforeResize.isExpanded).toBe(true);

  // Drag BR handle in many fine increments. During the drag, sample
  // the active bullet's expanded state and height multiple times.
  const handle = page.locator('.node-resize.br').first();
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();

  const samples: Array<{ tick: number; isExpanded: boolean; activeHeight: number; activeIdx: number }> = [];
  const totalSteps = 30;
  for (let i = 1; i <= totalSteps; i++) {
    await page.mouse.move(startX + i * 30, startY + i * 10);
    await page.waitForTimeout(20);
    const s = await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item');
      return {
        activeIdx: Array.from(items).findIndex((it) => it.classList.contains('is-active')),
        activeHeight: items[0] ? Math.round(items[0].getBoundingClientRect().height) : 0,
        isExpanded: items[0]?.getAttribute('aria-expanded') === 'true',
      };
    });
    samples.push({ tick: i, ...s });
  }
  await page.mouse.up();

  // The active bullet must stay expanded throughout — every single sample.
  const collapsedSamples = samples.filter((s) => !s.isExpanded || s.activeIdx !== 0);
  console.log('Samples that show active bullet COLLAPSED during drag:', collapsedSamples.length, 'of', samples.length);
  if (collapsedSamples.length > 0) {
    console.log('First collapsed sample:', JSON.stringify(collapsedSamples[0]));
  }
  expect(collapsedSamples).toEqual([]);
});
