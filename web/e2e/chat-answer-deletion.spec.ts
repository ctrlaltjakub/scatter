import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium',
  headless: process.env.SCATTER_TEST_HEADED !== '1',
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
  viewport: { width: 1440, height: 1100 } });

async function fixture(page: Page) {
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`chat-deletion-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const find = win.testExport, settings = find('useSettingsStore'), graph = find('useGraphStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    let node = find('createChatNode')({ id: 'deletion-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 650 });
    for (const createdAt of [2, 3, 4, 5]) {
      const turnId = createdAt === 2 ? 'first' : 'latest';
      node = find('appendChatAnswer')(node, { turnId, createdAt, question: `Question ${createdAt}`, replaceLatest: createdAt > 3 });
      node = find('updateChatAnswer')(node, { turnId, versionCreatedAt: createdAt }, {
        body: `**Answer ${createdAt}.**\n\n` + 'Readable text with **clear emphasis**, 日本語, हिन्दी and café.\n'.repeat(createdAt === 2 ? 1 : 30),
      }, { state: 'complete' });
    }
    node = { ...node, frozen: true, generating: false, streamingText: false, generatingVersionIndex: undefined };
    find('useChatRuntimeStore').getState().view(node.id, { atBottom: false, scrollTop: 0 });
    const project = { ...graph.getState().project, id: 'chat-deletion-test', nodes: { [node.id]: node },
      rootNodeId: node.id, arrows: {}, groups: {}, selection: [node.id], viewport: { x: 420, y: 70, zoom: .9 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
    graph.temporal.getState().clear();
  });
}

const snapshot = (page: Page) => page.evaluate(() => {
  const node = (window as any).testExport('useGraphStore').getState().project.nodes['deletion-chat'];
  return { turns: node.chat.turns, versionIds: node.versions.map((version: any) => version.createdAt), position: node.position };
});

test('deletes the visible alternative, supports undo and returns to whole-turn deletion', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  const card = page.locator('[data-node-id="deletion-chat"]');
  const latest = card.locator('[data-chat-turn="latest"]');
  await expect(card.getByRole('button', { name: 'Delete turn', exact: true })).toHaveCount(0);
  await latest.getByRole('button', { name: 'Previous answer', exact: true }).click();
  await expect(latest).toHaveAttribute('data-chat-version', '4');
  await latest.getByRole('button', { name: 'Delete answer', exact: true }).click();
  await expect(latest).toHaveAttribute('data-chat-version', '3');
  expect((await snapshot(page)).versionIds).toEqual([1, 2, 3, 5]);
  // The sandbox mounts the real sidebar history controls, not app-page hotkeys.
  await page.getByRole('button', { name: /^Undo:/ }).focus();
  await page.keyboard.press('Enter');
  await expect(latest).toHaveAttribute('data-chat-version', '4');
  expect((await snapshot(page)).versionIds).toEqual([1, 2, 3, 4, 5]);
  await latest.getByRole('button', { name: 'Delete answer', exact: true }).click();
  await latest.getByRole('button', { name: 'Next answer', exact: true }).click();
  await expect(latest).toHaveAttribute('data-chat-version', '5');
  await latest.getByRole('button', { name: 'Delete answer', exact: true }).click();
  await expect(latest).toHaveAttribute('data-chat-version', '3');
  await expect(latest.getByRole('button', { name: 'Delete answer', exact: true })).toHaveCount(0);
  await expect(latest.locator('.chat-alternatives')).toHaveCount(0);
  await latest.getByRole('button', { name: 'Delete turn', exact: true }).click();
  await expect(latest).toHaveCount(0);
  await expect(card.locator('[data-chat-turn="first"]')).toHaveAttribute('data-chat-version', '2');
  expect((await snapshot(page)).versionIds).toEqual([1, 2]);
  await page.getByRole('button', { name: /^Undo:/ }).focus();
  await page.keyboard.press('Enter');
  await expect(latest).toHaveAttribute('data-chat-version', '3');
  await expect(latest.getByRole('button', { name: 'Delete turn', exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('chat scrollbar is wider, draggable and keeps the node stationary in both themes', async ({ page, browserName, headless }, info) => {
  test.skip(browserName === 'firefox' && headless, 'Firefox headless hides native scrollbars. Run with SCATTER_TEST_HEADED=1.');
  test.setTimeout(60_000);
  await fixture(page);
  const card = page.locator('[data-node-id="deletion-chat"]');
  const scroll = card.locator('.chat-scroll');
  const position = (await snapshot(page)).position;
  for (const theme of ['latte', 'mocha']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await scroll.evaluate(element => { element.scrollTop = 0; });
    const geometry = await scroll.evaluate((element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, zoom: rect.height / element.clientHeight,
        gutter: element.offsetWidth - element.clientWidth,
        height: element.clientHeight, total: element.scrollHeight, cssWidth: getComputedStyle(element).scrollbarWidth };
    });
    expect(geometry.cssWidth).toBe('auto');
    // Linux Firefox can overlay its native scrollbar without reserving any
    // layout gutter. Chromium's explicitly sized scrollbar reserves 14px.
    if (browserName === 'chromium') expect(geometry.gutter).toBe(14);
    expect(geometry.total).toBeGreaterThan(geometry.height);
    const x = geometry.x + geometry.width - (geometry.gutter ? geometry.gutter / 2 : 3) * geometry.zoom;
    const y = geometry.y + (geometry.height * geometry.height / geometry.total / 2) * geometry.zoom;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 100, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
    expect((await snapshot(page)).position).toEqual(position);
    await card.screenshot({ path: info.outputPath(`chat-scrollbar-${theme}.png`) });
  }
});
