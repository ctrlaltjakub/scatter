import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

async function expose(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`capture-${Date.now()}`], {}, (require: any) => {
      win.captureExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing export: ${name}`);
      };
    }]);
  });
}
async function seed(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await expose(page);
  await expect.poll(() => page.evaluate(() => (window as any).captureExport('useSettingsStore').getState().hydrated)).toBe(true);
  await page.evaluate(async () => {
    const get = (window as any).captureExport;
    const settings = { ...get('useSettingsStore').getState(), forceWelcomeA: false, autoTermPreviews: false, autoFreeImages: false, webSearch: false,
      providers: [{ id: 'fixture', preset: 'custom', baseUrl: location.origin + '/fixture/v1', apiKey: 'fixture-not-a-key', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' } };
    get('useSettingsStore').setState(settings);
    sessionStorage.removeItem('scatter.onboarding');
    const node = { id: 'capture-node', type: 'term-click', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0,
      versions: [{ header: 'High-resolution capture', body: 'Fine typography and vector geometry.\n\n- Clear detail\n  - Text is rendered at export density.\n- Multiple languages\n  - 日本語。中文。 العربية हिन्दी Zażółć gęślą jaźń.',
        createdAt: 1, generatedBy: 'term-click', width: 680, bodyMaxHeight: 400 }] };
    const project = { ...get('useGraphStore').getState().project, id: 'capture-fixture', name: 'Capture verification',
      rootNodeId: node.id, nodes: { [node.id]: node }, arrows: {}, groups: {}, selection: [node.id], viewport: { x: 480, y: 130, zoom: 0.8 } };
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, data: unknown) => {
      const file = await dir.getFileHandle(name, { create: true }); const stream = await file.createWritable();
      await stream.write(JSON.stringify(data)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const dir = await root.getDirectoryHandle('projects', { create: true });
    await write(dir, `${project.id}.json`, project);
    await write(dir, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
  });
  await page.goto('/');
  await page.locator('[data-node-id="capture-node"]').first().waitFor({ timeout: 30_000 });
  await expect(page.locator('.project-restoration')).toHaveCount(0, { timeout: 30_000 });
  await expose(page);
  await page.evaluate(() => (window as any).captureExport('useScreenshotStore').getState().setOpen(true));
  await expect(page.getByRole('toolbar', { name: 'Screenshot capture' })).toBeVisible();
}

test('exports real high-density app detail, selection, pointer and both themes', async ({ page }, info) => {
  test.setTimeout(180_000);
  await seed(page);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => (window as any).captureExport('applyThemePreference')(theme), theme);
    await page.screenshot({ path: info.outputPath(`toolbar-${theme}.png`) });
    const download = page.waitForEvent('download', { timeout: 90_000 });
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    const file = await download;
    const path = info.outputPath(`whole-app-${theme}.png`); await file.saveAs(path);
    expect(await sharp(path).metadata()).toMatchObject({ width: 2560, height: 1800 });
    const stats = await sharp(path).stats(); expect(stats.channels[0]!.stdev).toBeGreaterThan(10);
    await expect(page.getByRole('toolbar', { name: 'Screenshot capture' }).getByRole('alert')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Select area', exact: true }).click();
  await page.mouse.move(400, 110); await page.mouse.down(); await page.mouse.move(1100, 660, { steps: 6 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Capture pointer', exact: true }).click();
  await page.mouse.move(800, 400);
  await page.screenshot({ path: info.outputPath('selection-before-export.png') });
  const download = page.waitForEvent('download', { timeout: 90_000 });
  await page.keyboard.press('=');
  const path = info.outputPath('selected-area.png'); await (await download).saveAs(path);
  expect(await sharp(path).metadata()).toMatchObject({ width: 2560, height: 2011 });
  // A 0.25 CSS-px stripe is below native screen resolution but resolves at 4×.
  // Inspect actual PNG pixels, not merely its dimensions.
  const detail = await page.evaluate(async () => {
    const sample = document.createElement('div'); sample.id = 'density-proof';
    sample.style.cssText = 'position:fixed;left:100px;top:100px;width:640px;height:100px;z-index:99999;background:repeating-linear-gradient(90deg,#000 0px,#000 .25px,#fff .25px,#fff .5px)';
    document.body.appendChild(sample);
    try {
      const blob = await (window as any).captureExport('captureAppScreenshot')({ x: 100, y: 100, width: 640, height: 100 });
      return await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
    } finally { sample.remove(); }
  });
  const data = await sharp(Buffer.from(detail.split(',')[1]!, 'base64')).removeAlpha().raw().toBuffer();
  const alternating = Array.from({ length: 100 }, (_, x) => data[(20 * 2560 + x) * 3]!);
  expect(Math.max(...alternating) - Math.min(...alternating)).toBeGreaterThan(150);
});

test('captures live sandbox state without granting same-origin access', async ({ page }, info) => {
  test.setTimeout(120_000);
  await seed(page);
  await page.evaluate(() => {
    const get = (window as any).captureExport;
    const graph = get('useGraphStore'); const old = graph.getState().project.nodes['capture-node'];
    const html = '<!doctype html><html><head><style>body{padding:30px;background:var(--sc-bg);color:var(--sc-text);font:22px Arial}button{background:var(--sc-primary);padding:12px}</style></head><body><h1>Live export</h1><output id="count">0</output><button id="add" onclick="document.getElementById(\'count\').textContent=\'7\'">Add</button><svg width="300" height="170"><circle cx="80" cy="80" r="60" fill="#ff3333"/></svg></body></html>';
    graph.getState().updateNode(old.id, { versions: [{ ...old.versions[0], contentType: 'interactive', interactiveStandalone: true,
      interactive: { html, model: 'fixture', providerId: 'fixture', request: 'Counter', viewportWidth: 720, viewportHeight: 960 } }] });
  });
  const iframe = page.locator('iframe[title="Interactive program"]');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await page.frameLocator('iframe[title="Interactive program"]').locator('#add').click();
  await expect(page.frameLocator('iframe[title="Interactive program"]').locator('#count')).toHaveText('7');
  const download = page.waitForEvent('download', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await (await download).saveAs(info.outputPath('live-interactive.png'));
  await expect(page.frameLocator('iframe[title="Interactive program"]').locator('#count')).toHaveText('7');
});

test('app capture and generation visual checks do not capture or interfere with each other', async ({ page }, info) => {
  test.setTimeout(120_000);
  await seed(page);
  await page.evaluate(() => {
    const get = (window as any).captureExport;
    const html = '<!doctype html><html><head><style>body{background:var(--sc-bg);color:var(--sc-text)}button{color:var(--sc-primary)}</style></head><body><h1>Concurrent verification</h1><button>Control</button></body></html>';
    (window as any).pendingReview = get('checkInteractiveDocument')(html, get('DEFAULT_INTERACTIVE_HOST_STATE').theme,
      new AbortController().signal, [], { screenshot: true, alternateTheme: true });
  });
  await expect(page.locator('iframe[title="Checking interactive program"]')).toHaveCount(1);
  const download = page.waitForEvent('download', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await (await download).saveAs(info.outputPath('concurrent-capture.png'));
  const result = await page.evaluate(async () => {
    const result = await (window as any).pendingReview;
    return { ok: result.ok, error: result.captureError, screenshot: !!result.screenshot };
  });
  expect(result).toEqual({ ok: true, screenshot: true });
  await expect(page.getByRole('toolbar', { name: 'Screenshot capture' }).getByRole('alert')).toHaveCount(0);
});

test('saved program survives repeated visual reviews during high-resolution app capture', async ({ page }, info) => {
  test.skip(!process.env.SCATTER_CAPTURE_PROJECT, 'Optional local project; never commit a project export.');
  test.setTimeout(180_000);
  const zip = await JSZip.loadAsync(await readFile(process.env.SCATTER_CAPTURE_PROJECT!));
  const data = JSON.parse(await zip.file('project.json')!.async('text')), project = data.project ?? data;
  const version: any = Object.values(project.nodes).flatMap((node: any) => node.versions)
    .filter((v: any) => v.interactiveBuild?.error?.includes('Alternate-theme')).at(-1);
  await seed(page);
  for (let round = 0; round < 3; round++) {
    await page.evaluate(({ build, round }) => {
      const get = (window as any).captureExport;
      const theme = { ...get('DEFAULT_INTERACTIVE_HOST_STATE').theme, mode: 'dark', background: '#171717', text: '#eee', primary: '#23bec9' };
      const scenario = build.plan.scenarios.find((s: any) => s.kind === (round === 1 ? 'normal' : 'initial'));
      (window as any).pendingReview = get('checkInteractiveDocument')(build.draftHtml, theme,
        new AbortController().signal, scenario.actions, { screenshot: true, alternateTheme: round !== 1, assertions: scenario.assertions });
    }, { build: version.interactiveBuild, round });
    await expect(page.locator('iframe[title="Checking interactive program"]')).toHaveCount(1);
    const download = page.waitForEvent('download', { timeout: 90_000 });
    await page.getByRole('button', { name: 'Capture', exact: true }).click();
    await (await download).saveAs(info.outputPath(`saved-concurrent-${round}.png`));
    const result = await page.evaluate(async () => {
      const result = await (window as any).pendingReview;
      return { errors: result.errors, captureError: result.captureError, bytes: result.screenshot?.length, assertions: result.assertions?.map((a: any) => a.passed) };
    });
    expect(result.captureError, JSON.stringify(result)).toBeUndefined();
    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.errors).toEqual([]);
    expect(result.assertions?.every(Boolean)).toBe(true);
    await expect(page.getByRole('toolbar', { name: 'Screenshot capture' }).getByRole('alert')).toHaveCount(0);
  }
});

test('single-key capture leaves typing alone and is inactive when the tool is closed', async ({ page }) => {
  await seed(page);
  const downloads: unknown[] = []; page.on('download', file => downloads.push(file));
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'capture-typing-test';
    input.style.cssText = 'position:fixed;bottom:0;left:0;z-index:99999'; document.body.append(input);
  });
  await page.locator('#capture-typing-test').focus(); await page.keyboard.press('=');
  await expect(page.locator('#capture-typing-test')).toHaveValue('=');
  await page.getByRole('button', { name: 'Close screenshot tool' }).click();
  await page.keyboard.press('=');
  await page.waitForTimeout(300);
  expect(downloads).toEqual([]);
});

test('opens through developer settings and rejects low-resolution canvases without leaving capture stuck', async ({ page }) => {
  test.setTimeout(90_000);
  await seed(page);
  await page.getByRole('button', { name: 'Close screenshot tool' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Developer', exact: true }).click();
  await settings.getByRole('button', { name: /Developer options/ }).click();
  await settings.getByRole('button', { name: 'Open screenshot tool' }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Screenshot capture' })).toBeVisible();
  const failures = await page.evaluate(async () => {
    const capture = (window as any).captureExport('captureAppScreenshot');
    const failures: string[] = [];
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100;
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:500px;z-index:999'; document.body.appendChild(canvas);
    try { await capture({ x: 0, y: 0, width: innerWidth, height: innerHeight }); } catch (error) { failures.push(String(error)); }
    canvas.remove();
    const frame = document.createElement('iframe'); frame.srcdoc = '<p>External embed</p>';
    frame.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:500px;z-index:999'; document.body.appendChild(frame);
    try { await capture({ x: 0, y: 0, width: innerWidth, height: innerHeight }); } catch (error) { failures.push(String(error)); }
    frame.remove();
    const result = await capture({ x: 0, y: 0, width: innerWidth, height: innerHeight });
    return { failures, recovered: result.type === 'image/png' };
  });
  expect(failures.failures[0]).toContain('without a high-resolution export renderer');
  expect(failures.failures[1]).toContain('external embedded page');
  expect(failures.recovered).toBe(true);
});
