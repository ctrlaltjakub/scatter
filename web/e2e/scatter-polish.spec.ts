import { expect, test, type Locator, type Page } from '@playwright/test';

const LONG_TITLE =
  'A deliberately wrapping two-line header used to verify that edit mode preserves the node geometry';

async function selectAndPinFirstNode(page: Page): Promise<Locator> {
  const node = page.locator('[data-node-id]').first();
  await expect(node).toBeVisible({ timeout: 15_000 });
  // Sandbox bodies remain in physics motion until pinned, so dispatch these
  // setup clicks through the DOM instead of waiting for Playwright's
  // actionability stability window.
  await node.evaluate((el: HTMLElement) => el.click());
  await expect(page.locator('.side-panel')).toBeVisible();
  await node.getByRole('button', { name: 'Pin node' }).evaluate((el: HTMLElement) => el.click());
  await expect(node.getByRole('button', { name: 'Unpin node' })).toBeVisible();
  return node;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/sandbox');
});

test('header editor keeps a wrapping title card within one pixel', async ({ page }) => {
  const node = await selectAndPinFirstNode(page);
  const panel = page.locator('.side-panel');

  // First create a title that genuinely occupies multiple visual lines.
  await panel.getByRole('button', { name: 'Edit header' }).evaluate((el: HTMLElement) => el.click());
  await node.getByRole('textbox', { name: 'Edit header' }).fill(LONG_TITLE);
  await node.getByRole('button', { name: 'Save' }).evaluate((el: HTMLElement) => el.click());
  await expect(node.getByRole('textbox', { name: 'Edit header' })).toBeHidden();
  await expect(node.locator('.node-title')).toHaveText(LONG_TITLE);
  await page.waitForTimeout(450);

  const before = await node.boundingBox();
  expect(before).not.toBeNull();

  await panel.getByRole('button', { name: 'Edit header' }).evaluate((el: HTMLElement) => el.click());
  const editor = node.getByRole('textbox', { name: 'Edit header' });
  await expect(editor).toBeVisible();
  await expect(node.getByRole('button', { name: 'Save' })).toBeVisible();
  await expect(node.getByRole('button', { name: 'Regenerate' })).toBeVisible();
  await expect(node.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

  const after = await node.boundingBox();
  expect(after).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(after![key] - before![key]), key).toBeLessThanOrEqual(1);
  }
});

test('scrollbar remains aligned while smooth zoom is still live', async ({ page }) => {
  const node = await selectAndPinFirstNode(page);
  const body = node.locator('.node-body');
  const anchor = body.locator('[data-sc-anchor="ft"]');
  const bar = body.locator('.node-scrollbar-bar');
  await expect(anchor).toBeVisible();
  await expect(bar).toBeVisible();
  await page.waitForTimeout(500);

  const error = async () => page.evaluate(() => {
    const bodyEl = document.querySelector('[data-node-id] .node-body');
    const anchorEl = bodyEl?.querySelector('[data-sc-anchor="ft"]');
    const barEl = bodyEl?.querySelector('.node-scrollbar-bar');
    if (!(anchorEl instanceof HTMLElement) || !(barEl instanceof HTMLElement)) return null;
    const anchorRect = anchorEl.getBoundingClientRect();
    const barRect = barEl.getBoundingClientRect();
    return {
      top: Math.abs(anchorRect.top - barRect.top),
      height: Math.abs(anchorRect.height - barRect.height),
    };
  });

  const initial = await error();
  expect(initial).not.toBeNull();
  expect(initial!.top).toBeLessThanOrEqual(1.5);
  expect(initial!.height).toBeLessThanOrEqual(1.5);

  await page.getByRole('button', { name: 'Zoom in' }).evaluate((el: HTMLElement) => el.click());
  // Sample in the middle of the 140 ms animation, before persisted viewport
  // catches up with the live camera store.
  await page.waitForTimeout(55);
  const during = await error();
  expect(during).not.toBeNull();
  expect(during!.top).toBeLessThanOrEqual(1.5);
  expect(during!.height).toBeLessThanOrEqual(1.5);

  await page.waitForTimeout(180);
  const settled = await error();
  expect(settled).not.toBeNull();
  expect(settled!.top).toBeLessThanOrEqual(1.5);
  expect(settled!.height).toBeLessThanOrEqual(1.5);
});
