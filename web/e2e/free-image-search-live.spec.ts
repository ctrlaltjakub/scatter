import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Opt-in, paid integration audit. Never capture traces containing provider keys.
test.use({ trace: 'off', viewport: { width: 1600, height: 1000 } });
test.skip(process.env.SCATTER_LIVE_IMAGE_SEARCH !== '1', 'Explicitly enable live image-search testing.');
test.setTimeout(240_000);

const cases = [
  { id: 'house', header: 'Influence of House of Leaves on culture', body: 'House of Leaves is Mark Z. Danielewski’s novel. Its unusual page layouts, nested narratives and impossible architecture influenced later experimental fiction and horror media. It uses footnotes, unconventional typography and multiple narrators. Its cultural reception is linked to ergodic literature and experimental reading practices.' },
  { id: 'neuron', header: 'Neuron anatomy', body: 'Neurons have a cell body, dendrites and an axon. Dendrites receive signals and the axon carries signals toward synaptic terminals. Labeled diagrams, microscopy and actual neuronal structures illustrate these parts.' },
  { id: 'therapy', header: 'Schema therapy', body: 'Schema therapy is an integrative psychotherapy approach developed by Jeffrey Young. It examines early maladaptive schemas and uses cognitive, experiential and interpersonal techniques. Techniques include imagery rescripting and empty-chair dialogue.' },
];

for (const fixture of cases) test(`live image relevance: ${fixture.id}`, async ({ page }, info) => {
  test.skip(!!process.env.SCATTER_IMAGE_CASE && process.env.SCATTER_IMAGE_CASE !== fixture.id);
  const key = process.env.SCATTER_E2E_OPENROUTER_KEY
    ?? readFileSync(resolve('..', '.agents/skills/openrouter-test/openrouter.key'), 'utf8').trim();
  const queries: string[] = [];
  const replies: string[] = [];
  const pending: Promise<void>[] = [];
  let modelCalls = 0;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/w/api.php') || url.hostname === 'api.openverse.org') queries.push(url.toString());
    if (url.hostname === 'openrouter.ai' && url.pathname.endsWith('/chat/completions')) modelCalls++;
  });
  page.on('response', response => {
    if (!response.url().includes('openrouter.ai/api/v1/chat/completions')) return;
    pending.push(response.text().then(raw => {
      const content = raw.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map(line => { try { return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? ''; } catch { return ''; } }).join('');
      replies.push(content || raw.slice(0, 2000));
    }).catch(() => {}));
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor({ timeout: 30_000 });
  await page.evaluate(({ key, fixture }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`image-audit-${Date.now()}`], {}, (require: any) => {
      win.imageAuditExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.imageAuditExport;
    const model = 'google/gemini-3.5-flash';
    get('useSettingsStore').setState({ autoFreeImages: false, autoTermPreviews: false, customPrompts: {},
      secondaryUseSameModel: true, providers: [{ id: 'audit', preset: 'openrouter', apiKey: key, enabledModels: [model] }],
      activeModelRef: { providerId: 'audit', model } });
    get('useModelCatalogStore').getState().setCatalog('audit', [{ id: model, caps: { textOutput: true, vision: true } }]);
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    const node = { id: 'image-audit', type: 'root', position: { x: 0, y: 0 }, frozen: true,
      currentVersionIndex: 0, versions: [{ ...fixture, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic', width: 650 }] };
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: node.id, arrows: {}, selection: [node.id],
      viewport: { x: 300, y: 100, zoom: .9 } });
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
  }, { key, fixture });
  await page.evaluate(() => (window as any).imageAuditExport('startWikimediaDiscovery')('image-audit', 1));
  const observation = await page.evaluate(() => {
    const get = (window as any).imageAuditExport;
    get('useCitationPanelStore').getState().openWikimedia('image-audit', 1);
    return { result: get('useGraphStore').getState().project.nodes['image-audit'].versions[0].imageRecommendations,
      tasks: get('useWikimediaTaskStore').getState().tasks };
  });
  await Promise.all(pending);
  const report = { fixture, modelCalls, queries, replies, ...observation };
  writeFileSync(info.outputPath('audit.json'), JSON.stringify(report, null, 2));
  await info.attach('image-search-audit.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify({ case: fixture.id, modelCalls, count: observation.result?.results.length,
    results: observation.result?.results.map((item: any) => ({ title: item.caption, relevance: item.relevance })), tasks: Object.values(observation.tasks).map((task: any) => ({ error: task.error, sourceOutcomes: task.sourceOutcomes })) }));
  await page.locator('.wikimedia-panel').screenshot({ path: info.outputPath('results.png') });
  expect(Object.values(observation.tasks).some((task: any) => task.error)).toBe(false);
  expect(observation.result?.results.length).toBeGreaterThan(0);
});

test('live direct catalog search and pagination without a model', async ({ page }) => {
  test.skip(!!process.env.SCATTER_IMAGE_CASE && process.env.SCATTER_IMAGE_CASE !== 'manual');
  let modelCalls = 0;
  page.on('request', request => { if (request.url().includes('/chat/completions')) modelCalls++; });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`direct-audit-${Date.now()}`], {}, (require: any) => {
      win.imageAuditExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.imageAuditExport;
    get('useSettingsStore').setState({ autoFreeImages: false, autoTermPreviews: false, providers: [], activeModelRef: null });
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    const node = { id: 'direct-audit', type: 'root', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'House of Leaves', body: 'A novel by Mark Z. Danielewski.', createdAt: 1, generatedBy: 'root' }] };
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: node.id, arrows: {}, selection: [node.id] });
    graph.setState({ activeProjectId: project.id });
  });
  const counts: number[] = [];
  for (const loadMore of [false, true]) {
    await page.evaluate(loadMore => (window as any).imageAuditExport('startWikimediaDiscovery')('direct-audit', 1,
      { manualQuery: '"House of Leaves"', loadMore }), loadMore);
    const result = await page.evaluate(() => (window as any).imageAuditExport('useGraphStore').getState().project.nodes['direct-audit'].versions[0].imageRecommendations);
    expect(result.sourceOutcomes).toEqual([{ source: 'wikimedia', status: 'success' }, { source: 'openverse', status: 'success' }]);
    expect(result.results.length).toBeGreaterThan(0);
    counts.push(result.results.length);
  }
  expect(counts[1]).toBeGreaterThan(counts[0]!);
  expect(modelCalls).toBe(0);
  console.log(JSON.stringify({ mode: 'direct', counts, modelCalls }));
});
