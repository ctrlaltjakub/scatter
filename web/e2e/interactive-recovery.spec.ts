import { expect, test, type Page } from '@playwright/test';
import { INTERACTIVE_PLAN_FIXTURE } from '../src/test/interactiveFixture';

const HTML = `<!doctype html><html><head><style>
body{padding:30px;background:var(--sc-bg);color:var(--sc-text);font:20px var(--sc-font-family)}
button{padding:12px;margin:12px;background:var(--sc-primary);border:0;border-radius:var(--sc-radius-md)}
</style></head><body><h1>Interactive counter</h1><output id="count">0</output>
<button id="add">Add one</button><button id="reset">Reset</button>
<script>setTimeout(()=>{throw new Error('Fixture runtime failure: view anyway must remain visible')},1000);let n=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=String(Math.min(1,++n));
document.querySelector('#reset').onclick=()=>{n=0;document.querySelector('#count').textContent='0';};</script></body></html>`;

async function exportsFor(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`interactive-recovery-${Date.now()}`], {}, (require: any) => {
      win.recoveryExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
  });
}

async function seed(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await exportsFor(page);
  await page.evaluate(async ({ html, plan }) => {
    const get = (window as any).recoveryExport;
    const settings = { ...get('useSettingsStore').getState(),
      providers: [{ id: 'fixture', preset: 'custom', baseUrl: location.origin + '/fixture/v1', apiKey: 'fixture-not-a-key', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' }, interactiveModelRef: undefined,
      autoTermPreviews: false, autoFreeImages: false, webSearch: false };
    const node = { id: 'recovery', type: 'interactive', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Interactive counter', body: 'Build a counter with reset.', contentType: 'interactive', language: 'en',
        createdAt: 1, generatedBy: 'interactive', interactiveStandalone: true, width: 800, bodyMaxHeight: 573,
        interactiveBuild: { request: 'Build a counter with reset.', state: 'failed', draftHtml: html, plan, repairPasses: 5,
          limitReached: true, providerId: 'fixture', model: 'fixture',
          error: 'The program still fails after 5 repair passes: the reset control is clipped in the narrow layout.',
          steps: [
            { id: 1, label: 'Preparing targeted repair · pass 5 of 5', state: 'complete' },
            { id: 2, label: 'Applying code changes', state: 'complete' },
            { id: 3, label: 'Testing initial state · Starts at zero', state: 'complete' },
            { id: 4, label: 'Testing normal state · Adds one', state: 'complete' },
            { id: 5, label: 'Testing boundary state · Stops at one', state: 'complete' },
            { id: 6, label: 'Testing reset state · Resets changed state', state: 'complete' },
            { id: 7, label: 'Reviewing screenshots, behavior and request coverage', state: 'failed',
              detail: 'The reset control is clipped in the narrow layout.' },
          ],
        } }] };
    const project = { ...get('useGraphStore').getState().project, id: 'interactive-recovery-regression', name: 'Interactive recovery',
      color: '#b390d4', nodes: { recovery: node }, arrows: {}, groups: {}, rootNodeId: 'recovery', selection: ['recovery'],
      viewport: { x: 570, y: 100, zoom: 1 } };
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable(); await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const dir = await root.getDirectoryHandle('projects', { create: true });
    await write(dir, `${project.id}.json`, project);
    await write(dir, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
  }, { html: HTML, plan: INTERACTIVE_PLAN_FIXTURE });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'View anyway' })).toBeVisible();
  await exportsFor(page);
  await page.evaluate(() => (window as any).recoveryExport('useGraphStore').getState().requestPanTo('recovery'));
  await expect.poll(() => page.locator('.interactive-build').evaluate(el => {
    const box = el.getBoundingClientRect(); return box.left >= 240 && box.right <= innerWidth && box.bottom <= innerHeight;
  })).toBe(true);
}

test('failed build offers three choices and previews safely in dark and light themes', async ({ page }, info) => {
  test.setTimeout(90_000);
  await seed(page);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(theme => (window as any).recoveryExport('applyThemePreference')(theme), theme);
    for (const name of ['View anyway', 'Run one more pass', 'Start over']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const resting = await button.evaluate(el => getComputedStyle(el).backgroundColor);
      await button.hover();
      await expect.poll(() => button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(resting);
    }
    const card = page.locator('.node[data-node-id="recovery"]');
    await page.mouse.move(1550, 950);
    await page.screenshot({ path: info.outputPath(`recovery-${theme}-screen.png`) });
    await card.screenshot({ path: info.outputPath(`recovery-${theme}.png`) });
    await page.getByRole('button', { name: 'View anyway' }).click();
    const dialog = page.getByRole('dialog', { name: 'Interactive: Interactive counter' });
    await expect(dialog.getByText('Unverified draft')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Accept this version' })).toBeVisible();
    const frame = dialog.frameLocator('iframe[title="Interactive program"]');
    await expect(frame.locator('#add')).toBeVisible();
    await expect(dialog.getByRole('status', { name: 'Loading interactive program', exact: true })).toHaveCount(0);
    const outer = await dialog.locator('iframe').boundingBox();
    const inner = await frame.locator('#add').evaluate(el => ({ rect: el.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight }));
    await page.mouse.click(outer!.x + (inner.rect.x + inner.rect.width / 2) * outer!.width / inner.width,
      outer!.y + (inner.rect.y + inner.rect.height / 2) * outer!.height / inner.height, { delay: 100 });
    await expect(frame.locator('#count')).toHaveText('1');
    await expect(dialog.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await page.screenshot({ path: info.outputPath(`draft-${theme}.png`) });
    await dialog.getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run one more pass' })).toBeVisible();
    const saved = await page.evaluate(() => (window as any).recoveryExport('useGraphStore').getState().project.nodes.recovery.versions[0]);
    expect(saved.interactive).toBeUndefined();
    expect(saved.interactiveBuild.state).toBe('failed');
    expect(saved.interactiveBuild.repairPasses).toBe(5);
  }
});

test('accepting a draft keeps the program, survives reload, and remains undoable', async ({ page }, info) => {
  test.setTimeout(90_000);
  await seed(page);
  await page.getByRole('button', { name: 'View anyway' }).click();
  const dialog = page.getByRole('dialog');
  const accept = dialog.getByRole('button', { name: 'Accept this version' });
  const restart = dialog.getByRole('button', { name: 'Restart' });
  const a = await accept.boundingBox(), r = await restart.boundingBox();
  expect(a!.x + a!.width).toBeLessThanOrEqual(r!.x);
  await page.screenshot({ path: info.outputPath('accept-version.png') });
  await accept.click();
  await expect(accept).toHaveCount(0);
  await expect(dialog.frameLocator('iframe').locator('#count')).toHaveText('0');
  await page.evaluate(() => (window as any).recoveryExport('useGraphStore').temporal.getState().undo());
  await expect(accept).toBeVisible();
  await page.evaluate(() => (window as any).recoveryExport('useGraphStore').temporal.getState().redo());
  await expect(accept).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('projects');
    const file = await (await dir.getFileHandle('interactive-recovery-regression.json')).getFile();
    const project = JSON.parse(await file.text());
    return project.nodes.recovery.versions[0].interactiveBuild.acceptedByUser;
  })).toBe(true);
  await page.reload();
  await expect(page.locator('.node[data-node-id="recovery"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View anyway' })).toHaveCount(0);
});

test('continuation sends the saved draft and checks while start over requests a fresh plan', async ({ page }) => {
  test.setTimeout(90_000);
  await seed(page);
  const requests: any[] = [];
  await page.route('**/fixture/v1/**', async route => {
    requests.push(route.request().postDataJSON());
    // Deliberately stop before any model output. This fixture incurs no API calls.
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Fixture provider unavailable' } }) });
  });
  await page.getByRole('button', { name: 'Run one more pass' }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(JSON.stringify(requests[0])).toContain('overall pass 6');
  expect(JSON.stringify(requests[0])).toContain('Current document');
  expect(JSON.stringify(requests[0])).toContain('Stops at one');
  await expect(page.getByRole('button', { name: 'Start over' })).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(JSON.stringify(requests[1])).toContain('Plan the program before implementation.');
  expect(JSON.stringify(requests[1])).not.toContain('Current document');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  const versions = await page.evaluate(() => (window as any).recoveryExport('useGraphStore').getState().project.nodes.recovery.versions);
  expect(versions).toHaveLength(3);
  expect(versions[0].interactiveBuild.repairPasses).toBe(5);
  expect(versions[1].interactiveBuild.draftHtml).toBe(HTML);
  expect(versions[2].interactiveBuild.draftHtml).toBeUndefined();
});
