import { test, expect, type Page } from '@playwright/test';

/* Verifies the in-canvas search highlight: typing a query lights up the
 * matched characters inside node text via the CSS Custom Highlight API. */

async function onboardAndSubmitTopic(page: Page, topic: string) {
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('search highlights the matched phrase inside node text', async ({ page }) => {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
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
    const md =
      'Lactic fermentation produces energy.\n\n' +
      '- Pathways\n' +
      '  - Glycolysis: breaks down glucose molecules\n' +
      '  - Krebs cycle: releases zebraword carbon dioxide';
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { content: md } }] })}\n\n` +
      `data: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/');
  await onboardAndSubmitTopic(page, 'fermentation');

  // Streamed body text rendered into a node.
  await expect(page.locator('.node-body').first()).toContainText('fermentation', {
    timeout: 15000,
  });

  // The API must be available in this (Chromium) browser.
  const supported = await page.evaluate(
    () =>
      typeof (window as unknown as { Highlight?: unknown }).Highlight !== 'undefined' &&
      !!(CSS as unknown as { highlights?: unknown }).highlights,
  );
  expect(supported, 'CSS Custom Highlight API available').toBe(true);

  const highlightSize = () =>
    page.evaluate(
      () =>
        (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get(
          'sc-search',
        )?.size ?? 0,
    );

  // Typing a matching query (freetext) populates the 'sc-search' highlight.
  await page.locator('.search-input').fill('fermentation');
  await expect.poll(highlightSize, { timeout: 5000 }).toBeGreaterThan(0);

  // Clearing the query removes the highlight (and any markers).
  await page.locator('.search-input').fill('');
  await expect.poll(highlightSize).toBe(0);
  await expect(page.locator('.sc-bullet-marker')).toHaveCount(0);
});
