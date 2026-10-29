import { expect, test } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

test('topic suggestions follow system reduced motion, ignoring the removed device override', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`motion-fixture-${Date.now()}`], {}, async (require: any) => {
      const store = (Object.values(require.c) as any[]).find(entry => entry.exports?.useSettingsStore).exports.useSettingsStore;
      const settings = { ...store.getState(), autoFreeImages: false, autoTermPreviews: false,
        providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid/v1', enabledModels: ['fixture'] }],
        activeModelRef: { providerId: 'fixture', model: 'fixture' } };
      win.motionFixture = (async () => {
        const root = await navigator.storage.getDirectory();
        const writer = await (await root.getFileHandle('settings.json', { create: true })).createWritable();
        await writer.write(JSON.stringify(settings)); await writer.close();
      })();
    }]);
    await win.motionFixture;
    sessionStorage.removeItem('scatter.onboarding');
    localStorage.setItem('scatter-decorative-motion', 'animate');
  });
  await page.goto('/');
  const track = page.locator('.marquee-track').first();
  await expect(track).toBeVisible({ timeout: 20_000 });
  const transform = () => track.evaluate(el => getComputedStyle(el).transform);
  await expect.poll(() => track.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  const still = await transform();
  await page.waitForTimeout(250);
  expect(await transform()).toBe(still);
  await page.reload();
  await expect(track).toBeVisible({ timeout: 20_000 });
  const reloaded = await transform();
  await page.waitForTimeout(250);
  expect(await transform()).toBe(reloaded);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => track.evaluate(el => getComputedStyle(el).animationName)).toBe('marquee-left');
  const resumed = await transform();
  await expect.poll(transform).not.toBe(resumed);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => track.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  const paused = await transform();
  await page.waitForTimeout(250);
  expect(await transform()).toBe(paused);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Developer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decorative motion', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Animation', { exact: true })).toHaveCount(0);
});
