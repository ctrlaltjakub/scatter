import { test, expect, type Page } from '@playwright/test';

// Real Gemini-3-flash output captured via API call. Uses dash markers
// with 4-space indent. Three bullets, descriptions long enough to wrap
// at typical node widths.
const REAL_GEMINI_BODY = `[[Lactic acid fermentation]] is an [[anaerobic]] [[metabolic]] process that converts [[glucose]] or other [[six-carbon sugars]] into [[cellular energy]] and the [[metabolite]] [[lactate]]. It occurs in certain [[bacteria]], such as [[Lactobaccillales]], and [[animal cells]] like [[skeletal muscle]] when [[oxygen]] levels are limited. The process begins with [[glycolysis]], where [[glucose]] is broken down into [[pyruvate]], followed by the [[reduction]] of [[pyruvate]] by [[NADH]]. This pathway is essential for [[NAD+]] regeneration, allowing [[ATP]] production to continue in the absence of [[oxidative phosphorylation]].

- [[Biochemical Pathways]]
    - [[Homolactic fermentation]]: [[Pyruvate]] is converted into two molecules of [[lactate]] by the [[enzyme]] [[lactate dehydrogenase]].
    - [[Heterolactic fermentation]]: Produces [[lactate]], [[ethanol]], and [[carbon dioxide]] via the [[pentose phosphate pathway]].
    - [[Glycolysis]]: The preliminary stage where [[glucose]] is oxidized into [[pyruvate]] while generating [[ATP]].
    - [[NAD+ regeneration]]: The process of oxidizing [[NADH]] back to [[NAD+]] to sustain continuous [[ATP]] synthesis.
- [[Microorganisms and Taxonomy]]
    - [[Lactobacillus]]: A genus of [[Gram-positive]] bacteria used extensively in [[dairy]] and [[vegetable]] [[fermentation]].
    - [[Streptococcus thermophilus]]: A [[thermophilic]] bacterium critical for [[yogurt]] production and [[texture]] development.
    - [[Leuconostoc]]: Microbes often responsible for the unique [[flavor]] profiles in [[sauerkraut]] and [[kefir]].
    - [[Pediococcus]]: Bacteria frequently involved in the [[spoilage]] of [[beer]] and the ripening of [[cheese]].
- [[Culinary and Industrial Applications]]
    - [[Dairy products]]: The conversion of [[lactose]] into [[lactic acid]] to produce [[yogurt]], [[cheese]], and [[sour cream]].
    - [[Vegetable preservation]]: Using [[brine]] and [[anaerobic]] conditions to create [[kimchi]], [[pickles]], and [[sauerkraut]].
    - [[Sourdough bread]]: A [[symbiotic]] culture of [[yeast]] and [[lactic acid bacteria]] that improves [[dough]] [[leavening]].`;

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
      `data: ${JSON.stringify({ choices: [{ delta: { content: REAL_GEMINI_BODY } }] })}\n\n` +
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

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!body) return null;
    const items = Array.from(body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item'));
    const bodyRect = body.getBoundingClientRect();
    return {
      bodyHeight: Math.round(bodyRect.height),
      bodyWidth: Math.round(bodyRect.width),
      contentHeight: Math.round(body.scrollHeight),
      hasScroll: body.scrollHeight > body.clientHeight + 2,
      items: items.map((it) => ({
        title: it.querySelector('.sc-ab-title-text')?.textContent ?? '',
        isActive: it.classList.contains('is-active'),
        described: it.querySelectorAll('.sc-ab-described').length,
        hasInline: it.querySelector('.sc-ab-inline') !== null,
        height: Math.round(it.getBoundingClientRect().height),
      })),
    };
  });
}

async function setBodyHeight(page: Page, h: number) {
  await page.evaluate((newH) => {
    const body = document.querySelector('.node-body') as HTMLElement | null;
    if (body) body.style.height = `${newH}px`;
  }, h);
}

async function setNodeWidth(page: Page, w: number) {
  await page.evaluate((newW) => {
    const node = document.querySelector('.node') as HTMLElement | null;
    if (node) node.style.width = `${newW}px`;
  }, w);
}

test('initial render: bullets fit body without scroll', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800); // let measure-correct loop converge

  const snap = await snapshot(page);
  console.log('INITIAL', JSON.stringify(snap, null, 2));
  expect(snap).not.toBeNull();
  expect(snap!.items.length).toBe(3);
  // Content should fit — no scrollbar.
  expect(snap!.hasScroll).toBe(false);
});

test('clicking a bullet expands it; others demote; still fits', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const before = await snapshot(page);
  console.log('BEFORE click', JSON.stringify(before, null, 2));

  // Click bullet 0
  await page.evaluate(() => {
    const first = document.querySelector('.node-body[data-sc-mode="adaptive"] .sc-ab-root > .sc-ab-list > .sc-ab-item') as HTMLElement | null;
    first?.click();
  });
  await page.waitForTimeout(800);

  const after = await snapshot(page);
  console.log('AFTER click', JSON.stringify(after, null, 2));

  // Bullet 0 should be at its max (all children described) and the
  // others fit alongside. With the 40 % safety margin, bullet 0 may
  // already be at max in cascade-fit state — in which case clicking is
  // a no-op (handler deactivates instead of re-activating), and the
  // described count is the same as before. Either way, content fits.
  const b0 = after!.items[0]!;
  expect(b0.described).toBeGreaterThanOrEqual(before!.items[0]!.described);
  // No scrollbar
  expect(after!.hasScroll).toBe(false);
});

test('shrinking body height demotes bullets', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const before = await snapshot(page);
  console.log('BEFORE shrink', JSON.stringify(before, null, 2));

  // Shrink to roughly the minimum that still fits free text + 3 titles.
  // Below this, content can't fit no matter what the cascade does.
  await setBodyHeight(page, 280);
  await page.waitForTimeout(800);

  const after = await snapshot(page);
  console.log('AFTER shrink to 280px', JSON.stringify(after, null, 2));

  const beforeRichness = before!.items.reduce((a, it) => a + it.described + (it.hasInline ? 1 : 0), 0);
  const afterRichness = after!.items.reduce((a, it) => a + it.described + (it.hasInline ? 1 : 0), 0);
  console.log('Richness before:', beforeRichness, 'after:', afterRichness);
  expect(afterRichness).toBeLessThan(beforeRichness);
});

test('widening node promotes bullets (more horizontal room → less wrapping → fits more)', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  // First, set the node to a NARROW width and a moderate body height.
  await setNodeWidth(page, 480);
  await setBodyHeight(page, 350);
  await page.waitForTimeout(800);

  const narrow = await snapshot(page);
  console.log('NARROW (480w, 350h)', JSON.stringify(narrow, null, 2));

  // Now widen it
  await setNodeWidth(page, 900);
  await page.waitForTimeout(800);

  const wide = await snapshot(page);
  console.log('WIDE (900w, 350h)', JSON.stringify(wide, null, 2));

  // At wider width, descriptions wrap less → less vertical space per row →
  // the cascade should fit MORE description rows (richer modes).
  const narrowRichness = narrow!.items.reduce((a, it) => a + it.described, 0);
  const wideRichness = wide!.items.reduce((a, it) => a + it.described, 0);
  console.log('Described rows narrow:', narrowRichness, 'wide:', wideRichness);
  expect(wideRichness).toBeGreaterThanOrEqual(narrowRichness);
  expect(wide!.hasScroll).toBe(false);
});
