import { expect, test } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

test('title edits preserve localized previews without any model request', async ({ page }) => {
  test.setTimeout(90_000);
  const requests: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
      const request = route.request().postDataJSON();
      requests.push(request);
      const preview = request.messages[0].content.includes('Return JSON concept explanations');
      const text = JSON.stringify(preview ? { previews: [{ id: 0, parts: [
        'Habituation ist die ', 'Abnahme einer Reaktion', ' nach ', 'wiederholter Darbietung', ' eines Reizes.',
      ] }] } : { terms: ['Habituation'] });
      await route.fulfill({ contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
      return;
    }
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`title-preview-test-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.testExport, settings = get('useSettingsStore'), graph = get('useGraphStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
      generationLanguage: 'en', cameraAutoPan: {} });
    const version: any = { header: 'Mémoire informatique', headerParts: { subject: 'Mémoire informatique' },
      body: 'Un [[cache]] conserve des données récentes.', language: 'fr', createdAt: 1,
      generatedBy: 'explain', contentType: 'explain', width: 600, bodyMaxHeight: 300 };
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version),
      entries: { cache: 'Un cache est une **mémoire temporaire** qui permet un **accès rapide** aux données.' } };
    const node = { id: 'title-preview', type: 'explain', frozen: true, position: { x: 0, y: 0 },
      versions: [version], currentVersionIndex: 0 };
    const project = { ...graph.getState().project, id: 'title-preview-test', nodes: { [node.id]: node }, arrows: {}, groups: {},
      rootNodeId: node.id, selection: [node.id], viewport: { x: 450, y: 130, zoom: .9 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id, panTo: null });
    settings.setState({ autoTermPreviews: true,
      providers: [{ id: 'fixture', preset: 'openrouter', apiKey: 'fixture-not-a-key', enabledModels: ['fixture-model'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-model' }, secondaryUseSameModel: true });
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable(); await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings.getState());
    const projects = await root.getDirectoryHandle('projects', { create: true });
    await write(projects, `${project.id}.json`, project);
    await write(projects, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
  });
  // The main route mounts both the background watcher and the full editor;
  // the physics sandbox deliberately mounts neither.
  await page.goto('/');
  await page.locator('[data-node-id="title-preview"]').waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`title-preview-runtime-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
  });
  const card = page.locator('[data-node-id="title-preview"]');
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Edit header', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit header', exact: true }).fill('Mes notes');
  await page.mouse.click(1350, 900);
  await expect(card.locator('.node-title').first()).toHaveText('Mes notes');
  const showPreview = async () => {
    await card.locator('.ref-chip:visible').first().hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'Un cache est une mémoire temporaire' })).toBeVisible();
  };
  await showPreview();
  await page.mouse.click(1350, 900);
  await card.click();
  if (!await page.getByRole('button', { name: 'Edit or export text', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Edit or export text', exact: true }).click();
  await page.getByRole('textbox', { name: 'Header', exact: true }).fill('Mes notes de révision');
  await page.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(card.locator('.node-title').first()).toHaveText('Mes notes de révision');
  await showPreview();
  expect(await page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['title-preview'];
    return node.versions[node.currentVersionIndex].language;
  })).toBe('fr');
  expect(requests).toEqual([]);

  // Reproduce an existing translated node whose saved generation language and
  // old preview still say English. Only explicit redo refreshes the cache.
  await page.evaluate(() => {
    const get = (window as any).testExport, graph = get('useGraphStore');
    const node = graph.getState().project.nodes['title-preview'];
    const index = node.currentVersionIndex;
    const version = { ...node.versions[index], language: 'en',
      body: 'Bei der [[Habituation]] nimmt eine Reaktion nach wiederholter Darbietung ab.' };
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version),
      entries: { habituation: 'Habituation is a decrease in response.' } };
    graph.getState().updateNode(node.id, { versions: node.versions.map((v: any, i: number) => i === index ? version : v) });
    get('useSettingsStore').setState({ generationLanguage: 'ja' });
  });
  await card.locator('.ref-chip:visible').first().hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Habituation is a decrease in response.' })).toBeVisible();
  expect(requests).toEqual([]);
  await card.locator('.node-header').click();
  await page.getByRole('button', { name: 'Redo term marking', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  await card.locator('.ref-chip:visible').first().hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Habituation ist die Abnahme einer Reaktion' })).toBeVisible();
  const previewRequest = requests.find(request => request.messages[0].content.includes('Return JSON concept explanations'));
  expect(previewRequest.messages[0].content).toContain('language of its surrounding source explanation');
  expect(previewRequest.messages[0].content).not.toContain('English (en-US)');
  expect(previewRequest.messages[0].content).not.toContain('Japanese (ja-JP)');
  expect(errors).toEqual([]);
});

test('encyclopedic bullet names preview their own descriptions without model requests', async ({ page }, info) => {
  const inference: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/chat/completions')) inference.push(url.href);
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`description-test-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.testExport, settings = get('useSettingsStore'), graph = get('useGraphStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    const version: any = { header: 'Intervals', createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic', width: 650, bodyMaxHeight: 320,
      body: 'Related concepts in music and mathematics.\n\n- Music\n  - Intervals: Distance measured in **cents** or semitones between two pitch points.\n  - Scales: Ordered collections of musical pitches.\n- Mathematics\n  - Intervals: Sets of numbers between two bounds.\n  - Bounds: The endpoints of a range.' };
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version), entries: {
      music: 'The study of sound.', mathematics: 'The study of quantities.', intervals: 'This old AI preview must not be used.',
    } };
    const node = { id: 'descriptions', type: 'root', frozen: true, position: { x: 0, y: 0 }, versions: [version], currentVersionIndex: 0 };
    const project = { ...graph.getState().project, id: 'description-test', nodes: { [node.id]: node }, arrows: {}, groups: {},
      rootNodeId: node.id, selection: [], viewport: { x: 470, y: 100, zoom: .9 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
    settings.setState({ autoTermPreviews: true,
      providers: [{ id: 'fixture', preset: 'openrouter', apiKey: 'fixture-not-a-key', enabledModels: ['google/gemini-3.8-flash'] }],
      activeModelRef: { providerId: 'fixture', model: 'google/gemini-3.8-flash' } });
  });
  const card = page.locator('[data-node-id="descriptions"]');
  const first = card.locator('[data-sc-source-field="b:0:c:0:name"] .ref-chip:visible');
  const second = card.locator('[data-sc-source-field="b:1:c:0:name"] .ref-chip:visible');
  await first.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Distance measured in cents' })).toBeVisible();
  await expect(page.getByRole('tooltip').locator('strong').filter({ hasText: 'cents' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('bullet-description-preview.png') });
  await second.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Sets of numbers between two bounds.' })).toBeVisible();
  await expect(page.getByText('This old AI preview must not be used.')).toHaveCount(0);
  expect(inference).toEqual([]);
  expect(errors).toEqual([]);
});

test('Redo terms preserves a manual mark, refreshes both previews, and renders emphasis', async ({ page }, info) => {
  const requests: any[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  // No real keys, network inference, cloud sync, or private project fixtures.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
      const request = route.request().postDataJSON();
      requests.push(request);
      const user = request.messages.at(-1).content;
      const preview = user.includes('"terms":');
      const text = JSON.stringify(preview ? { previews: [{ id: 0, parts: ['Refreshed cache preview ' + requests.length + '.'] }, { id: 1, parts: [
        'Aphex Twin is the alias of ', 'Richard D. James', ', a musician known for ', 'experimental electronic music', '.',
      ] }] } : { terms: ['Aphex Twin'] });
      await route.fulfill({ contentType: 'text/event-stream', body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    } else if (['localhost', '127.0.0.1'].includes(url.hostname)) await route.continue();
    else await route.abort();
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`preview-test-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.testExport, settings = get('useSettingsStore'), graph = get('useGraphStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    let node = get('createChatNode')({ id: 'preview-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 400 });
    node = get('appendChatAnswer')(node, { turnId: 'music', createdAt: 2, question: 'Explain this music example.' });
    node = get('updateChatAnswer')(node, { turnId: 'music', versionCreatedAt: 2 }, {
      body: 'A [[cache]] stores a recording by [[Aphex Twin]].', language: 'en',
    }, { state: 'complete' });
    const version = node.versions[node.currentVersionIndex];
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version), languageMode: 'source',
      manualTerms: ['cache'], entries: { cache: 'A cache is a **temporary store** that enables **faster access**.' }, exhaustedTerms: ['aphex twin'] };
    node.frozen = true;
    node.generating = false;
    node.streamingText = false;
    node.generatingVersionIndex = undefined;
    const project = { ...graph.getState().project, id: 'preview-test', nodes: { [node.id]: node },
      arrows: {}, groups: {}, rootNodeId: node.id, selection: [node.id], viewport: { x: 460, y: 100, zoom: .8 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
    settings.setState({ autoTermPreviews: true,
      providers: [{ id: 'fixture', preset: 'openrouter', apiKey: 'fixture-not-a-key', enabledModels: ['google/gemini-3.8-flash'] }],
      activeModelRef: { providerId: 'fixture', model: 'google/gemini-3.8-flash' }, secondaryUseSameModel: false,
      secondaryModelRef: { providerId: 'fixture', model: 'openai/gpt-6-luna' } });
  });
  const card = page.locator('[data-node-id="preview-chat"]');
  await expect(card.getByRole('status')).toContainText('Some term previews could not be generated');
  const redo = card.getByRole('button', { name: 'Redo terms', exact: true });
  await redo.click();
  await expect.poll(() => page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['preview-chat'];
    return node.versions[node.currentVersionIndex].termPreviews?.entries['aphex twin'];
  })).toContain('**Richard D. James**');
  await expect(card.getByText('Some term previews could not be generated', { exact: false })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests.every(request => request.model === 'openai/gpt-6-luna')).toBe(true);
  expect(JSON.parse(requests[1].messages.at(-1).content).terms).toEqual([{ id: 0, term: 'cache' }, { id: 1, term: 'Aphex Twin' }]);
  await card.locator('.chat-markdown').getByText('Aphex Twin', { exact: true }).hover();
  const preview = page.getByRole('tooltip').filter({ hasText: 'Richard D. James' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('strong').filter({ hasText: 'Richard D. James' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('recovered-preview.png') });
  await redo.click();
  await expect(redo).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['preview-chat'];
    return node.versions[node.currentVersionIndex].termPreviews.entries.cache;
  })).toBe('Refreshed cache preview 4.');
  expect(requests).toHaveLength(4); // one marking + one preview batch per explicit redo
  expect(errors).toEqual([]);
});
