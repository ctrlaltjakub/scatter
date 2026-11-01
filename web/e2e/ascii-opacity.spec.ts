import { expect, test, type Page } from '@playwright/test';

async function expose(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`opacity-${Date.now()}`], {}, (require: any) => {
      win.opacityExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing export: ${name}`);
      };
    }]);
  });
}

async function alphaSum(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('.canvas-host > canvas') as HTMLCanvasElement;
    const capture = (window as any).opacityExport('screenshotRenderer')(canvas);
    if (!capture) throw new Error('ASCII screenshot renderer is missing');
    const image = new Image(); image.src = await capture(1); await image.decode();
    const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0; for (let index = 3; index < pixels.length; index += 4) sum += pixels[index]!;
    return sum;
  });
}

async function uniform(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.canvas-host > canvas') as HTMLCanvasElement;
    const gl = canvas?.getContext('webgl2');
    if (!gl) return null;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const location = program ? gl.getUniformLocation(program, 'uOpacity') : null;
    return location ? gl.getUniform(program, location) : null;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await expect(page.locator('[data-node-id]').first()).toBeVisible();
  await expose(page);
  await expect.poll(() => page.evaluate(() => (window as any).opacityExport('useSettingsStore').getState().hydrated)).toBe(true);
  await expect.poll(() => uniform(page)).toBe(1);
});

test('opacity scales all rendered ink, updates an idle field, resets and survives reload', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const get = (window as any).opacityExport, graph = get('useGraphStore');
    const project = graph.getState().project;
    graph.setState({ project: { ...project, nodes: Object.fromEntries(Object.entries(project.nodes)
      .map(([id, node]: [string, any]) => [id, { ...node, frozen: true }])) } });
    get('useNodeStatusStore').getState().setStatus(project.rootNodeId, 'Opacity test');
  });
  // The sandbox's recording toolbar overlaps this corner; open through the
  // real keyboard action, then exercise the settings controls normally.
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  const slider = page.getByRole('slider', { name: 'ASCII opacity' });
  await expect(slider).toHaveValue('100');
  await slider.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('appearance-opacity.png') });
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.waitForTimeout(600); // Let the existing theme/label animations settle.
    const original = await alphaSum(page); expect(original).toBeGreaterThan(0);
    await slider.focus(); await page.keyboard.press('Home');
    await expect.poll(() => uniform(page)).toBe(0);
    expect(await alphaSum(page)).toBe(0); // Includes labels/statuses, not just background cells.
    await page.getByRole('spinbutton', { name: 'ASCII opacity value' }).fill('50');
    await expect.poll(() => uniform(page)).toBe(0.5);
    const faded = await alphaSum(page);
    expect(faded).toBeLessThan(original * 0.8); expect(faded).toBeGreaterThan(original * 0.3);
    await slider.focus(); await page.keyboard.press('End');
    await expect.poll(() => uniform(page)).toBe(2);
    expect(await alphaSum(page)).toBeGreaterThan(original * 1.1);
    await page.getByRole('button', { name: 'Reset ASCII opacity to default' }).click();
    await expect.poll(() => uniform(page)).toBe(1);
  }
  await page.getByRole('spinbutton', { name: 'ASCII opacity value' }).fill('175');
  await expect.poll(async () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return JSON.parse(await (await (await root.getFileHandle('settings.json')).getFile()).text()).asciiOpacity;
  })).toBe(175);
  await page.reload(); await expose(page);
  await expect.poll(() => uniform(page)).toBe(1.75);
  expect(errors).toEqual([]);
});

test('interactive side panel has no add-to-sources action', async ({ page }) => {
  await page.evaluate(() => {
    const graph = (window as any).opacityExport('useGraphStore');
    const project = graph.getState().project, node = project.nodes[project.rootNodeId];
    graph.getState().updateNode(node.id, { type: 'interactive', frozen: true, versions: [{ ...node.versions[0],
      contentType: 'interactive', interactiveStandalone: true,
      interactive: { html: '<button>Counter</button>', model: 'fixture', providerId: 'fixture', request: 'Counter' } }] });
    graph.getState().setSelection([node.id]); graph.getState().requestPanTo(node.id);
  });
  const panel = page.locator('.interactive-node-actions');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /sources/i })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open enlarged', exact: true })).toBeVisible();
});
