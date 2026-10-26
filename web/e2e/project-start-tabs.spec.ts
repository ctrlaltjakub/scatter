import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function loadExports(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`project-tabs-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
  });
}

test('Chat is the default first tab, followed by Topic and Image', async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.route('**/*', route => ['localhost', '127.0.0.3', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  // Only this test's isolated browser storage is used. No model requests.
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await loadExports(page);
  await page.evaluate(async () => {
    const settings = { ...(window as any).testExport('useSettingsStore').getState(),
      autoFreeImages: false, autoTermPreviews: false,
      providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-not-a-key',
        baseUrl: 'https://fixture.invalid/v1', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' } };
    const root = await navigator.storage.getDirectory();
    const stream = await (await root.getFileHandle('settings.json', { create: true })).createWritable();
    await stream.write(JSON.stringify(settings));
    await stream.close();
    sessionStorage.removeItem('scatter.onboarding');
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'First message', exact: true })).toBeVisible({ timeout: 20_000 });
  await loadExports(page);
  const tabs = page.getByRole('tablist', { name: 'Start a project' });
  expect(await tabs.getByRole('tab').evaluateAll(elements => elements.map(el => el.id)))
    .toEqual(['start-tab-chat', 'start-tab-topic', 'start-tab-image']);
  await expect(page.locator('#start-tab-chat')).toHaveAttribute('aria-selected', 'true');
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(theme => (window as any).testExport('applyThemePreference')(theme), theme);
    for (const mode of ['chat', 'topic', 'image']) {
      const selected = page.locator(`#start-tab-${mode}`);
      await selected.click();
      await page.mouse.move(1450, 1050);
      await expect(selected).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', `start-tab-${mode}`);
      await page.waitForTimeout(300);
      const bounds = await tabs.getByRole('tab').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().left));
      expect(bounds[0]!).toBeLessThan(bounds[1]!);
      expect(bounds[1]!).toBeLessThan(bounds[2]!);
      const panel = (await page.getByRole('tabpanel').boundingBox())!;
      const settings = (await page.getByRole('button', { name: 'Open settings', exact: true }).boundingBox())!;
      const contentInset = await page.getByRole('tabpanel').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
      expect(settings.x + settings.width / 2 - panel.x).toBeCloseTo(contentInset / 2, 0);
      expect(panel.y + panel.height - settings.y - settings.height / 2).toBeCloseTo(contentInset / 2, 0);
      await page.screenshot({ path: info.outputPath(`${theme}-${mode}.png`) });
    }
  }
  await page.locator('#start-tab-image').focus();
  await page.keyboard.press('Home');
  await expect(page.locator('#start-tab-chat')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#start-tab-chat').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#start-tab-topic')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#start-tab-image')).toBeFocused();
});
