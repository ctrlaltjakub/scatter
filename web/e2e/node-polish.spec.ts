import { expect, test, type Page } from '@playwright/test';

// Isolated context; no inference, local model startup, or real provider keys.
async function fixture(page: Page) {
  await page.route('**/*', route => ['localhost', '127.0.0.3'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`test-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const graph = win.testExport('useGraphStore');
    const settings = win.testExport('useSettingsStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null });
    const node = win.testExport('createChatNode')({ id: 'chat-fixture', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 380 });
    node.frozen = true;
    const project = graph.getState().project;
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: 'other', arrows: {}, selection: [node.id], viewport: { x: 540, y: 60, zoom: 0.8 } });
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
  });
  await page.locator('[data-node-id="chat-fixture"]').waitFor();
}

test('side-panel disclosures animate exclusively in both themes', async ({ page }, info) => {
  await fixture(page);
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const group = page.getByRole('button', { name: 'Group', exact: true });
    const add = page.getByRole('button', { name: 'Add node', exact: true });
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await add.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(add).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Markdown text node', exact: true })).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath(`menus-${theme}.png`) });
    await add.click();
    await expect(page.getByRole('button', { name: 'Markdown text node', exact: true })).toBeHidden();
  }
});

test('chat stays painted when streaming completes and terms are applied', async ({ page }, info) => {
  await fixture(page);
  for (const zoom of [0.34, 0.36, 0.65, 1]) {
    await page.evaluate(zoom => {
      const find = (window as any).testExport;
      const graph = find('useGraphStore');
      const node = graph.getState().project.nodes['chat-fixture'];
      const next = find('appendChatAnswer')(node, { turnId: `t${zoom}`, createdAt: zoom * 1000, question: 'Explain cellular energy.' });
      graph.getState().updateNode(node.id, next);
      graph.getState().setViewport({ x: 540, y: 60, zoom });
    }, zoom);
    for (const stage of ['streaming', 'complete', 'marked']) {
      await page.evaluate(({ zoom, stage }) => {
        const find = (window as any).testExport;
        const graph = find('useGraphStore');
        const node = graph.getState().project.nodes['chat-fixture'];
        const text = stage === 'marked' ? '[[Mitochondria]] release energy from nutrients.' : 'Mitochondria release energy from nutrients.';
        const next = find('updateChatAnswer')(node, { turnId: `t${zoom}`, versionCreatedAt: zoom * 1000 },
          { body: Array.from({ length: 18 }, (_, n) => `${n + 1}. ${text} This process supports cellular functions.`).join('\n\n') },
          { state: stage === 'streaming' ? 'generating' : 'complete' });
        graph.getState().updateNode(node.id, { ...next, generating: stage === 'streaming', streamingText: stage === 'streaming' });
      }, { zoom, stage });
      await page.waitForTimeout(250);
      const detail = page.locator('[data-node-id="chat-fixture"] .node-detail-surface');
      if (zoom >= .35) {
        await expect(detail).toHaveCSS('opacity', '1');
        const dimensions = await page.locator('.chat-scroll').evaluate((el: HTMLElement) => ({
          height: el.clientHeight, top: el.scrollTop, total: el.scrollHeight,
          text: el.innerText.length, painted: el.getBoundingClientRect().height,
        }));
        expect(dimensions.height).toBeGreaterThan(100);
        expect(dimensions.text).toBeGreaterThan(300);
        expect(dimensions.top).toBeLessThanOrEqual(dimensions.total - dimensions.height + 1);
      }
    }
    await page.screenshot({ path: info.outputPath(`chat-${zoom}.png`) });
  }
});

test('real chat completion and enrichment keep messages visible at distant canvas coordinates', async ({ page }, info) => {
  test.setTimeout(60_000);
  await fixture(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const settings = find('useSettingsStore');
    settings.setState({ providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-only',
      baseUrl: 'http://127.0.0.1:9123/v1', enabledModels: ['fixture-main'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-main' },
      secondaryModelRef: { providerId: 'fixture', model: 'fixture-secondary' }, secondaryUseSameModel: false,
      webSearch: false, modelCompatibilityOverrides: { main: true, secondary: true } });
    const realFetch = window.fetch.bind(window);
    (window as any).releaseEnrichment = [];
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (!url.startsWith('http://127.0.0.1:9123/')) return realFetch(input, init);
      const request = JSON.parse(init!.body as string);
      const main = request.model === 'fixture-main';
      const text = main ? Array.from({ length: 24 }, (_, i) => `### Step ${i + 1}\n\nMitochondria convert nutrients into ATP. This process supports cellular functions.\n\n`).join('')
        : JSON.stringify({ terms: ['Mitochondria', 'ATP'], chatTitle: 'Cellular energy' });
      const pieces = text.match(/[\s\S]{1,100}/g)!;
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        let index = 0;
        const push = () => {
          if (index < pieces.length) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[index++] } }] })}\n\n`));
            setTimeout(push, main ? 30 : 15);
          } else {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          }
        };
        if (main) setTimeout(push, 20);
        else (window as any).releaseEnrichment.push(push);
      } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    };
    const graph = find('useGraphStore');
    graph.getState().updateNode('chat-fixture', { position: { x: 24000, y: 32000 } });
    graph.getState().setViewport({ x: 540 - 24000 * .8, y: 60 - 32000 * .8, zoom: .8 });
    void find('submitChat')('chat-fixture', { question: 'Explain cellular energy.' });
  });
  await expect(page.locator('.chat-markdown')).toContainText('Mitochondria', { timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['chat-fixture'];
    return node.generating;
  })).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).releaseEnrichment.length)).toBeGreaterThan(0);
  await expect(page.locator('.chat-markdown')).toContainText('Mitochondria');
  await page.screenshot({ path: info.outputPath('chat-term-marking.png') });
  await page.evaluate(() => (window as any).releaseEnrichment.splice(0).forEach((release: () => void) => release()));
  await expect(page.locator('.chat-markdown .ref-chip').first()).toBeAttached({ timeout: 10_000 });
  const visibleMessages = await page.locator('.chat-markdown').evaluate(el => {
    const viewport = el.closest('.chat-scroll')!.getBoundingClientRect();
    return [...el.querySelectorAll('p')].filter(p => {
      const rect = p.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom && p.checkVisibility({ contentVisibilityAuto: true });
    }).length;
  });
  expect(visibleMessages).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('chat-terms-complete.png') });
});
