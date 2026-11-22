import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });
test.setTimeout(60_000);

async function scene(page: Page, zoom: number) {
  await page.setViewportSize({ width: 1920, height: 1200 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('.node[data-node-id]').first().waitFor();
  await page.evaluate(zoom => {
    const win = window as any;
    win.webpackChunk_N_E.push([['camera-navigation-' + Date.now()], {}, (req: any) => {
      win.cameraExport = (name: string) => {
        for (const entry of Object.values(req.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error('Missing export: ' + name);
      };
    }]);
    const get = win.cameraExport, graph = get('useGraphStore');
    const settings = get('useSettingsStore');
    settings.setState({ providers: [], activeModelRef: null, autoFreeImages: false, autoTermPreviews: false,
      cameraAutoPan: { ...settings.getState().cameraAutoPan, focus: true, panels: true } });
    const node = { id: 'camera-target', type: 'root', frozen: true, position: { x: 200, y: 100 },
      currentVersionIndex: 0, versions: [{ header: 'Camera target', body: 'A short explanation.',
        contentType: 'explain', language: 'en', generatedBy: 'root', createdAt: 1, width: 624 }] };
    graph.getState().setProject({ ...graph.getState().project, id: 'camera-navigation-test',
      nodes: { [node.id]: node }, rootNodeId: node.id, arrows: {}, groups: {}, selection: [],
      viewport: { x: 150, y: 100, zoom } }, { resetRuntime: true });
    graph.getState().requestPanTo(null);
  }, zoom);
  await page.evaluate(() => document.fonts.ready);
}

const camera = (page: Page) => page.evaluate(() => {
  const get = (window as any).cameraExport, { x, y, zoom } = get('useLiveViewportStore').getState();
  return { x, y, zoom };
});
const arrived = (page: Page) => expect.poll(() =>
  page.evaluate(() => (window as any).cameraExport('useGraphStore').getState().panTo)).toBeNull();

test('sidebar group selection leaves a visible group still and reveals an offscreen group without zooming in', async ({ page }) => {
  await scene(page, 0.75);
  const group = await page.evaluate(() => {
    const graph = (window as any).cameraExport('useGraphStore').getState();
    const member = { ...graph.project.nodes['camera-target'], id: 'group-member', type: 'term-click',
      position: { x: 700, y: 350 } };
    graph.setProject({ ...graph.project, nodes: { ...graph.project.nodes, [member.id]: member } });
    const id = graph.createGroup('Example group');
    graph.assignNodeToGroup(member.id, id);
    return id;
  });
  const row = page.locator('[data-sidebar-group-id="' + group + '"]');
  const before = await camera(page);
  await row.click();
  await expect.poll(() => page.evaluate(() => (window as any).cameraExport('useGraphStore').getState().project.selection)).toEqual(['group-member']);
  await arrived(page);
  expect(await camera(page)).toEqual(before);
  await page.evaluate(() => (window as any).cameraExport('useGraphStore').getState().setViewport({ x: -1200, y: 100, zoom: 0.75 }));
  await row.click();
  await arrived(page);
  expect(await camera(page)).toMatchObject({ zoom: 0.75, y: 100 });
  const bounds = await page.locator('.node[data-node-id="group-member"]').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(239);
  expect(bounds!.x + bounds!.width).toBeLessThan(1920);
});

for (const zoom of [0.75, 1.25, 1.5]) {
  test('focus and panel navigation preserve ' + zoom + ' zoom; explicit fit remains capped', async ({ page }) => {
    await scene(page, zoom);
    const node = page.locator('.node[data-node-id="camera-target"]');
    await node.locator('.node-header').click();
    await expect.poll(() => page.evaluate(() =>
      (window as any).cameraExport('useGraphStore').getState().project.selection)).toEqual(['camera-target']);
    await arrived(page);
    expect((await camera(page)).zoom).toBeCloseTo(zoom);

    const before = await camera(page);
    // This is the same request used by free-image, fact-check and chat panels.
    await page.evaluate(() =>
      (window as any).cameraExport('useCitationPanelStore').getState().openWikimedia('camera-target', 1));
    await expect(page.locator('[data-canvas-right-panel]')).toBeVisible();
    await arrived(page);
    expect(await camera(page)).toMatchObject({ zoom: before.zoom, y: before.y });

    await page.evaluate(() =>
      (window as any).cameraExport('useCitationPanelStore').getState().close());
    await node.getByRole('button', { name: 'Fit node to screen', exact: true }).click();
    await arrived(page);
    const fitted = await camera(page);
    expect(fitted.zoom).toBeLessThanOrEqual(1);
    expect(fitted.zoom).toBeGreaterThanOrEqual(zoom < 1 ? zoom : 0.5);
    const bounds = await node.boundingBox();
    expect(bounds!.x).toBeGreaterThan(240);
    expect(bounds!.x + bounds!.width).toBeLessThan(1920);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThan(1200);
  });
}
