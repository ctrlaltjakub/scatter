import { expect, test, type Page, type Route } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const FIXTURES = process.env.SCATTER_SOURCE_FIXTURES ?? '/tmp/scatter-source-pipeline';
const TEXT_PDF = `${FIXTURES}/monty-hall-text.pdf`;
const SCANNED_PDF = `${FIXTURES}/antikythera-scanned.pdf`;
const PASTED_TEXT = `${FIXTURES}/ada-lovelace.txt`;
const MODEL = 'google/gemini-3.5-flash';

test.skip(!existsSync(TEXT_PDF) || !existsSync(SCANNED_PDF) || !existsSync(PASTED_TEXT),
  'Prepare the long Wikipedia source fixtures before running this browser test.');
test.setTimeout(12 * 60_000);

function sse(content: string, options: { web?: boolean; url?: string } = {}) {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
  ];
  if (options.web) {
    chunks.push(`data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { server_tool_use_details: { web_search_requests: 1 } },
    })}\n\n`);
  }
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

function messageText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!Array.isArray(part)) return '';
  return part.map((item) => (item && typeof item === 'object' && 'text' in item ? String(item.text) : '')).join('');
}

async function mockCompletion(route: Route) {
  const request = route.request();
  const body = JSON.parse(request.postData() ?? '{}') as {
    messages?: Array<{ role?: string; content?: unknown }>;
    max_tokens?: number;
    tools?: unknown[];
  };
  const system = messageText(body.messages?.find((message) => message.role === 'system')?.content);
  const user = messageText(body.messages?.findLast((message) => message.role === 'user')?.content);
  let answer = '';

  if (body.max_tokens === 1) {
    answer = 'ok';
  } else if (system.includes('short title for a research project')) {
    answer = 'Source pipeline';
  } else if (system.includes('alternate searches for local document retrieval')) {
    answer = '{"queries":["AZURE-LANTERN-731","Monty Hall switching","Antikythera mechanism"]}';
  } else if (system.includes('Faithfully transcribe the supplied source image')) {
    const page = /page (\d+)/i.exec(user)?.[1] ?? '1';
    answer = `Antikythera scanned page ${page}. The mechanism used interlocking bronze gears to model astronomical cycles.`;
  } else if (system.includes('precise text annotator')) {
    answer = user.slice(user.indexOf('Start now.') + 'Start now.'.length).replace(/^\s+/, '');
  } else {
    const evidenceIds = [...user.matchAll(/<<<(SOURCE_\d+)\b/g)].map((match) => match[1]);
    const evidence = evidenceIds[0] ?? 'SOURCE_1';
    const web = Array.isArray(body.tools) && body.tools.length > 0;
    const webTail = web
      ? ' A current web reference is also available [web source](https://example.com/current-source).'
      : '';
    answer = `The archive marker is **AZURE-LANTERN-731**. (${evidence})\n\n`
      + `The **Monty Hall problem** rewards switching under its standard assumptions. (${evidence})\n\n`
      + `The **Antikythera mechanism** represented astronomical cycles with gears. (${evidence})\n\n`
      + `The archive also connects **Ada Lovelace** with the later history of computing. (${evidence})${webTail}\n\n`
      + `- Reasoning examples\n`
      + `  - Switching strategy: The standard solution assigns a two-thirds chance to switching. (${evidence})\n`
      + `  - Archive control: The copied source contains the unique marker AZURE-LANTERN-731. (${evidence})\n`
      + `- Computing history\n`
      + `  - Mechanical models: The Antikythera mechanism represented cyclic astronomical motion. (${evidence})\n`
      + `  - Written programs: Ada Lovelace described operations for the Analytical Engine. (${evidence})`;
  }

  await route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: sse(answer, { web: Array.isArray(body.tools) && body.tools.length > 0 }),
  });
}

async function setMode(page: Page, mode: 'Use' | 'Only') {
  const switcher = page.getByLabel('How Scatter uses active sources').last();
  await switcher.getByRole('button', { name: mode, exact: true }).click();
  await expect(switcher.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function setWeb(page: Page, on: boolean) {
  const button = page.getByRole('button', { name: 'Allow web search for generation' }).last();
  await expect(button).toBeEnabled();
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(on));
}

async function waitForGeneration(page: Page) {
  const node = page.locator('[data-node-id]').first();
  await expect(node).toBeVisible({ timeout: 60_000 });
  // A fresh node exists while local retrieval is still running, before the
  // provider stream flips the card's `loading` class. Wait for committed text
  // rather than treating that pre-stream gap as a completed generation.
  await expect.poll(async () => (await node.locator('.node-body').innerText()).trim().length, {
    timeout: 6 * 60_000,
  }).toBeGreaterThan(120);
  await expect(node).not.toHaveClass(/loading/, { timeout: 90_000 });
  await expect(node.locator('[role="alert"]')).toHaveCount(0);
  return node;
}

async function regenerate(page: Page) {
  const node = page.locator('[data-node-id]').first();
  await node.click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(node).toHaveClass(/loading/, { timeout: 15_000 });
  await expect(node).not.toHaveClass(/loading/, { timeout: 90_000 });
}

test('webpage, pasted text, text PDF, and scanned PDF work through Use/Only and citation review', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error Chromium supports async directory iteration.
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
  await page.route('https://openrouter.ai/api/v1/models', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [{
      id: MODEL,
      name: 'Gemini 3.5 Flash fixture',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['reasoning', 'tools'],
    }] }),
  }));
  await page.route('https://openrouter.ai/api/v1/chat/completions', mockCompletion);
  await page.route('https://en.wikipedia.org/wiki/History_of_the_Internet', async (route) => {
    const text = readFileSync(`${FIXTURES}/history-of-the-internet.txt`, 'utf8').slice(0, 24_000);
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<html><head><title>History of the Internet</title></head><body><article><h1>History of the Internet</h1>${text.split(/\n{2,}/).map((part) => `<p>${part.replace(/[&<>]/g, '')}</p>`).join('')}</article></body></html>`,
    });
  });
  await page.route(/https:\/\/huggingface\.co\/.*/, async (route) => route.abort('failed'));
  await page.route(/https:\/\/.*\.hf\.co\/.*/, async (route) => route.abort('failed'));

  await page.goto('/');
  await page.getByPlaceholder('sk-or-…').fill('sk-or-fixture');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByPlaceholder('Filter models…').fill(MODEL);
  await page.getByRole('button', { name: /google\/gemini-3\.5-flash/ }).first().click();
  await page.getByLabel('Filter secondary task models').fill(MODEL);
  await page.getByRole('listbox', { name: 'Secondary tasks model' })
    .getByRole('option', { name: /google\/gemini-3\.5-flash/ }).click();
  await page.getByRole('button', { name: /Finish setup/ }).click();

  const manager = page.locator('.source-manager');
  await manager.getByRole('button', { name: 'Add sources' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project sources' });
  await dialog.locator('input[type="file"]').setInputFiles([TEXT_PDF, SCANNED_PDF]);
  await dialog.getByRole('tab', { name: 'Web links' }).click();
  await dialog.getByPlaceholder(/https:\/\/example\.org\/article/).fill('https://en.wikipedia.org/wiki/History_of_the_Internet');
  await dialog.getByRole('tab', { name: 'Paste text' }).click();
  await dialog.getByPlaceholder('Paste source text…').fill(
    `SOURCE PIPELINE CONTROL: The archive marker is AZURE-LANTERN-731.\n\n${readFileSync(PASTED_TEXT, 'utf8').slice(0, 18_000)}`,
  );
  await dialog.getByLabel('Source title').fill('Ada Lovelace copied text');
  await dialog.getByRole('button', { name: 'Add 4 sources' }).click();
  await expect(dialog).toBeHidden();

  await expect(manager.locator('.source-row--job')).toHaveCount(0, { timeout: 5 * 60_000 });
  await expect(manager.locator('.source-row:not(.source-row--job)')).toHaveCount(4);
  await expect(manager.getByText('Embedding model: failed, using keyword search')).toBeVisible();
  await setMode(page, 'Use');
  await setWeb(page, false);

  await page.getByPlaceholder('A topic or a question…').fill('Explain AZURE-LANTERN-731, Monty Hall, Antikythera, Ada Lovelace, and Internet history.');
  await page.getByRole('button', { name: 'Submit topic' }).click();
  let node = await waitForGeneration(page);
  expect(await node.locator('[aria-label^="Project source "]').count()).toBeGreaterThan(0);
  await expect(node.locator('[aria-label^="Source "]')).toHaveCount(0);

  await setWeb(page, true);
  await regenerate(page);
  node = await waitForGeneration(page);
  expect(await node.locator('[aria-label^="Project source "]').count()).toBeGreaterThan(0);
  expect(await node.locator('[aria-label^="Source "]').count()).toBeGreaterThan(0);

  await setMode(page, 'Only');
  await expect(page.getByRole('button', { name: 'Allow web search for generation' }).last()).toBeDisabled();
  await regenerate(page);
  node = await waitForGeneration(page);
  expect(await node.locator('[aria-label^="Project source "]').count()).toBeGreaterThan(0);
  await expect(node.locator('[aria-label^="Source "]')).toHaveCount(0);

  await setMode(page, 'Use');
  await setWeb(page, false);
  await setMode(page, 'Only');
  await regenerate(page);
  node = await waitForGeneration(page);
  await expect(node.locator('[aria-label^="Source "]')).toHaveCount(0);

  await node.click({ position: { x: 20, y: 20 } });
  await page.getByRole('button', { name: 'Show sources' }).click();
  const sourcePanel = page.locator('.citations-panel');
  await expect(sourcePanel.getByText('Internal sources')).toBeVisible();
  await expect(sourcePanel.getByText('Web sources')).toHaveCount(0);
  await sourcePanel.locator('.internal-citation-row').first().click();
  await expect(page.locator('.source-viewer-window')).toBeVisible();
  await expect(page.locator('.source-viewer-window').getByPlaceholder('Search this source…')).toBeVisible();
});
