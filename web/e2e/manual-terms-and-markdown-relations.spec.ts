import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function exportsFor(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`manual-terms-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
  });
}

async function setup(page: Page, kind: 'note' | 'explain', auto: boolean) {
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await exportsFor(page);
  await page.evaluate(async ({ kind, auto }) => {
    const get = (window as any).testExport, graph = get('useGraphStore'), settings = get('useSettingsStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    const body = kind === 'note' ? '# Notes\n\nA **selected phrase** can lead to exploration.\n\nA follow-up passage leads to a related question.\n\nA [[cache]] holds memory and storage.\n\nMemory can be reused.'
      : 'A [[cache]] holds memory and storage.\nMemory can be reused.\n\nThe [[**upper side**]]** and **[[**lower side**]]** receive input.**\n\nPlain text stays plain.';
    const version: any = { header: 'Synthetic notes', body, createdAt: 1, language: 'en', width: 700, bodyMaxHeight: 550,
      generatedBy: kind === 'note' ? 'manual' : 'explain', contentType: kind === 'note' ? 'answer' : 'explain',
      ...(kind === 'note' ? { markdownNote: true, chat: { turnId: 'note', title: 'Notes', question: '', state: 'complete', contextPath: [], informationChunking: false } } : {}) };
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version), languageMode: 'source', entries: {
      cache: 'A cache stores recently used data.', 'upper side': 'The upper part.', 'lower side': 'The lower part.',
    } };
    const node = { id: 'source', type: kind === 'note' ? 'manual-empty' : 'explain', frozen: true,
      position: { x: 0, y: 0 }, versions: [version], currentVersionIndex: 0 };
    const project = { ...graph.getState().project, id: 'manual-term-fixture', nodes: { source: node }, arrows: {}, groups: {},
      rootNodeId: 'source', selection: ['source'], viewport: { x: 500, y: 90, zoom: .9 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id, panTo: null });
    settings.setState({ autoTermPreviews: auto, secondaryUseSameModel: true,
      providers: [{ id: 'fixture', preset: 'openrouter', apiKey: 'fixture-not-a-key', enabledModels: ['fixture-model'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-model' } });
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true }); const stream = await file.createWritable();
      await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings.getState());
    const projects = await root.getDirectoryHandle('projects', { create: true });
    await write(projects, `${project.id}.json`, project);
    await write(projects, 'index.json', { activeId: project.id, items: [{ id: project.id, name: 'Synthetic test', createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
  }, { kind, auto });
  await page.goto('/');
  await exportsFor(page);
  await page.locator('[data-node-id="source"]').waitFor({ timeout: 20_000 });
  return page.locator('[data-node-id="source"]');
}

async function selectPhrase(page: Page, text: string) {
  await page.locator('[data-node-id="source"] .sc-ab-root, [data-node-id="source"] .chat-markdown').first().evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if ((node.parentElement?.closest('.sc-ab-measure, [aria-hidden="true"]'))) continue;
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + text.length);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      node.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return;
    }
    throw new Error(`Missing selectable phrase ${text}`);
  }, text);
  await expect(page.locator('.sc-sel-toolbar')).toBeVisible();
}

for (const auto of [false, true]) test(`manual term requests are independent and finish out of order (automatic previews=${auto})`, async ({ page }) => {
  test.setTimeout(120_000);
  const pending = new Map<string, () => Promise<void>>();
  const requests: string[][] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
      const request = route.request().postDataJSON();
      const terms = JSON.parse(request.messages.at(-1).content).terms.map((term: any) => term.term);
      requests.push(terms);
      await new Promise<void>(resolve => pending.set(terms[0], async () => {
        const text = JSON.stringify({ previews: [{ id: 0, parts: [`A ${terms[0]} explanation.`] }] });
        await route.fulfill({ contentType: 'text/event-stream', body:
          `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
        resolve();
      }));
      return;
    }
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const card = await setup(page, 'note', auto);
  await selectPhrase(page, 'memory');
  const toolbar = page.locator('.sc-sel-toolbar');
  expect(await toolbar.locator('button,a').allTextContents()).toEqual(['Copy', 'Web search', 'Mark term', 'Explore', 'Explain', 'Image']);
  // A generation or marking operation blocks this content edit; previews do not.
  await page.evaluate(() => (window as any).testExport('useGraphStore').getState().updateNode('source', { generating: true }));
  await expect(toolbar.getByRole('button', { name: 'Mark term' })).toBeDisabled();
  await page.evaluate(() => (window as any).testExport('useGraphStore').getState().updateNode('source', { generating: false }));
  await page.evaluate(() => (window as any).testExport('useNodeStatusStore').getState().setProcessStatus('source', 'fixture-marking', 'MARKING TERMS'));
  await expect(toolbar.getByRole('button', { name: 'Mark term' })).toBeDisabled();
  await page.evaluate(() => (window as any).testExport('useNodeStatusStore').getState().clearProcessStatus('source', 'fixture-marking'));
  await toolbar.getByRole('button', { name: 'Mark term' }).click();
  await expect.poll(() => pending.has('memory')).toBe(true);
  await selectPhrase(page, 'storage');
  await expect(toolbar.getByRole('button', { name: 'Mark term' })).toBeEnabled();
  await toolbar.getByRole('button', { name: 'Mark term' }).click();
  await expect.poll(() => pending.has('storage')).toBe(true);
  await pending.get('storage')!();
  await pending.get('memory')!();
  for (const term of ['memory', 'storage']) {
    await card.locator('.ref-chip:visible').filter({ hasText: term }).hover();
    await expect(page.getByRole('tooltip').filter({ hasText: `A ${term} explanation.` })).toBeVisible();
  }
  expect(requests).toEqual([['memory'], ['storage']]);
  const body = await page.evaluate(() => (window as any).testExport('useGraphStore').getState().project.nodes.source.versions[0].body);
  expect(body).toContain('[[memory]] and [[storage]]');
  expect(body).toContain('Memory can be reused.');
  expect(errors).toEqual([]);
});

test('Markdown Explore and selected follow-up persist source highlights, outlines and navigation', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
      const request = route.request().postDataJSON(), system = request.messages[0].content;
      const text = system.includes("route a user's follow-up") ? 'explore'
        : system.includes('REQUIRED RESPONSE FORMAT') ? '{"terms":[]}'
          : JSON.stringify({ header: 'Related topic', body: 'A compact opening.\n\n- First\n  - Detail: A useful detail.\n  - More: Another detail.\n- Second\n  - Detail: A useful detail.\n  - More: Another detail.' });
      await route.fulfill({ contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
      return;
    }
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const card = await setup(page, 'note', false);
  for (const [text, action] of [['selected phrase', 'explore'], ['follow-up passage', 'follow-up']] as const) {
    await selectPhrase(page, text);
    if (action === 'explore') await page.locator('.sc-sel-toolbar').getByRole('button', { name: 'Explore', exact: true }).click();
    else {
      await card.getByRole('textbox', { name: 'Follow-up question or modification' }).click();
      await card.getByRole('textbox', { name: 'Follow-up question or modification' }).fill('Why does this matter?');
      await card.getByRole('button', { name: 'Ask follow-up', exact: true }).click();
    }
    const mark = card.locator('.source-selection-mark').filter({ hasText: text }).first();
    await expect(mark).toBeVisible();
    const arrowId = await mark.getAttribute('data-arrow-id');
    expect(await page.evaluate(id => (window as any).testExport('useGraphStore').getState().project.arrows[id!].sourceAnswer, arrowId))
      .toEqual({ turnId: 'note', versionCreatedAt: 1 });
    const count = await page.locator('[data-node-id]').count();
    await mark.click();
    await expect(mark).toHaveClass(/active/);
    await expect(card.locator('.relation-active-outline').first()).toBeAttached();
    await expect.poll(() => page.evaluate(() => (window as any).testExport('useGraphStore').getState().highlight?.arrowId)).toBe(arrowId);
    expect(await page.locator('[data-node-id]').count()).toBe(count);
    await page.evaluate(() => (window as any).testExport('useGraphStore').getState().requestPanTo('source'));
    await expect(card.locator('.node-header').first()).toBeInViewport();
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
});

test('legacy bold terms render cleanly and remain clean after an editor save', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  const card = await setup(page, 'explain', false);
  const prose = card.locator('.sc-ab-root').first();
  await expect(prose).toContainText('The upper side and lower side receive input.');
  await expect(prose).not.toContainText('**');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Edit or export text', exact: true }).click();
  await page.locator('textarea[data-header-part="subject"]').fill('Saved synthetic notes');
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(prose).not.toContainText('**');
  await expect(prose).toContainText('The upper side and lower side receive input.');
  await expect(prose.locator('strong').filter({ hasText: 'Plain text stays plain.' })).toHaveCount(0);
});
