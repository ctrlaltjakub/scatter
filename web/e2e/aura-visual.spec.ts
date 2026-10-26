import { test, expect, type Page } from '@playwright/test';

/**
 * Visual + sanity check of the WebGL2 interactive-background renderer. Runs an
 * isolated scenario (fresh OPFS, mocked API, onboard, spawn a child, focus a
 * node) and drops screenshots into e2e/__screenshots__/ for review. Also asserts
 * GL sanity (stats present, frames rendered) and dumps diagnostic state.
 *
 * The canvas-2D fallback renderer was removed — WebGL2 is now required, with a
 * skippable "interactive background off" notice shown when it's unavailable.
 *
 * Run: npx playwright test e2e/aura-visual.spec.ts
 */

async function clearOpfs(page: Page) {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
}

async function mockApi(page: Page) {
  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
    });
  });
  let calls = 0;
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    // The auto-naming call fires alongside root generation; answer it with a
    // title so it doesn't consume the node-generation call-order sequence.
    if ((route.request().postData() ?? '').includes('short title for a research project')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"choices":[{"delta":{"content":"Fermentation"}}]}\n\ndata: [DONE]\n\n` });
      return;
    }
    calls += 1;
    const body = calls === 1
      ? `data: {"choices":[{"delta":{"content":"Root about [[Pasteur]] and fermentation."}}]}\n\ndata: [DONE]\n\n`
      : `data: {"choices":[{"delta":{"content":"Pasteur was a French chemist."}}]}\n\ndata: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
}

async function runScenario(page: Page) {
  await clearOpfs(page);
  await mockApi(page);
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('asciiAura')) {
      // eslint-disable-next-line no-console
      console.log(`[browser ${msg.type()}]`, msg.text());
    }
  });
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log('[pageerror]', err.message);
  });

  await page.goto('/');
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill('fermentation');
  await page.getByRole('button', { name: 'Submit topic' }).click();
  await expect(page.getByRole('button', { name: 'Pasteur' })).toBeVisible();

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Pasteur');
    btn?.click();
  });
  await expect(page.getByText('Pasteur was a French chemist.')).toBeVisible();
  await page.waitForTimeout(1500); // waves + cooling + physics settle
  await page.screenshot({ path: `e2e/__screenshots__/aura-gl-idle.png` });

  // Diagnostics: live viewport, scatter-base var, stats.
  const diag = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      scatterBase: cs.getPropertyValue('--scatter-base').trim(),
      auraColor: cs.getPropertyValue('--aura-color').trim(),
      stats: (window as unknown as { __auraStats?: object }).__auraStats ?? null,
    };
  });
  // eslint-disable-next-line no-console
  console.log(`[aura-visual gl] diag:`, JSON.stringify(diag));

  // Focus the root node → focused aura + wave + tween.
  await page.evaluate(() => {
    const node = document.querySelector('.node');
    (node as HTMLElement | null)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `e2e/__screenshots__/aura-gl-focused.png` });
}

test('GL scenario + sanity', async ({ page }) => {
  await runScenario(page);
  const stats = await page.evaluate(() =>
    (window as unknown as { __auraStats?: { renderer?: string; frames?: number } }).__auraStats ?? null);
  expect(stats?.renderer).toBe('gl');
  expect(stats?.frames ?? 0).toBeGreaterThan(0);
});
