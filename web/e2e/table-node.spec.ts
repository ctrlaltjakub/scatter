import { expect, test, type Page } from '@playwright/test';

async function seed(page: Page, language = 'en', columns = 3, rows = 3) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox/chat');
  await page.locator('[data-node-id="chat-fixture"]').first().waitFor();
  await page.evaluate(({ language, columns, rows }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`table-${Date.now()}`], {}, (require: any) => {
      win.tableExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(name);
      };
    }]);
    const get = win.tableExport, graph = get('useGraphStore'), project = graph.getState().project;
    const old = project.nodes['chat-fixture'], version = old.versions[1];
    const sample = language === 'ar' ? 'توضيح المعلومات' : language === 'ja' ? '明確な説明。' : language === 'hi' ? 'स्पष्ट व्याख्याएँ' : 'Useful information';
    const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const table = [row(Array.from({ length: columns }, (_, i) => `Column ${i + 1}`)), row(Array(columns).fill('---')),
      ...Array.from({ length: rows }, () => row(Array(columns).fill(sample)))].join('\n');
    const node = { ...old, currentVersionIndex: 1, versions: [old.versions[0], { ...version, body: 'Before\n\n' + table + '\n\nAfter', language }],
      chat: { ...old.chat, turns: [old.chat.turns[0]] } };
    get('useSettingsStore').setState({ autoTermPreviews: false, autoFreeImages: false, cameraAutoPan: {} });
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, selection: [node.id], viewport: { x: 300, y: 100, zoom: .8 } });
    graph.setState({ panTo: null });
    get('useChatRuntimeStore').getState().view(node.id, { scrollTop: 0 });
  }, { language, columns, rows });
}

test('copies only the table, sizes it without clipping, and keeps the controls in order', async ({ page }, info) => {
  test.setTimeout(90_000);
  for (const language of ['en', 'ar', 'ja', 'hi']) {
    await seed(page, language);
    const actions = page.locator('.chat-table-actions').first();
    await expect(actions.getByRole('button')).toHaveText(['View table fullscreen', 'Copy to node', 'Copy table']);
    await actions.getByRole('button', { name: 'Copy to node', exact: true }).click();
    const id = await page.evaluate(() => {
      const graph = (window as any).tableExport('useGraphStore');
      const id = graph.getState().project.selection[0];
      const node = graph.getState().project.nodes[id];
      graph.getState().updateNode(id, { position: { x: 0, y: 0 } });
      graph.getState().updateNode('chat-fixture', { position: { x: -2000, y: 0 } });
      graph.setState({ panTo: null });
      return id;
    });
    const card = page.locator(`.node[data-node-id="${id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('table')).toHaveCount(1);
    await expect(card.locator('.chat-markdown')).not.toContainText('Before');
    await expect(card.locator('.chat-markdown')).not.toContainText('After');
    await expect.poll(() => card.evaluate(el => {
      const scroll = el.querySelector('.chat-scroll')!;
      const table = el.querySelector('.chat-table-scroll')!;
      return [scroll.scrollHeight - scroll.clientHeight, table.scrollWidth - table.clientWidth];
    })).toEqual([0, 0]);
    await page.screenshot({ path: info.outputPath(`table-node-${language}.png`) });
  }
});

test('large table copies cap the initial node while preserving scrollable content', async ({ page }) => {
  await seed(page, 'en', 15, 40);
  await page.locator('.chat-table-actions').first().getByRole('button', { name: 'Copy to node', exact: true }).click();
  const version = await page.evaluate(() => {
    const project = (window as any).tableExport('useGraphStore').getState().project;
    return project.nodes[project.selection[0]].versions[0];
  });
  expect(version.width).toBe(1200);
  expect(version.bodyMaxHeight).toBe(810);
  expect(version.body.split('\n')).toHaveLength(42);
});

test('table copying also works from the fullscreen viewer', async ({ page }) => {
  await seed(page);
  await page.locator('.chat-table-actions').first().getByRole('button', { name: 'View table fullscreen' }).click();
  const viewer = page.locator('[data-chat-table-viewer]');
  await expect(viewer).toBeVisible();
  await viewer.getByRole('button', { name: 'Copy to node', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  const copy = await page.evaluate(() => {
    const project = (window as any).tableExport('useGraphStore').getState().project;
    return project.nodes[project.selection[0]].versions[0];
  });
  expect(copy.markdownNote).toBe(true);
  expect(copy.body).not.toMatch(/Before|After/);
  expect(copy.body.split('\n')).toHaveLength(5);
  expect(copy.width).toBeLessThan(1200);
});
