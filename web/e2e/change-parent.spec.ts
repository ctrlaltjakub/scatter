import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });
test.setTimeout(90_000);
const action = (page: Page) => page.getByRole('button', { name: 'Change parent node', exact: true });
const card = (page: Page, id: string) => page.locator(`.node[data-node-id="${id}"]`);
const preview = (page: Page) => page.locator('[data-parent-preview="incoming"]');
async function seed(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox'); await page.locator('.node[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const w = window as any;
    w.webpackChunk_N_E.push([['pick-test-' + Date.now()], {}, (req: any) => {
      const cache = new Map();
      w.pickExport = (name: string) => {
        if (!cache.has(name)) cache.set(name, (Object.values(req.c) as any[]).find(m => m.exports?.[name])?.exports[name]);
        return cache.get(name);
      };
    }]);
    w.pickExport('useSettingsStore').setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null });
    const store = w.pickExport('useGraphStore'), graph = store.getState();
    const node = (id: string, x: number, y: number) => ({ id, position: { x, y }, type: id === 'root' ? 'root' : 'term-click',
      frozen: true, currentVersionIndex: 0, versions: [{ createdAt: 1, generatedBy: 'manual', contentType: 'explain',
        header: id, body: 'An example [[target term]] for picking a parent.', width: 340, bodyMaxHeight: 140 }] });
    const edge = (id: string, fromNodeId: string, toNodeId: string) => ({ id, fromNodeId, toNodeId, kind: 'auto' });
    graph.setProject({ ...graph.project, rootNodeId: 'root', nodes: { root: node('root', 0, 0), child: node('child', 520, 0),
      next: node('next', 1000, 550), leaf: node('leaf', 120, 590) },
      arrows: { incoming: edge('incoming', 'root', 'child'), branch: edge('branch', 'child', 'leaf'), sibling: edge('sibling', 'root', 'next') },
      groups: {}, selection: ['child'], viewport: { x: 175, y: 95, zoom: .78 } });
    store.setState({ activeProjectId: graph.project.id }); store.getState().requestPanTo(null);
    w.pickState = () => store.getState().project;
  });
  await expect(action(page)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const parent = (page: Page) => page.evaluate(() => (window as any).pickState().arrows.incoming.fromNodeId);

test('the incoming arrow follows real pointer input, camera gestures do not pick, and the branch moves only on click', async ({ page }) => {
  await seed(page);
  await action(page).click();
  await expect(preview(page)).toBeAttached();
  await expect(card(page, 'next')).toHaveAttribute('data-parent-choice', 'eligible');
  await expect(card(page, 'leaf')).toHaveAttribute('data-parent-choice', 'invalid');
  await page.mouse.move(875, 380);
  await expect.poll(() => preview(page).evaluate((el: SVGPathElement) => {
    const p = el.getPointAtLength(0).matrixTransform(el.getScreenCTM()!);
    return Math.hypot(p.x - 875, p.y - 380);
  })).toBeLessThan(3);
  await card(page, 'leaf').locator('.node-header').click();
  await expect(preview(page)).toBeAttached();
  const blank = await page.evaluate(() => {
    for (let y = 340; y < 860; y += 60) for (let x = 280; x < 1250; x += 80) {
      const el = document.elementFromPoint(x, y);
      if (el?.closest('.canvas-host') && !el.closest('.node,.node-actions-panel,.node-followup-bar,button,a,svg')) return { x, y };
    }
    throw new Error('No empty canvas in the fixture');
  });
  const startX = await page.evaluate(() => (window as any).pickState().viewport.x);
  await page.mouse.move(blank.x, blank.y); await page.mouse.down(); await page.mouse.move(blank.x + 60, blank.y + 12, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).pickState().viewport.x)).toBeCloseTo(startX + 60, 0);
  await expect(preview(page)).toBeAttached();
  const header = card(page, 'next').locator('.node-header'), b = (await header.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const before = await page.evaluate(() => ({ ...(window as any).pickState().viewport }));
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 45, y + 12, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).pickState().viewport.x)).toBeCloseTo(before.x + 45, 0);
  await expect(preview(page)).toBeAttached();
  await page.mouse.wheel(0, -70);
  await expect.poll(() => page.evaluate(() => (window as any).pickState().viewport.zoom)).toBeGreaterThan(before.zoom);
  expect(await parent(page)).toBe('root');
  const term = card(page, 'next').locator('.ref-chip').first();
  await term.click();
  await expect(preview(page)).toHaveCount(0);
  expect(await parent(page)).toBe('next');
  const result = await page.evaluate(() => { const p = (window as any).pickState(); return [p.selection, Object.keys(p.nodes).length, p.arrows.branch.fromNodeId, p.nodes.next.position]; });
  expect(result).toEqual([['child'], 4, 'child', { x: 1000, y: 550 }]);
});

test('Escape, the current node and other controls cancel; root, two-node and keyboard states are accessible', async ({ page }) => {
  await seed(page);
  await action(page).click(); await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0); expect(await parent(page)).toBe('root');
  await action(page).click(); await card(page, 'child').locator('.node-header').click();
  await expect(preview(page)).toHaveCount(0); expect(await parent(page)).toBe('root');
  await action(page).click();
  await page.getByRole('button', { name: 'Add node', exact: true }).click();
  await expect(preview(page)).toHaveCount(0); expect(await parent(page)).toBe('root');
  await action(page).focus(); await page.keyboard.press('Enter');
  await page.getByRole('combobox', { name: 'New parent node' }).selectOption('next');
  expect(await parent(page)).toBe('next');
  await page.evaluate(() => (window as any).pickExport('useGraphStore').getState().setSelection(['root']));
  await expect(action(page)).toHaveCount(0);
  await page.evaluate(() => {
    const graph = (window as any).pickExport('useGraphStore').getState(), p = graph.project;
    graph.setProject({ ...p, nodes: { root: p.nodes.root, child: p.nodes.child }, selection: ['child'],
      arrows: { incoming: { ...p.arrows.incoming, fromNodeId: 'root' } } });
  });
  await expect(action(page)).toBeDisabled();
  await expect(action(page)).toHaveAttribute('data-tip', /third node/);
  await action(page).hover();
  await expect(action(page)).toHaveCSS('cursor', /not-allowed/);
});

test('the shared action is available for every non-root card type', async ({ page }) => {
  await seed(page);
  for (const kind of ['chat', 'answer', 'markdown', 'interactive', 'media', 'encyclopedic', 'explain']) {
    await page.evaluate(kind => {
      const w = window as any, graph = w.pickExport('useGraphStore').getState(), p = graph.project;
      const n = p.nodes.child;
      const node = kind === 'chat' ? { ...w.pickExport('createChatNode')({ id: n.id, createdAt: 1, position: n.position, bodyHeight: 230 }), frozen: true }
        : { ...n, chat: undefined, type: 'term-click', versions: [{ header: kind, body: ['media','interactive'].includes(kind) ? '' : 'Example.',
          createdAt: 1, generatedBy: 'manual', contentType: kind === 'markdown' ? 'answer' : kind, markdownNote: kind === 'markdown',
          chat: kind === 'answer' || kind === 'markdown' ? { turnId: n.id, title: kind, question: '', state: 'complete',
            informationChunking: false, contextPath: [] } : undefined }] };
      graph.setProject({ ...p, nodes: { ...p.nodes, child: node } }); graph.requestPanTo(null);
    }, kind);
    await expect(action(page)).toBeEnabled();
    await action(page).click();
    await expect(preview(page)).toBeAttached();
    await page.keyboard.press('Escape');
    await expect(preview(page)).toHaveCount(0);
  }
});
