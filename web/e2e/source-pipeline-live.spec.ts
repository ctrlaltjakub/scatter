import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.SCATTER_E2E_OPENROUTER_KEY;
const FIXTURES = process.env.SCATTER_SOURCE_FIXTURES ?? '/tmp/scatter-source-pipeline';
const TEXT_PDF = `${FIXTURES}/monty-hall-text.pdf`;
const SCANNED_PDF = `${FIXTURES}/antikythera-scanned.pdf`;
const PASTED_TEXT = `${FIXTURES}/ada-lovelace.txt`;
const WEBPAGE = 'https://en.wikipedia.org/wiki/History_of_the_Internet';
const MODEL = 'google/gemini-3.5-flash';
const REPORT_PATH = `${FIXTURES}/live-pipeline-report.json`;

test.skip(!KEY || !existsSync(TEXT_PDF) || !existsSync(SCANNED_PDF) || !existsSync(PASTED_TEXT),
  'Set SCATTER_E2E_OPENROUTER_KEY and prepare the source fixtures to run the live source matrix.');

test.describe.configure({ mode: 'serial' });
test.setTimeout(20 * 60_000);

interface GenerationObservation {
  mode: 'use' | 'only';
  webSearchRemembered: boolean;
  webSearchAvailable: boolean;
  internalCitationCount: number;
  webCitationCount: number;
  body: string;
}

async function clearBrowserState(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error Chromium exposes async directory iteration.
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
}

async function chooseMode(page: Page, mode: 'use' | 'only') {
  const controls = page.getByLabel('How Scatter uses active sources').last();
  await controls.getByRole('button', { name: mode === 'use' ? 'Use' : 'Only', exact: true }).click();
  await expect(controls.getByRole('button', { name: mode === 'use' ? 'Use' : 'Only', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
}

async function setWebSearch(page: Page, enabled: boolean) {
  const button = page.getByRole('button', { name: 'Allow web search for generation' }).last();
  await expect(button).toBeEnabled();
  const current = await button.getAttribute('aria-pressed') === 'true';
  if (current !== enabled) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(enabled));
}

async function waitForNode(page: Page): Promise<Locator> {
  const node = page.locator('[data-node-id]').first();
  await expect(node).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await node.locator('.node-body').innerText()).trim().length, {
    timeout: 6 * 60_000,
  }).toBeGreaterThan(120);
  await expect(node).not.toHaveClass(/loading/, { timeout: 6 * 60_000 });
  await expect(node.locator('[role="alert"]')).toHaveCount(0);
  return node;
}

async function observe(page: Page, mode: 'use' | 'only', remembered: boolean): Promise<GenerationObservation> {
  const node = await waitForNode(page);
  const body = await node.locator('.node-body').innerText();
  const internalCitationCount = await node.locator('[aria-label^="Project source "]').count();
  const webCitationCount = await node.locator('[aria-label^="Source "]').count();
  const webButton = page.getByRole('button', { name: 'Allow web search for generation' }).last();
  const webSearchAvailable = await webButton.isEnabled();

  expect(body.trim().length).toBeGreaterThan(120);
  expect(internalCitationCount).toBeGreaterThan(0);
  if (mode === 'only') {
    expect(webSearchAvailable).toBe(false);
    expect(webCitationCount).toBe(0);
  }
  return {
    mode,
    webSearchRemembered: remembered,
    webSearchAvailable,
    internalCitationCount,
    webCitationCount,
    body,
  };
}

async function regenerate(page: Page) {
  const node = page.locator('[data-node-id]').first();
  await node.click({ position: { x: 24, y: 24 } });
  const button = page.getByRole('button', { name: 'Regenerate', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(node).toHaveClass(/loading/, { timeout: 30_000 });
  await expect(node).not.toHaveClass(/loading/, { timeout: 6 * 60_000 });
}

test('long mixed sources survive extraction, hybrid indexing, source policies, generation, and citation review', async ({ page }, testInfo) => {
  await clearBrowserState(page);
  await page.goto('/');

  await page.getByPlaceholder('sk-or-…').fill(KEY!);
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await expect(page.getByPlaceholder('Filter models…')).toBeVisible({ timeout: 90_000 });
  await page.getByPlaceholder('Filter models…').fill(MODEL);
  await page.getByRole('button', { name: new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();

  await page.getByLabel('Filter secondary task models').fill(MODEL);
  const secondary = page.getByRole('listbox', { name: 'Secondary tasks model' })
    .getByRole('option', {
      name: new RegExp(`^${MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\$`),
    });
  await expect(secondary).toBeVisible({ timeout: 90_000 });
  await secondary.click();
  await page.getByRole('button', { name: /Finish setup/ }).click();

  const manager = page.locator('.source-manager');
  await expect(manager).toBeVisible();
  await manager.getByRole('button', { name: 'Add sources' }).click();
  const importDialog = page.getByRole('dialog', { name: 'Add project sources' });
  await expect(importDialog).toBeVisible();
  await importDialog.locator('input[type="file"]').setInputFiles([TEXT_PDF, SCANNED_PDF]);

  await importDialog.getByRole('tab', { name: 'Web links' }).click();
  await importDialog.getByPlaceholder(/https:\/\/example\.org\/article/).fill(WEBPAGE);

  await importDialog.getByRole('tab', { name: 'Paste text' }).click();
  await importDialog.getByPlaceholder('Paste source text…').fill(
    `SOURCE PIPELINE CONTROL: The archive marker is AZURE-LANTERN-731.\n\n${readFileSync(PASTED_TEXT, 'utf8')}`,
  );
  await importDialog.getByLabel('Source title').fill('Ada Lovelace copied Wikipedia text');
  await importDialog.getByRole('button', { name: 'Add 4 sources' }).click();
  await expect(importDialog).toBeHidden();

  await expect(manager.getByText('Embedding model: ready')).toBeVisible({ timeout: 8 * 60_000 });
  await expect(manager.locator('.source-row--job')).toHaveCount(0, { timeout: 12 * 60_000 });
  await expect(manager.locator('.source-row:not(.source-row--job)')).toHaveCount(4);
  await expect(manager.locator('.source-row--job.failed')).toHaveCount(0);

  // Confirm semantic progress was not merely cosmetic: every ready revision has
  // passed through the per-file indexing stage and the browser-local model is
  // ready before generation begins.
  await chooseMode(page, 'use');
  await setWebSearch(page, false);

  await page.getByPlaceholder('A topic or a question…').fill(
    'Explain the source archive, including AZURE-LANTERN-731, the Monty Hall switching result, the Antikythera mechanism, Ada Lovelace, and the history of the Internet.',
  );
  await page.getByRole('button', { name: 'Submit topic' }).click();

  const observations: GenerationObservation[] = [];
  observations.push(await observe(page, 'use', false));

  // Use + web search on: ask the same stable header to verify the web/internal
  // handoff and shared numbering without changing the source snapshot.
  await setWebSearch(page, true);
  await regenerate(page);
  observations.push(await observe(page, 'use', true));

  // Sources only intentionally disables web search even if the remembered
  // global toggle is on. A completed answer proves strict citation validation
  // accepted every factual unit; any unsupported answer is rejected by Scatter.
  await chooseMode(page, 'only');
  await regenerate(page);
  observations.push(await observe(page, 'only', true));

  // Repeat Sources only after explicitly switching the remembered web setting
  // off while temporarily in Use mode.
  await chooseMode(page, 'use');
  await setWebSearch(page, false);
  await chooseMode(page, 'only');
  await regenerate(page);
  observations.push(await observe(page, 'only', false));

  const node = page.locator('[data-node-id]').first();
  await node.click({ position: { x: 24, y: 24 } });
  await page.getByRole('button', { name: 'Show sources' }).click();
  const sourcesPanel = page.locator('.citations-panel');
  await expect(sourcesPanel.getByText('Internal sources')).toBeVisible();
  await expect(sourcesPanel.getByText('Web sources')).toHaveCount(0);
  await sourcesPanel.locator('.internal-citation-row').first().click();
  const sourceViewer = page.locator('.source-viewer-window');
  await expect(sourceViewer).toBeVisible();
  await expect(sourceViewer.locator('.source-document, .native-pdf-page')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(sourceViewer).toBeHidden();

  const mixed = observations.find((item) => item.mode === 'use' && item.webSearchRemembered);
  if (mixed?.webCitationCount) {
    await chooseMode(page, 'use');
    await setWebSearch(page, true);
    // Return to the web-enabled version and verify both source groups. The
    // version is two steps behind the current strict version.
    await node.click({ position: { x: 24, y: 24 } });
    await page.getByRole('button', { name: 'Previous version' }).click();
    await page.getByRole('button', { name: 'Previous version' }).click();
    await page.getByRole('button', { name: 'Show sources' }).click();
    await expect(page.locator('.citations-panel').getByText('Internal sources')).toBeVisible();
    await expect(page.locator('.citations-panel').getByText('Web sources')).toBeVisible();
  }

  writeFileSync(REPORT_PATH, JSON.stringify({
    ranAt: new Date().toISOString(),
    model: MODEL,
    fixtures: { webpage: WEBPAGE, pastedText: PASTED_TEXT, textPdf: TEXT_PDF, scannedPdf: SCANNED_PDF },
    observations,
  }, null, 2));
  await testInfo.attach('source-pipeline-report', {
    path: REPORT_PATH,
    contentType: 'application/json',
  });
});
