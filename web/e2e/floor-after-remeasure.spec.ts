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
    return {
      nodeWidthPx: Math.round(node.getBoundingClientRect().width),
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyInlineH: body.style.height,
      isOverflowing: body.scrollHeight > body.clientHeight + 1,
      overflowAmount: Math.max(0, body.scrollHeight - body.clientHeight),
      minBodyHeight: Number(body.getAttribute('data-sc-min-body')) || null,
      activeIdx: items.findIndex((it) => it.classList.contains('is-active')),
      itemHeights: items.map((it) => Math.round(it.getBoundingClientRect().height)),
    };
  });
}

async function dragResizeHandle(
  page: Page,
  corner: 'tl' | 'tr' | 'bl' | 'br',
  dx: number,
  dy: number,
  steps = 12,
) {
  const handle = page.locator(`.node-resize.${corner}`).first();
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  if (!box) throw new Error('handle not found');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
}

test('after widen → re-measure → shrink back, floor is honored on subsequent activate', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'photosynthesis');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const initial = await snapshot(page);
  console.log('INITIAL', JSON.stringify(initial, null, 2));
  const initialMin = initial!.minBodyHeight!;

  // Step 1: widen the node. Per the v5-hidden-freetext fix, minH is
  // computed at MEASURE_WIDTH regardless of current node width — so
  // widening should NOT change minBodyHeight. That's deliberate: the
  // bug we were chasing was caused by minH varying with width.
  await dragResizeHandle(page, 'br', 900, 0);
  await page.waitForTimeout(500);

  const afterWiden = await snapshot(page);
  console.log('AFTER WIDEN + REMEASURE', JSON.stringify(afterWiden, null, 2));
  const wideMin = afterWiden!.minBodyHeight!;
  expect(wideMin).toBe(initialMin); // minH is now width-invariant

  // Step 2: shrink BOTH width and height back via BR handle moving NW.
  // dy is the wide-state minimum minus current height — drag past it,
  // expecting handle to clamp at wide-state min.
  await dragResizeHandle(page, 'br', -900, -1500);
  await page.waitForTimeout(500); // wait for re-measure to settle at narrow width

  const afterShrink = await snapshot(page);
  console.log('AFTER SHRINK + REMEASURE', JSON.stringify(afterShrink, null, 2));

  // The minimum should now be back to the narrow value (~initial).
  expect(afterShrink!.minBodyHeight).toBeGreaterThanOrEqual(initialMin - 5);

  // Critical: body height must be ≥ minBodyHeight. If user shrank below
  // the new minimum during the drag (before re-measure fired), the bump
  // should have grown the body back up.
  expect(afterShrink!.bodyHeight).toBeGreaterThanOrEqual(afterShrink!.minBodyHeight!);
  expect(afterShrink!.isOverflowing).toBe(false);

  // Step 3: activate the longest bullet. Should fit.
  await page.evaluate(() => {
    const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[0];
    if (item) item.click();
  });
  await page.waitForTimeout(400);

  const afterActivate = await snapshot(page);
  console.log('AFTER ACTIVATE LONGEST', JSON.stringify(afterActivate, null, 2));
  // With the 40% safety margin, the longest bullet may already be at
  // max in cascade-fit state. Clicking it is a no-op (handler returns
  // null to deactivate an already-max bullet). The thing that matters
  // is that no overflow happens regardless.
  expect(afterActivate!.isOverflowing).toBe(false);
});

test('repro: shrink-during-stale-min lets user shrink below true minimum, click activates → overflow', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'photosynthesis');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  // Widen so re-measure produces a SMALLER minBodyHeight.
  await dragResizeHandle(page, 'br', 900, 0);
  await page.waitForTimeout(500);

  const afterWiden = await snapshot(page);
  console.log('AFTER WIDEN', JSON.stringify(afterWiden, null, 2));

  // Now narrow + shrink body using BR drag, but DON'T wait 500ms — fire
  // an activation click immediately, before the re-measure debounce (200 ms)
  // has had time to bump bodyMaxHeight back up.
  await dragResizeHandle(page, 'br', -900, -1500);
  // No waitForTimeout — race.

  // Click longest bullet immediately.
  await page.evaluate(() => {
    const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[0];
    if (item) item.click();
  });

  // Take an immediate snapshot before re-measure has time to fire.
  const immediate = await snapshot(page);
  console.log('IMMEDIATELY AFTER SHRINK + ACTIVATE', JSON.stringify(immediate, null, 2));

  // Now wait for re-measure to settle and see what eventual state is.
  await page.waitForTimeout(600);
  const settled = await snapshot(page);
  console.log('AFTER SETTLE', JSON.stringify(settled, null, 2));

  // Regression guard: without immediate (non-debounced) re-measurement,
  // the body would still be at the stale wide-state minimum here and
  // activating the longest bullet would overflow. With the fix, body
  // tracks the current width's minimum continuously and an activation
  // race never sees a cut.
  expect(immediate?.isOverflowing).toBe(false);
  expect(settled?.isOverflowing).toBe(false);
});
