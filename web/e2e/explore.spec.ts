import { test, expect, type Page } from '@playwright/test';

/**
 * Helper: complete Welcome A (fill API key + click "Connect & continue"),
 * wait for Welcome B to appear, then fill and submit the topic.
 * After this, the canvas is showing with a root node being generated.
 */
async function onboardAndSubmitTopic(page: Page, topic: string) {
  // Wait for Welcome A (API key input)
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  // Welcome B should appear
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('user can submit a topic and see a root node stream in', async ({ page }) => {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });

  // Mock /v1/models
  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
    });
  });

  // Mock /v1/chat/completions with SSE
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    // Answer the auto-naming call with a short title so the project name doesn't
    // duplicate the node body text (which would break getByText assertions).
    if ((route.request().postData() ?? '').includes('short title for a research project')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"choices":[{"delta":{"content":"Fermentation"}}]}\n\ndata: [DONE]\n\n` });
      return;
    }
    const body =
      `data: {"choices":[{"delta":{"content":"Lactic fermentation produces "}}]}\n\n` +
      `data: {"choices":[{"delta":{"content":"[[lactic acid]]."}}]}\n\n` +
      `data: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/');

  await onboardAndSubmitTopic(page, 'fermentation');

  // The root node body should contain the streamed text and a clickable chip
  await expect(page.getByText('Lactic fermentation produces')).toBeVisible();
  await expect(page.getByRole('button', { name: 'lactic acid' })).toBeVisible();
});

test('clicking a [[reference]] chip spawns a child node', async ({ page }) => {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });

  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock-model' }] }) });
  });
  let callCount = 0;
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    // The auto-naming call fires alongside root generation; answer it with a
    // title so it doesn't consume the node-generation call-order sequence.
    if ((route.request().postData() ?? '').includes('short title for a research project')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"choices":[{"delta":{"content":"Pasteur"}}]}\n\ndata: [DONE]\n\n` });
      return;
    }
    callCount += 1;
    const body = callCount === 1
      ? `data: {"choices":[{"delta":{"content":"Root with [[Pasteur]]."}}]}\n\ndata: [DONE]\n\n`
      : `data: {"choices":[{"delta":{"content":"Pasteur was a French chemist."}}]}\n\ndata: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/');
  await onboardAndSubmitTopic(page, 'fermentation');
  await expect(page.getByRole('button', { name: 'Pasteur' })).toBeVisible();
  // Use JS click to avoid Playwright pointer-event interception by the canvas selection handler
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Pasteur');
    btn?.click();
  });
  await expect(page.getByText('Pasteur was a French chemist.')).toBeVisible();
});
