import { test, expect, type Page } from '@playwright/test';

// Longer, more varied Gemini-like content — closer to what the user
// actually sees, with bullets of differing sizes so wrapping disparity
// is real.
const VARIED_BODY = `[[Lactic acid fermentation]] is an [[anaerobic]] [[metabolic]] process that converts [[glucose]] or other six-carbon sugars into [[cellular energy]]. Occurs in [[bacteria]] like [[Lactobacillus]] and in [[animal cells]] when [[oxygen]] is limited.

- [[Biochemical pathways]]
    - [[Homolactic]]: [[pyruvate]] converted directly into two molecules of [[lactate]] by [[lactate dehydrogenase]] in a single regenerative step that recovers [[NAD+]]
    - [[Heterolactic]]: produces [[lactate]], [[ethanol]], and [[carbon dioxide]] via the [[pentose phosphate pathway]] instead of standard [[glycolysis]]
    - [[Glycolysis]]: ten-step pathway breaks [[glucose]] into two [[pyruvate]] molecules
    - [[NAD+ regeneration]]: critical for sustaining [[ATP]] production
- [[Organisms]]
    - [[Lactobacillus]]: a genus of [[Gram-positive]] bacteria
    - [[Streptococcus]]: another lactic acid bacterium used in [[yogurt]]
- [[Applications]]
    - [[Dairy]]: [[yogurt]], [[cheese]], [[kefir]]
    - [[Fermented vegetables]]: [[sauerkraut]], [[kimchi]], [[pickles]]
    - [[Industry]]: [[bioplastics]], [[silage]], [[medicine]]`;

async function setup(page: Page) {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
    });
  });
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { content: VARIED_BODY } }] })}\n\n` +
      `data: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
}

async function onboardAndSubmit(page: Page, topic: string) {
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

async function diagnose(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!body) return null;
    const root = body.querySelector('.sc-ab-root') as HTMLElement | null;
    const ft = body.querySelector(".sc-ab-root > .sc-ab-freetext") as HTMLElement | null;
    const items = Array.from(body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item'));
    const bodyRect = body.getBoundingClientRect();
    const rootRect = root?.getBoundingClientRect();
    const ftRect = ft?.getBoundingClientRect();
    const itemHeights = items.map(it => Math.round(it.getBoundingClientRect().height));
    const sumItems = itemHeights.reduce((a, b) => a + b, 0);
    const freeH = ftRect ? Math.round(ftRect.height) : 0;
    return {
      bodyHeight: Math.round(bodyRect.height),
      rootHeight: rootRect ? Math.round(rootRect.height) : 0,
      contentHeight: Math.round(body.scrollHeight),
      bodyInlineH: body.style.height,
      freeTextHeight: freeH,
      itemHeights,
      sumItems,
      // Inferred gap: body minus everything visible
      verticalPadding: 24, // matches AdaptiveBullets.VERTICAL_PADDING
      computedGap: Math.round(bodyRect.height - freeH - sumItems - 24),
      items: items.map((it) => ({
        title: it.querySelector('.sc-ab-title-text')?.textContent ?? '',
        described: it.querySelectorAll('.sc-ab-described').length,
        hasInline: it.querySelector('.sc-ab-inline') !== null,
        isActive: it.classList.contains('is-active'),
        height: Math.round(it.getBoundingClientRect().height),
      })),
    };
  });
}

test('diagnostic: measure empty-space gap at spawn + after resize wider', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const fresh = await diagnose(page);
  console.log('FRESH SPAWN', JSON.stringify(fresh, null, 2));

  // Resize node wider — more horizontal room → cascade should fill with
  // promotions, not leave empty space.
  await page.evaluate(() => {
    const node = document.querySelector('.node') as HTMLElement | null;
    if (node) node.style.width = '900px';
  });
  await page.waitForTimeout(800);
  const wider = await diagnose(page);
  console.log('AFTER WIDEN TO 900px', JSON.stringify(wider, null, 2));

  // Resize body taller — even more room.
  await page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (body) body.style.height = '600px';
  });
  await page.waitForTimeout(800);
  const taller = await diagnose(page);
  console.log('AFTER BODY = 600px', JSON.stringify(taller, null, 2));

  // Don't assert hard — this is diagnostic.
  expect(fresh).not.toBeNull();
});
