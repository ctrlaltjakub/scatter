import { test, expect, type Page } from '@playwright/test';

const BULLET_BODY = [
  'Lactic fermentation converts [[glucose]] to [[lactic acid]] without oxygen.',
  '',
  '- Process steps',
  '  - Substrate: [[glucose]] from carbohydrates',
  '  - Enzyme: [[lactate dehydrogenase]] catalyzes the reaction',
  '  - Products: [[lactic acid]] and regenerated NAD+',
  '  - Yield: about 2 [[ATP]] per molecule',
  '- Conditions',
  '  - Anaerobic: occurs when [[oxygen]] is limited',
  '  - Substrate: [[glycolysis]] intermediates required',
  '  - Cells: [[fast-twitch fibers]] during sprints',
  '  - pH: optimal around 6 to 7',
  '- Applications',
  '  - Food: [[yogurt]], [[sauerkraut]], [[kimchi]]',
  '  - Industry: [[bioplastics]] and lactic acid polymers',
  '  - Medicine: [[wound healing]] research',
  '  - Agriculture: [[silage]] preservation',
].join('\n');

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
      `data: ${JSON.stringify({ choices: [{ delta: { content: BULLET_BODY } }] })}\n\n` +
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

/** Snapshot every bullet's mode-relevant info: how many described rows, has inline group, is-active. */
async function captureBulletState(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    const items = Array.from(body?.querySelectorAll('.sc-ab-root > .sc-ab-list > .sc-ab-item') ?? []);
    return {
      bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0,
      bodyInlineH: body?.style.height ?? '',
      items: items.map((it) => ({
        isActive: it.classList.contains('is-active'),
        describedCount: it.querySelectorAll('.sc-ab-described').length,
        hasInlineGroup: it.querySelector('.sc-ab-inline') !== null,
        titleText: it.querySelector('.sc-ab-title-text')?.textContent ?? '',
        heightPx: Math.round((it as HTMLElement).getBoundingClientRect().height),
      })),
    };
  });
}

test('clicking a bullet visibly changes the cascade modes', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');

  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  // Wait for ResizeObserver to settle on a stable post-init layout.
  await page.waitForTimeout(400);

  const before = await captureBulletState(page);
  console.log('BEFORE click:', JSON.stringify(before, null, 2));
  expect(before.items.length).toBe(3);

  // Click first bullet via JS to bypass canvas selection layer.
  await page.evaluate(() => {
    const first = document.querySelector('.node-body[data-sc-mode="adaptive"] .sc-ab-root > .sc-ab-list > .sc-ab-item') as HTMLElement | null;
    first?.click();
  });
  await page.waitForTimeout(200);

  const after = await captureBulletState(page);
  console.log('AFTER click:', JSON.stringify(after, null, 2));

  // The state must visibly change. Either the active flag changes or mode
  // distribution does. If neither: cascade is broken (the user's complaint).
  const flagChanged = before.items.some((b, i) => b.isActive !== after.items[i]!.isActive);
  const modesChanged = before.items.some(
    (b, i) =>
      b.describedCount !== after.items[i]!.describedCount ||
      b.hasInlineGroup !== after.items[i]!.hasInlineGroup ||
      Math.abs(b.heightPx - after.items[i]!.heightPx) > 2,
  );
  expect(flagChanged || modesChanged).toBe(true);
});

test('resizing the node body re-runs the cascade', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'fermentation');

  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(400);

  const before = await captureBulletState(page);
  console.log('BEFORE resize:', JSON.stringify(before, null, 2));

  // Forcibly shrink the body via direct style mutation — must be SMALLER
  // than the initial all-M1 size so it actually shrinks. Initial is around
  // sum(M1) + freeText + padding for these 3 bullets ≈ 200px; halving it
  // forces real demotion.
  const targetShrunk = Math.max(80, Math.floor(before.bodyH / 2));
  await page.evaluate((h) => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (body) body.style.height = `${h}px`;
  }, targetShrunk);
  await page.waitForTimeout(400);

  const after = await captureBulletState(page);
  console.log(`AFTER shrink to ${targetShrunk}px:`, JSON.stringify(after, null, 2));

  const modesChanged = before.items.some(
    (b, i) =>
      b.describedCount !== after.items[i]!.describedCount ||
      b.hasInlineGroup !== after.items[i]!.hasInlineGroup ||
      Math.abs(b.heightPx - after.items[i]!.heightPx) > 2,
  );
  expect(modesChanged).toBe(true);
});
