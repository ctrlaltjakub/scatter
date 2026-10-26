import { test, expect, type Page } from '@playwright/test';

const WRAPPING_BODY = `[[Photosynthesis]] is a complex multi-stage [[biochemical process]] used by [[plants]], [[algae]], and certain [[bacteria]] to convert [[light energy]] from the sun into [[chemical energy]] stored in [[glucose molecules]] and other [[organic compounds]] essential for cellular respiration.

- [[Light-dependent reactions occurring in the thylakoid membranes of chloroplast organelles]]
    - [[Photosystem II]]: absorbs light at [[680 nm]] and splits [[water molecules]] into [[oxygen]], [[protons]], and [[electrons]] via the [[oxygen-evolving complex]]
    - [[Photosystem I]]: absorbs light at [[700 nm]] and re-energizes electrons that pass through the [[electron transport chain]] to form [[NADPH]]
    - [[ATP synthase]]: uses the [[proton gradient]] to phosphorylate [[ADP]] into [[ATP]] via [[chemiosmosis]]
    - [[Cytochrome b6f]]: pumps protons across the membrane while transferring electrons
- [[Carbon-fixation reactions of the Calvin-Benson cycle in the chloroplast stroma matrix]]
    - [[Carboxylation]]: [[RuBisCO]] attaches [[CO2]] to [[ribulose-1,5-bisphosphate]] to form a [[6-carbon intermediate]]
    - [[Reduction]]: [[ATP]] and [[NADPH]] reduce [[3-phosphoglycerate]] into [[glyceraldehyde-3-phosphate]] (G3P)
    - [[Regeneration]]: remaining G3P molecules regenerate [[RuBP]] in a series of [[ATP]]-driven rearrangements
- [[Photorespiration and oxidative side-reactions limiting net carbon assimilation]]
    - [[Oxygenase activity]]: [[RuBisCO]] sometimes reacts with [[O2]] instead of [[CO2]]
    - [[Glycolate pathway]]: salvages carbon from [[2-phosphoglycolate]] back into the [[Calvin cycle]]`;

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
        `data: ${JSON.stringify({ choices: [{ delta: { content: WRAPPING_BODY } }] })}\n\n` +
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

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!body) return null;
    const items = Array.from(body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item'));
    return {
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      isOverflowing: body.scrollHeight > body.clientHeight + 1,
      overflowAmount: Math.max(0, body.scrollHeight - body.clientHeight),
      minBodyHeight: Number(body.getAttribute('data-sc-min-body')) || null,
      activeIdx: items.findIndex((it) => it.classList.contains('is-active')),
      itemHeights: items.map((it) => Math.round(it.getBoundingClientRect().height)),
    };
  });
}

test('fresh-spawn: activating EACH bullet must not overflow', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'photosynthesis');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const initial = await snapshot(page);
  console.log('INITIAL', JSON.stringify(initial, null, 2));

  const count = initial?.itemHeights.length ?? 0;
  for (let i = 0; i < count; i++) {
    // Deactivate first by clicking free-text.
    await page.evaluate(() => {
      const ft = document.querySelector<HTMLElement>(".sc-ab-root > .sc-ab-freetext");
      ft?.click();
    });
    await page.waitForTimeout(150);
    // Activate bullet i directly via item click (not chip).
    await page.evaluate((idx) => {
      const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[idx];
      if (item) item.click();
    }, i);
    await page.waitForTimeout(200);
    const s = await snapshot(page);
    console.log(`AFTER ACTIVATE bullet ${i}`, JSON.stringify(s, null, 2));
    expect(s?.isOverflowing, `bullet ${i} should not overflow`).toBe(false);
  }
});
