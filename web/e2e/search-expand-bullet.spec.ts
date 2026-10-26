import { test, expect, type Page } from '@playwright/test';

/* When a search match lives inside a COLLAPSED bullet, the node shows a
 * left-margin marker but no text highlight. Expanding the bullet must reveal
 * the word AND highlight it; collapsing returns to marker-only. */

async function onboardAndSubmitTopic(page: Page, topic: string) {
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

const snapshot = () => ({
  highlight:
    (CSS as unknown as { highlights: Map<string, { size: number }> }).highlights.get('sc-search')
      ?.size ?? 0,
  markers: document.querySelectorAll('.sc-bullet-marker').length,
  zebraVisible: Array.from(document.querySelectorAll('.node-body'))
    .filter((b) => !b.closest('.sc-ab-measure'))
    .some((b) => (b as HTMLElement).innerText.toLowerCase().includes('zebraword')),
});

test('expanding a collapsed matched bullet reveals + highlights the word', async ({ page }) => {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'm' }] }) });
  });
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    const md =
      'Intro paragraph about cellular biology metabolism and energy production overall.\n\n' +
      '- Glycolysis pathway overview\n' +
      '  - Step one: glucose phosphorylation occurs very early in the process\n' +
      '  - Step two: fructose bisphosphate forms next after isomerization happens\n' +
      '- Krebs cycle details\n' +
      '  - Citrate: forms from acetyl coenzyme a joining oxaloacetate molecules\n' +
      '  - Succinate: an important intermediate found within the cycle itself\n' +
      '- Electron transport chain\n' +
      '  - Complex one: nadh dehydrogenase pumps protons across the membrane\n' +
      '  - Complex four: cytochrome c oxidase performs the final electron step\n' +
      '- Fermentation routes summary\n' +
      '  - Lactic acid: builds up in muscle cells under heavy exertion load\n' +
      '  - Ethanol path: produces zebraword inside yeast cells during anaerobics';
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: md } }] })}\n\n` + `data: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/');
  await onboardAndSubmitTopic(page, 'cells');
  await page.locator('.sc-ab-item[data-sc-anchor="b-3"]').first().waitFor({ timeout: 15000 });

  // Deselect so the node sits compact (the last bullet's detail is collapsed).
  await page.mouse.click(5, 5);
  await page.waitForTimeout(400);

  // Search a word that lives in the last bullet's (collapsed) detail.
  await page.locator('.search-input').fill('zebraword');
  await expect.poll(() => page.evaluate(snapshot)).toMatchObject({
    highlight: 0, // hidden → nothing to highlight yet
    markers: 1, // but the left-margin marker flags the bullet
    zebraVisible: false,
  });

  // Expand that bullet → the word appears, gets highlighted, and the now-
  // redundant left-margin marker disappears (the highlight shows it instead).
  await page.locator('.sc-ab-item[data-sc-anchor="b-3"]').first().click();
  await expect.poll(() => page.evaluate(snapshot), { timeout: 6000 }).toMatchObject({
    highlight: 1,
    markers: 0,
    zebraVisible: true,
  });

  // Collapse again → highlight gone, marker stays.
  await page.locator('.sc-ab-item[data-sc-anchor="b-3"]').first().click();
  await expect.poll(() => page.evaluate(snapshot), { timeout: 6000 }).toMatchObject({
    highlight: 0,
    markers: 1,
    zebraVisible: false,
  });
});
