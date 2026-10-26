import { expect, test } from '@playwright/test';

test.describe('local physics', () => {
  test.use({ viewport: { width: 1800, height: 1000 } });

  test('dragging a remote node preserves a stopped cluster; dragging its member still moves it', async ({ page }) => {
    test.setTimeout(60_000);
    // Synthetic sandbox data only; no provider calls or persisted user project.
    await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
      ? route.continue() : route.abort());
    await page.goto('/sandbox');
    await page.locator('[data-node-id]').first().waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      const win = window as any;
      win.webpackChunk_N_E.push([[`physics-regression-${Date.now()}`], {}, (require: any) => {
        win.testExport = (name: string) => {
          for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
          throw new Error(`Missing test export: ${name}`);
        };
      }]);
      const settings = win.testExport('useSettingsStore');
      settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
        webSearch: false, cameraAutoPan: { ...settings.getState().cameraAutoPan, dragEdges: false } });
      const graph = win.testExport('useGraphStore');
      const make = (id: string, x: number, frozen = false) => ({ id, type: 'explain', frozen,
        position: { x, y: 0 }, currentVersionIndex: 0, versions: [{ header: id, body: 'Synthetic physics test node.',
          createdAt: 1, generatedBy: 'manual', contentType: 'explain', width: 624, bodyMaxHeight: 160 }] });
      const nodes = [make('Cluster A', 0), make('Cluster B', 1450), make('Pin 1', 3000, true),
        make('Pin 2', 4300, true), make('Distant node', 6000)];
      graph.getState().setProject({ ...graph.getState().project, id: 'local-wake-regression',
        nodes: Object.fromEntries(nodes.map(n => [n.id, n])),
        arrows: { ab: { id: 'ab', kind: 'auto', fromNodeId: 'Cluster A', toNodeId: 'Cluster B' } },
        selection: [], rootNodeId: 'Cluster A', viewport: { x: 450, y: 300, zoom: .18 } });
      graph.getState().requestPanTo(null);
    });
    const positions = () => page.evaluate(() => {
      const live = (window as any).testExport('useLivePositionsStore').getState().positions;
      return Object.fromEntries(['Cluster A', 'Cluster B', 'Pin 1', 'Pin 2', 'Distant node'].map(id => [id, live[id]]));
    });
    await expect(page.locator('[data-node-id="Distant node"]')).toBeVisible();
    // Allow initial dimensions to be measured before taking the baseline.
    await page.waitForTimeout(1500);
    const before = await positions();
    const header = page.locator('[data-node-id="Distant node"] .node-header');
    const box = (await header.boundingBox())!;
    const x = box.x + box.width * .45, y = box.y + box.height * .5;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(x + i * 4, y + i * 4, { steps: 2 });
      await page.waitForTimeout(30);
      const during = await positions();
      for (const id of ['Cluster A', 'Cluster B', 'Pin 1', 'Pin 2']) expect(during[id]).toEqual(before[id]);
    }
    await page.mouse.up();
    await expect.poll(async () => (await positions())['Distant node'].x).toBeGreaterThan(before['Distant node'].x + 100);
    await page.waitForTimeout(2000);
    const after = await positions();
    for (const id of ['Cluster A', 'Cluster B', 'Pin 1', 'Pin 2']) expect(after[id]).toEqual(before[id]);

    const linked = (await page.locator('[data-node-id="Cluster B"] .node-header').boundingBox())!;
    await page.mouse.move(linked.x + linked.width * .45, linked.y + linked.height * .5);
    await page.mouse.down();
    await page.mouse.move(linked.x + linked.width * .45 + 35, linked.y + linked.height * .5 + 20, { steps: 12 });
    await expect.poll(async () => (await positions())['Cluster A'].x).toBeGreaterThan(after['Cluster A'].x + 10);
    await page.mouse.up();
  });
});
