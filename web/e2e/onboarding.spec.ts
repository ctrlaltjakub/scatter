import { test, expect, type Page, type TestInfo } from '@playwright/test';

const modelId = 'google/gemini-3.8-flash';

async function confirmSetup(page: Page, info?: TestInfo) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const finish = page.getByRole('button', { name: 'Finish setup', exact: true });
  await expect(finish).toBeDisabled();
  const confirmations = page.locator('.onboarding-confirmation input');
  await expect(confirmations).toHaveCount(1);
  await expect(confirmations).not.toBeChecked();
  await expect(confirmations).toHaveAccessibleDescription(/I confirm that I am 18 or older/);
  await expect(confirmations).toHaveAccessibleDescription(/I understand that AI models can hallucinate/);
  if (info) for (const theme of ['mocha', 'latte']) {
    const themeButton = page.getByRole('button', { name: theme === 'latte' ? 'Switch to light mode' : 'Switch to dark mode' });
    if (await themeButton.count()) await themeButton.click();
    await page.screenshot({ path: info.outputPath(`confirmation-${theme}.png`) });
  }
  await confirmations.check();
  await expect(finish).toBeEnabled();
  await confirmations.uncheck();
  await expect(finish).toBeDisabled();
  await confirmations.check();
  await finish.click();
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  // Each Playwright test has a fresh browser context and OPFS. Only free
  // connection/catalog endpoints are needed; never issue a paid test request.
  await page.route('https://openrouter.ai/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/key')) return route.fulfill({ json: { data: { limit: 10, limit_remaining: 10, usage: 0 } } });
    if (path.endsWith('/images/models')) return route.fulfill({ json: { data: [] } });
    if (path.endsWith('/models')) return route.fulfill({ json: { data: [{
      id: modelId, name: 'Gemini 3.8 Flash', context_length: 128000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
    }] } });
    await route.abort();
  });
});

test('custom setup reaches the topic picker and OpenRouter account settings', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Choose your own models Add provider/ }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('fixture-only-not-a-real-key');
  await page.getByRole('button', { name: 'Choose models', exact: true }).click();
  await page.getByRole('button', { name: /Main models Nodes & conversations/ }).click();
  await page.getByRole('list', { name: 'Available main models' }).getByRole('button', { name: new RegExp(modelId) }).click();
  for (const role of ['main', 'secondary', 'interactive', 'image']) {
    const trigger = page.locator(`button[aria-controls="settings-role-${role}"]`);
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
    const panel = page.locator(`#settings-role-${role}`);
    const override = panel.locator('.model-compatibility-inline');
    await expect(override.getByRole('switch', { name: 'Show all models' })).toHaveAttribute('type', 'checkbox');
    await override.scrollIntoViewIfNeeded();
    const list = panel.locator('ul').last();
    if (await list.count()) {
      expect((await override.boundingBox())!.y).toBeGreaterThanOrEqual((await list.boundingBox())!.y);
    }
    await page.screenshot({ path: info.outputPath(`model-role-${role}.png`) });
  }
  await confirmSetup(page, info);
  await expect(page.getByRole('textbox', { name: 'First message', exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'OpenRouter', exact: true }).click();
  await expect(page.getByText('Spending limit', { exact: true })).toBeVisible();
});

test('a keyless settings import restores model choices and asks only to reconnect', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Settings file').setInputFiles({ name: 'settings-without-keys.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'scatter-settings', formatVersion: 1,
    settings: {
      providers: [{ id: 'saved', preset: 'openrouter', apiKey: '', enabledModels: [modelId] }],
      activeModelRef: { providerId: 'saved', model: modelId }, imageModelRef: null,
    },
  })) });
  await expect(page.getByRole('heading', { name: 'Settings restored' })).toBeVisible();
  await page.getByRole('button', { name: 'OpenRouter connection', exact: true }).click();
  await page.getByLabel('API key', { exact: true }).fill('fixture-only-not-a-real-key');
  await page.getByRole('button', { name: 'Review restored setup', exact: true }).click();
  await expect(page.getByRole('button', { name: /Main models Nodes & conversations 1 selected/ })).toContainText(modelId);
  await confirmSetup(page);
  await expect(page.getByRole('textbox', { name: 'First message', exact: true })).toBeVisible({ timeout: 20_000 });
});
