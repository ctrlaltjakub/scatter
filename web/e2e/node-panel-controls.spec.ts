import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function fixture(page: Page) {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.route('**/*', route => ['localhost', '127.0.0.3', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`node-controls-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    win.testExport('useSettingsStore').setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null });
    const graph = win.testExport('useGraphStore');
    const node = win.testExport('createChatNode')({ id: 'test-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 350 });
    node.frozen = true;
    const project = graph.getState().project;
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: 'other', arrows: {}, groups: {},
      selection: [node.id], viewport: { x: 600, y: 70, zoom: 1 } });
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
  });
  await page.locator('[data-node-id="test-chat"] .chat-empty').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

test('chat can resize before, during, and after the first answer', async ({ page }) => {
  await fixture(page);
  const node = page.locator('[data-node-id="test-chat"]');
  const resize = async () => {
    const handle = node.locator('.node-resize.br');
    await expect(handle).toBeVisible();
    const before = (await node.boundingBox())!;
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await node.boundingBox())!.width).toBeCloseTo(before.width + 50, 0);
    await expect.poll(async () => (await node.boundingBox())!.height).toBeCloseTo(before.height + 40, 0);
  };
  await resize();
  await page.evaluate(() => {
    const win = window as any;
    const graph = win.testExport('useGraphStore');
    graph.getState().updateNode('test-chat', win.testExport('appendChatAnswer')(graph.getState().project.nodes['test-chat'],
      { turnId: 'first', createdAt: 2, question: 'A test question' }));
  });
  await resize();
  await page.evaluate(() => {
    const win = window as any;
    const graph = win.testExport('useGraphStore');
    const node = win.testExport('updateChatAnswer')(graph.getState().project.nodes['test-chat'],
      { turnId: 'first', versionCreatedAt: 2 }, { body: 'The completed answer.' }, { state: 'complete' });
    graph.getState().updateNode('test-chat', { ...node, generating: false, streamingText: false });
  });
  await resize();
  expect(await page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['test-chat'];
    return node.versions.map((v: any) => [v.width, v.bodyMaxHeight]);
  })).toEqual([[761, 470], [761, 470]]);
});

test('side panel ordering, Markdown editing, and quiet chunking state in both themes', async ({ page }, info) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(theme => (window as any).testExport('applyThemePreference')(theme), theme);
    for (const kind of ['chat', 'markdown', 'encyclopedic', 'explain', 'media', 'interactive', 'answer']) {
      await page.evaluate(kind => {
        const win = window as any;
        const graph = win.testExport('useGraphStore');
        const id = `panel-${kind}`;
        const node = kind === 'chat'
          ? win.testExport('createChatNode')({ id, createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 350 })
          : { id, type: 'term-click', position: { x: 0, y: 0 }, currentVersionIndex: 0,
            versions: [{ header: `${kind[0]!.toUpperCase()}${kind.slice(1)} node`, body: kind === 'media' || kind === 'interactive'
              ? '' : 'A sample introduction.\n\n- First section\n  - A short detail.', createdAt: 1, generatedBy: 'manual',
              contentType: kind === 'markdown' ? 'answer' : kind, markdownNote: kind === 'markdown', width: 650, bodyMaxHeight: 350,
              chat: kind === 'markdown' || kind === 'answer' ? { turnId: id, title: 'Text', question: '', state: 'complete',
                informationChunking: false, contextPath: [] } : undefined }] };
        node.frozen = true;
        graph.getState().setProject({ ...graph.getState().project, nodes: { [id]: node }, selection: [id],
          viewport: { x: 600, y: 70, zoom: 1 } });
        graph.getState().requestPanTo(null);
      }, kind);
      const panel = page.locator('.node-side-panel-stack .side-panel-content');
      const add = panel.getByRole('button', { name: 'Add node', exact: true });
      await expect(add).toBeVisible();
      await expect(add).toHaveClass(/side-action-add-node/);
      expect(await panel.locator('.versions-row').evaluate(el => el.nextElementSibling?.textContent)).toBe('Add node');
      expect(Number(await add.evaluate(el => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
      expect(await add.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
      expect(await add.locator('.side-action-icon').evaluate(el => getComputedStyle(el).color))
        .toBe(await add.locator('.side-action-label').evaluate(el => getComputedStyle(el).color));
      await expect(add.locator('.side-action-icon svg')).toHaveCSS('stroke-width', '2.5px');
      if (kind === 'chat') {
        const chunking = panel.getByRole('button', { name: /Information chunking:/ });
        const appearance = () => chunking.evaluate(el => {
          const css = getComputedStyle(el);
          return { background: css.backgroundColor, outline: css.outlineStyle, color: css.color };
        });
        await page.mouse.move(1450, 1050);
        await page.waitForTimeout(200);
        await expect(chunking).toHaveAttribute('aria-pressed', 'true');
        const enabled = await appearance();
        await chunking.click();
        await page.mouse.move(1450, 1050);
        await page.waitForTimeout(200);
        await expect(chunking).toHaveAttribute('aria-pressed', 'false');
        expect(await appearance()).toEqual(enabled);
        await chunking.click();
        await page.mouse.move(1450, 1050);
      }
      if (kind === 'markdown') {
        const edit = panel.getByRole('button', { name: 'Edit', exact: true });
        expect(await add.evaluate(el => el.nextElementSibling?.textContent)).toBe('Edit');
        await add.click();
        await expect(panel.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
        await edit.click();
        await expect(add).toHaveAttribute('aria-expanded', 'false');
        await expect(panel.getByRole('button', { name: 'Edit header', exact: true })).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Edit or export text' })).toBeVisible();
        await page.mouse.move(1450, 1050);
      }
      if (kind === 'explain') {
        await add.click();
        for (const name of ['Interactive node', 'Generate interactive explanation']) {
          const button = panel.getByRole('button', { name, exact: true });
          await expect(button.locator('.interactive-cost-icons svg')).toHaveCount(2);
          await expect(button).toHaveAttribute('data-tip', /Higher costs compared to the text or image nodes\./);
          expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        }
        await page.mouse.move(1450, 1050);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: info.outputPath(`${theme}-${kind}.png`) });
    }
  }
  expect(errors).toEqual([]);
});
