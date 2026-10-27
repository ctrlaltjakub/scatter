import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium',
  viewport: { width: 1440, height: 1100 } });

const LINES = [
  'Dear **Dr. Richard D. Stith Jr.**, please contact **Capt. J. B. Vance** at **St. Jude Hospital** regarding Case No. 42.',
  'The urgent **consultation appt.** on **Elm St.** is confirmed for **approx. 10:30 a.m.**',
  'Please deliver the **dept. clinical records** to **Prof. H. G. Wells** at **Suite No. 7, 5th Ave.**',
  'Representatives from **Smith & Co. Ltd.** audited the **est. laboratory fees** vs. **actual billing records**.',
  'Gov. **A. E. Clark** requested **addl. sworn affidavits** from **Sen. T. R. Lee**.',
  'Please direct **all remaining corresp.** to **Mrs. M. St. Clair** at **No. 12 Park Blvd.**',
] as const;
const BODY = LINES.join('\n');
const VISIBLE_LINES = LINES.map(line => line.replace(/\*\*/g, ''));

async function fixture(page: Page) {
  // Fresh sandbox and synthetic credentials only. All non-app network access
  // is blocked; the in-page mock exercises the real streaming provider path.
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ body, firstLine }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`authored-generation-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const find = win.testExport, settings = find('useSettingsStore'), graph = find('useGraphStore');
    settings.setState({ generationLanguage: 'en', autoTermPreviews: false, autoFreeImages: false,
      providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-only',
        baseUrl: 'https://fixture.invalid/v1', enabledModels: ['fixture-main'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-main' },
      secondaryModelRef: { providerId: 'fixture', model: 'fixture-secondary' }, secondaryUseSameModel: false,
      webSearch: false, modelCompatibilityOverrides: { main: true, secondary: true },
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    const node = find('createChatNode')({ id: 'authored-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 760 });
    node.frozen = true;
    const project = { ...graph.getState().project, id: 'authored-generation-test', nodes: { [node.id]: node },
      rootNodeId: node.id, arrows: {}, groups: {}, selection: [node.id], viewport: { x: 440, y: 55, zoom: .85 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
    win.authoredRequests = [];
    win.releaseAuthoredMain = [];
    win.releaseAuthoredTerms = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { win.authoredClipboard = value; },
    } });
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (!url.startsWith('https://fixture.invalid/')) return realFetch(input, init);
      const request = JSON.parse(init!.body as string);
      win.authoredRequests.push(request);
      const main = request.model === 'fixture-main';
      const content = main ? body : JSON.stringify({
        terms: ['St. Jude Hospital', 'clinical records', 'laboratory fees', 'sworn affidavits'],
        chatTitle: 'Clinical correspondence',
      });
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const emit = (piece: string) => controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
        const finish = () => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
          controller.close();
        };
        const pieces = (main ? content.slice(firstLine.length) : content).match(/[\s\S]{1,47}/g) ?? [];
        let index = 0;
        const next = () => {
          if (index === pieces.length) { finish(); return; }
          emit(pieces[index++]!); setTimeout(next, 8);
        };
        if (main) { emit(firstLine); win.releaseAuthoredMain.push(next); }
        else win.releaseAuthoredTerms.push(next);
      } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  }, { body: BODY, firstLine: LINES[0] });
}

const version = (page: Page) => page.evaluate(() => {
  const node = (window as any).testExport('useGraphStore').getState().project.nodes['authored-chat'];
  return node.versions[node.currentVersionIndex];
});

test('generation, enrichment, copy and answer nodes preserve authored lines in both chunking modes', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await fixture(page);
  const card = page.locator('[data-node-id="authored-chat"]');
  const markdown = card.locator('.chat-markdown');
  await page.getByRole('textbox', { name: 'Chat message' }).fill('Write the six abbreviation examples.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();

  for (const chunked of [true, false]) {
    await expect(markdown).toContainText('Dr. Richard D. Stith Jr.');
    await expect.poll(async () => (await version(page)).body).toBe(LINES[0]);
    const mainRequest = await page.evaluate(() => (window as any).authoredRequests.filter((request: any) => request.model === 'fixture-main').at(-1));
    const system = mainRequest.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
    expect(system).toContain('exactly one complete sentence on each source line');
    expect(system).toContain('blank line');
    expect(system).toContain('abbreviations');
    expect(system).toContain(chunked ? 'Information chunking is ON' : 'Information chunking is OFF');
    await page.evaluate(() => (window as any).releaseAuthoredMain.splice(0).forEach((release: () => void) => release()));
    await expect.poll(async () => (await version(page)).chat.state).toBe('complete');
    await expect.poll(async () => (await version(page)).body).toBe(BODY);
    await expect.poll(() => page.evaluate(() => (window as any).releaseAuthoredTerms.length)).toBeGreaterThan(0);
    const lineSelector = chunked ? '.sc-ab-sentence' : '.sc-ab-flow-sentence';
    await expect(markdown.locator(lineSelector)).toHaveCount(6);
    expect(await markdown.locator(lineSelector).allTextContents()).toEqual(VISIBLE_LINES.map((line, index) => line + (index < 5 ? '\n' : '')));
    await page.evaluate(() => (window as any).releaseAuthoredTerms.splice(0).forEach((release: () => void) => release()));
    await expect(markdown.locator('.ref-chip')).toHaveCount(4);
    const marked = (await version(page)).body;
    expect(marked.replace(/\[\[|\]\]/g, '')).toBe(BODY);
    expect(marked.split('\n')).toHaveLength(6);
    await expect(markdown.locator(lineSelector)).toHaveCount(6);
    const displays = await markdown.locator(lineSelector).evaluateAll(elements => elements.map(element => getComputedStyle(element).display));
    expect(new Set(displays)).toEqual(new Set([chunked ? 'block' : 'inline']));
    const units = await page.evaluate(() => {
      const get = (window as any).testExport;
      const node = get('useGraphStore').getState().project.nodes['authored-chat'];
      return get('extractFactCheckUnits')(node.versions[node.currentVersionIndex]).map((unit: any) => unit.text);
    });
    expect(units).toEqual(VISIBLE_LINES);
    await card.getByRole('group', { name: 'Answer actions', exact: true }).getByRole('button', { name: 'Copy text', exact: true }).click();
    expect(await page.evaluate(() => (window as any).authoredClipboard)).toBe(BODY);
    await card.screenshot({ path: info.outputPath(`authored-chat-${chunked ? 'chunked' : 'flowing'}.png`) });
    if (chunked) {
      await page.getByRole('button', { name: /Information chunking: On/ }).click();
      // The chat toggle changes subsequent generations, not previous answers.
      expect((await version(page)).chat.informationChunking).toBe(true);
      await card.getByRole('button', { name: 'Regenerate', exact: true }).click();
    }
  }

  const finalBody = (await version(page)).body;
  const requestCount = await page.evaluate(() => (window as any).authoredRequests.length);
  await card.getByRole('button', { name: 'Copy to node', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).testExport('useGraphStore').getState().project.nodes).length)).toBe(2);
  const copy = await page.evaluate(() => {
    const project = (window as any).testExport('useGraphStore').getState().project;
    const copied = Object.values(project.nodes).find((node: any) => node.id !== 'authored-chat') as any;
    return { id: copied.id, version: copied.versions[copied.currentVersionIndex] };
  });
  expect(copy.version.body).toBe(finalBody);
  expect(copy.version.language).toBe('en');
  expect(copy.version.contentType).toBe('answer');
  expect(copy.version.chat.informationChunking).toBe(false);
  await expect(page.locator(`[data-node-id="${copy.id}"] .chat-markdown .ref-chip`)).toHaveCount(4);
  // Copying a fully enriched answer never makes a second term-marking request.
  expect(await page.evaluate(() => (window as any).authoredRequests.length)).toBe(requestCount);
  expect(errors).toEqual([]);
});
