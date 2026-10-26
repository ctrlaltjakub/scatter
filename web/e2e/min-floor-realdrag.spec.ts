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
      `data: ${JSON.stringify({ choices: [{ delta: { content: WRAPPING_BODY } }] })}\n\n` +
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
    const node = document.querySelector('.node') as HTMLElement | null;
    const body = node?.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!body || !node) return null;
    const items = Array.from(body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item'));
    const ft = body.querySelector(".sc-ab-root > .sc-ab-freetext") as HTMLElement | null;
    return {
      nodeWidthPx: Math.round(node.getBoundingClientRect().width),
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyInlineH: body.style.height,
      contentScrollH: Math.round(body.scrollHeight),
      isOverflowing: body.scrollHeight > body.clientHeight + 1,
      overflowAmount: Math.max(0, body.scrollHeight - body.clientHeight),
      freeTextHeight: ft ? Math.round(ft.getBoundingClientRect().height) : 0,
      itemHeights: items.map((it) => Math.round(it.getBoundingClientRect().height)),
      sumItems: items.reduce((s, it) => s + Math.round(it.getBoundingClientRect().height), 0),
      minBodyHeight: Number(body.getAttribute('data-sc-min-body')) || null,
      activeIdx: items.findIndex((it) => it.classList.contains('is-active')),
    };
  });
}

async function dragResizeHandle(
  page: Page,
  corner: 'tl' | 'tr' | 'bl' | 'br',
  dx: number,
  dy: number,
) {
  const handle = page.locator(`.node-resize.${corner}`).first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle not found');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Move in steps so pointermove fires multiple times with smooth deltas.
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

test('user flow: widen+grow → shrink width back, then shrink body to floor (real drags)', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'photosynthesis');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const fresh = await snapshot(page);
  console.log('FRESH', JSON.stringify(fresh, null, 2));

  // Step 1: widen to ~1500 + grow body using BR handle.
  await dragResizeHandle(page, 'br', 900, 500);
  const wide = await snapshot(page);
  console.log('AFTER GROW (br +900,+500)', JSON.stringify(wide, null, 2));

  // Step 2: shrink width back to near minimum using BR handle (drag left).
  // This shrinks width but keeps body height tall.
  await dragResizeHandle(page, 'br', -900, 0);
  const narrow = await snapshot(page);
  console.log('AFTER NARROW (br -900,0)', JSON.stringify(narrow, null, 2));

  // Step 3: shrink body height to floor using BR handle (drag up far).
  // Resize handle should clamp at minBodyHeight.
  await dragResizeHandle(page, 'br', 0, -1500);
  const floored = await snapshot(page);
  console.log('AFTER SHRINK BODY TO FLOOR (br 0,-1500)', JSON.stringify(floored, null, 2));

  // Activate the longest bullet by dispatching a click whose target IS the
  // item (not a chip inside it). page.locator.click() targets the chip
  // because the title is one big [[reference]], which the click handler
  // filters out with closest('.ref-chip').
  await page.evaluate(() => {
    const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[0];
    if (item) item.click();
  });
  await page.waitForTimeout(400);
  const activated = await snapshot(page);
  console.log('AFTER CLICK LONGEST BULLET', JSON.stringify(activated, null, 2));

  // The whole point: at the floor, content must NOT be cut off.
  expect(floored?.isOverflowing).toBe(false);
  expect(activated?.isOverflowing).toBe(false);
});
