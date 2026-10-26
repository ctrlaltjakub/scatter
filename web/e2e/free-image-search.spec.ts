import { expect, test } from '@playwright/test';

test('manual image search preserves queries, browses more results without AI, and emphasizes media instructions', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const queries: Array<{ source: string; query: string }> = [];
  let modelRequests = 0;
  const thumbnail = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="150"><rect width="240" height="150" fill="white"/><rect x="75" y="15" width="90" height="120" rx="3" fill="#284768"/><text x="120" y="65" text-anchor="middle" fill="white" font-size="14">Book</text><text x="120" y="85" text-anchor="middle" fill="white" font-size="14">photograph</text></svg>')}`;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'commons.wikimedia.org') {
      const offset = Number(url.searchParams.get('gsroffset') || 0);
      queries.push({ source: 'wikimedia', query: url.searchParams.get('gsrsearch')! });
      const pages = Array.from({ length: 16 }, (_, i) => ({ pageid: 1000 - offset - i, index: i + 1, title: `File:Book-${offset + i}.jpg`, imageinfo: [{
        url: `https://images.test/commons-${offset + i}.jpg`, thumburl: thumbnail, mime: 'image/jpeg', width: 240, height: 150,
        extmetadata: { ObjectName: { value: `Book photograph ${offset + i}` }, Artist: { value: 'Example author' }, LicenseShortName: { value: 'CC BY 4.0' } },
      }] })).reverse();
      return route.fulfill({ json: { query: { pages }, ...(offset === 0 ? { continue: { gsroffset: 24 } } : {}) } });
    }
    if (url.hostname === 'api.openverse.org') {
      const page = Number(url.searchParams.get('page') || 1);
      queries.push({ source: 'openverse', query: url.searchParams.get('q')! });
      return route.fulfill({ json: { page_count: 2, results: Array.from({ length: 16 }, (_, i) => ({
        id: `ov-${page}-${i}`, title: `Book page ${page}-${i}`, url: `https://images.test/ov-${page}-${i}.jpg`, thumbnail,
        foreign_landing_url: `https://images.test/work-${page}-${i}`, license: 'by', license_version: '4.0', creator: 'Example author',
      })) } });
    }
    if (url.hostname === 'openrouter.ai') modelRequests++;
    return ['127.0.0.1', '127.0.0.3', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`manual-images-${Date.now()}`], {}, (require: any) => {
      win.imageTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.imageTestExport;
    get('useSettingsStore').setState({ providers: [], activeModelRef: null, autoFreeImages: false, autoTermPreviews: false });
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    const node = { id: 'manual-images', type: 'root', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'House of Leaves', body: 'House of Leaves is a novel by Mark Z. Danielewski.\n\n- Typography\n  - Page layouts: Unusual typographical arrangements.', createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic', width: 600 }] };
    const media = { id: 'media-copy', type: 'media', frozen: true, position: { x: 0, y: 520 }, currentVersionIndex: 0,
      versions: [{ header: 'Media', body: get('MEDIA_EXPLAINER').replace(/\*\*/g, ''), createdAt: 2, generatedBy: 'media', contentType: 'media', width: 480 }] };
    graph.getState().setProject({ ...project, nodes: { [node.id]: node, [media.id]: media }, rootNodeId: node.id, arrows: {}, selection: [node.id], viewport: { x: 560, y: 85, zoom: 1 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  await page.getByRole('button', { name: 'Search for free images', exact: true }).click();
  const panel = page.locator('.wikimedia-panel');
  expect(queries).toHaveLength(0);
  await panel.getByRole('textbox', { name: 'Search free images' }).fill('"House of Leaves"');
  await panel.getByRole('button', { name: 'Search images', exact: true }).click();
  await expect(panel.locator('.wikimedia-result')).toHaveCount(32);
  expect(queries).toEqual([{ source: 'wikimedia', query: '"House of Leaves"' }, { source: 'openverse', query: '"House of Leaves"' }]);
  expect(modelRequests).toBe(0);
  await expect(panel.locator('.wikimedia-result-caption').first()).toHaveText('Book photograph 0');
  await panel.getByRole('button', { name: 'Load more images' }).click();
  await expect(panel.locator('.wikimedia-result')).toHaveCount(64);
  await expect(panel.getByRole('button', { name: 'Load more images' })).toHaveCount(0);
  expect(modelRequests).toBe(0);
  const media = page.locator('[data-node-id="media-copy"]');
  await expect(media.locator('strong', { hasText: 'paste a direct link' })).toBeVisible();
  await expect(media.locator('strong', { hasText: 'Ctrl-V' })).toBeVisible();
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await panel.locator('.citations-list').evaluate(list => { list.scrollTop = 0; });
    await page.mouse.move(1500, 1000);
    await panel.screenshot({ path: info.outputPath(`manual-search-${theme}.png`) });
    await media.screenshot({ path: info.outputPath(`media-instructions-${theme}.png`) });
  }
});
