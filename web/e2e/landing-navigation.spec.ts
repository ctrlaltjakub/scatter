import { test, expect } from '@playwright/test';

const landingUrl = 'https://www.scatter.study/?landing=1';

// Run with --browser=chromium and --browser=firefox.
test.describe('landing navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Check real navigation without depending on the external landing site.
    await page.route(landingUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Landing page</h1>' }));
  });

  for (const width of [1440, 700]) {
    test(`onboarding keeps its subtle exit clear of controls at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 500 });
      await page.goto('/');
      await page.getByRole('button', { name: /Choose your own models Add provider/ }).click();
      const link = page.getByRole('link', { name: 'Landing page', exact: true });
      for (const theme of ['mocha', 'latte']) {
        const toggle = page.getByRole('button', { name: theme === 'latte' ? 'Switch to light mode' : 'Switch to dark mode' });
        if (await toggle.count()) await toggle.click();
        await expect(link).toBeVisible();
        await link.click({ trial: true });
        const box = (await link.boundingBox())!;
        const shell = (await page.locator('.onboarding-shell').boundingBox())!;
        expect(box.x).toBeLessThan(shell.x + 160);
        expect(box.y).toBeGreaterThan(shell.y + shell.height - 70);
        // On narrow landscape windows the setup controls share the bottom row.
        if (width === 700) {
          const back = (await page.getByRole('button', { name: 'Back', exact: true }).boundingBox())!;
          expect(box.x + box.width).toBeLessThan(back.x);
        }
        await page.screenshot({ path: info.outputPath(`onboarding-${width}-${theme}.png`) });
      }
      await link.focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(landingUrl);
    });
  }

  for (const mode of ['narrow', 'tablet', 'combined'] as const) {
    test(`${mode} warning has a visible working exit`, async ({ page }, info) => {
      await page.setViewportSize(mode === 'tablet' ? { width: 1024, height: 768 } : { width: 390, height: 844 });
      if (mode !== 'narrow') {
        await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Android tablet' }));
      }
      await page.goto('/');
      const dialog = page.getByRole('dialog');
      const link = dialog.getByRole('link', { name: 'Back to landing page' });
      await expect(link).toBeVisible();
      await link.click({ trial: true });
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height);
      if (mode === 'tablet') await expect(dialog.getByRole('button', { name: 'Use anyway' })).toBeVisible();
      else await expect(dialog.getByRole('button', { name: 'Use anyway' })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath(`warning-${mode}.png`) });
      await link.click();
      await expect(page).toHaveURL(landingUrl);
    });
  }

  test('tablet override still dismisses the notice without navigating', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Android tablet' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Use anyway' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Configure AI models' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Configure AI models' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('link', { name: 'Back to landing page' })).toBeVisible();
  });
});
