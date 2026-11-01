import { expect, test } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

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

test('Redo terms recovers an abbreviated-name preview, keeps completed previews, and renders emphasis', async ({ page }, info) => {
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
      const text = JSON.stringify(preview ? { previews: [{ id: 0, parts: [
        'Aphex Twin is the alias of ', 'Richard D. James', ', a musician known for ', 'experimental electronic music', '.',
      ] }] } : { terms: ['cache', 'Aphex Twin'] });
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
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version),
      entries: { cache: 'A cache is a **temporary store** that enables **faster access**.' }, exhaustedTerms: ['aphex twin'] };
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
  expect(JSON.parse(requests[1].messages.at(-1).content).terms).toEqual([{ id: 0, term: 'Aphex Twin' }]);
  await card.locator('.chat-markdown').getByText('Aphex Twin', { exact: true }).hover();
  const preview = page.getByRole('tooltip').filter({ hasText: 'Richard D. James' });
  await expect(preview).toBeVisible();
  await expect(preview.locator('strong').filter({ hasText: 'Richard D. James' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('recovered-preview.png') });
  await redo.click();
  await expect(redo).toBeEnabled();
  expect(requests).toHaveLength(3); // second redo only marks terms; both previews are already cached
  expect(await page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['preview-chat'];
    return node.versions[node.currentVersionIndex].termPreviews.entries.cache;
  })).toBe('A cache is a **temporary store** that enables **faster access**.');
  expect(errors).toEqual([]);
});
