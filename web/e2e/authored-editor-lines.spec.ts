import { expect, test, type Page } from '@playwright/test';

const body = 'First sentence. Same line.\n**Second source line.** This deliberately long authored line must wrap naturally while retaining its bold opening and its sentence boundaries. The continuation has enough text to show the hanging indentation and guide marks without inserting an extra authored break.\n\nAnother paragraph.';

async function fixture(page: Page, contentType: 'answer' | 'explain') {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(async ({ body, contentType }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`authored-lines-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const graph = win.testExport('useGraphStore');
    const settings = { ...win.testExport('useSettingsStore').getState(), autoTermPreviews: false, autoFreeImages: false,
      sentencePerLine: false, webSearch: false,
      providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', enabledModels: ['fixture-model'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-model' } };
    const node = { id: 'authored', type: 'manual-empty', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ createdAt: 1, header: 'Authored line boundaries', generatedBy: 'manual', contentType, body, language: 'en',
        ...(contentType === 'answer' ? { markdownNote: true, chat: { turnId: 'note', title: 'Authored line boundaries', question: '', state: 'complete', informationChunking: false, contextPath: [] } } : {}) }] };
    const project = { ...graph.getState().project, nodes: { authored: node }, arrows: {}, rootNodeId: 'authored', selection: ['authored'], viewport: { x: 600, y: 100, zoom: .85 } };
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable(); await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const projects = await root.getDirectoryHandle('projects', { create: true });
    await write(projects, `${project.id}.json`, project);
    await write(projects, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
  }, { body, contentType });
  await page.goto('/');
  await page.locator('[data-node-id="authored"] .node-header').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Edit or export text' }).click();
  // The editor is lazy-loaded; a cold dev build can need more than five seconds.
  await expect(page.locator('.text-editor-card')).toBeVisible({ timeout: 20_000 });
}

async function lineTop(page: Page, text: string, axis: 'top' | 'left' = 'top') {
  return page.locator('.text-editor-card .ProseMirror').evaluate((root, { text, axis }) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + text.length);
      return range.getBoundingClientRect()[axis];
    }
    throw new Error(`Missing editor text: ${text}`);
  }, { text, axis });
}

for (const contentType of ['explain', 'answer'] as const) {
  test(`${contentType} editor reveals authored lines without punctuation splitting or modifying content`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await fixture(page, contentType);
    const editor = page.locator('.text-editor-card .ProseMirror');
    await expect(editor.locator('.editor-soft-break')).toHaveCount(1);
    // ProseMirror may leave an empty style attribute after moving the caret
    // across an inline atom. It is presentation state, not a document edit.
    const html = async () => (await editor.innerHTML()).replace(/ style=""/g, '');
    const initial = await html();
    expect(await lineTop(page, 'First sentence.')).toBeCloseTo(await lineTop(page, 'Second source line.'), 0);
    await page.getByRole('button', { name: 'Information chunking: Off' }).click();
    await expect(editor.locator('.editor-soft-break')).toHaveCSS('white-space', 'pre-line');
    expect(await lineTop(page, 'Same line.')).toBeCloseTo(await lineTop(page, 'First sentence.'), 0);
    expect(await lineTop(page, 'Second source line.')).toBeGreaterThan(await lineTop(page, 'First sentence.') + 10);
    expect(Math.abs(await lineTop(page, 'Second source line.', 'left') - await lineTop(page, 'First sentence.', 'left'))).toBeLessThanOrEqual(1);
    await page.locator('.text-editor-card').screenshot({ path: info.outputPath(`${contentType}-authored-lines.png`) });
    await page.getByRole('button', { name: 'Information chunking: On' }).click();
    await expect.poll(html).toBe(initial);
    if (contentType === 'answer') {
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      const source = page.getByRole('textbox', { name: 'Markdown source' });
      await expect(source).toHaveValue(body);
      await source.fill(body + ' Latest edit.');
      await page.getByRole('button', { name: 'Information chunking: Off' }).click();
      await page.getByRole('button', { name: 'Visual', exact: true }).click();
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(source).toHaveValue(body + ' Latest edit.');
    }
    await page.getByRole('button', { name: 'Exit', exact: true }).click();
    await page.getByRole('button', { name: 'Edit or export text' }).click();
    if (contentType === 'answer') {
      await page.getByRole('button', { name: 'Source', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Markdown source' })).toHaveValue(body + ' Latest edit.');
    } else {
      await expect(editor.locator('.editor-soft-break')).toHaveCount(1);
      await expect.poll(html).toBe(initial);
    }
  });
}
