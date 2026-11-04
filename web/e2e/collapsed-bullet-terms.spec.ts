import { expect, test, type Page } from '@playwright/test';

async function fixture(page: Page, language = 'en', title = 'Network') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ language, title }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`collapsed-terms-${Date.now()}`], {}, (require: any) => {
      win.bulletExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing export: ${name}`);
      };
    }]);
    const graph = win.bulletExport('useGraphStore'), settings = win.bulletExport('useSettingsStore');
    settings.setState({ autoTermPreviews: true, autoFreeImages: false, providers: [], activeModelRef: null,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    const version: any = { header: title, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic', language,
      width: 650, bodyMaxHeight: 370,
      body: 'An opening paragraph.\n\n'+Array.from({length:6},(_,i)=>`- ${title} ${i}\n`+
        Array.from({length:4},(_,j)=>`  - Detail ${j}: A **local description** of this part, including enough context to explain its function in the broader network.`).join('\n')).join('\n') };
    version.termPreviews = { fingerprint: win.bulletExport('termPreviewFingerprint')(version),
      entries: Object.fromEntries(Array.from({length:6},(_,i)=>[`${title} ${i}`.toLowerCase(),`A **cached overview** for ${title} ${i}.`])) };
    const node = { id: 'collapsed-terms', type: 'root', frozen: true, position: {x:0,y:0}, versions:[version], currentVersionIndex:0 };
    const project = { ...graph.getState().project, id:'collapsed-bullet-test', nodes:{[node.id]:node}, arrows:{}, groups:{},
      rootNodeId:node.id, selection:[], viewport:{x:470,y:120,zoom:.9} };
    graph.getState().setProject(project); graph.setState({activeProjectId:project.id}); graph.getState().requestPanTo(null);
  }, {language,title});
  await page.evaluate(() => document.fonts.ready);
  const card = page.locator('[data-node-id="collapsed-terms"]');
  await expect(card.locator('.sc-ab-root > .sc-ab-list > .sc-ab-item[aria-expanded="false"]').first()).toBeVisible();
  return card;
}

for(const [language,title] of [['en','Network'],['ar','الشبكة'],['ja','ネットワーク'],['hi','नेटवर्क']]) {
  test(`collapsed level-1 terms preview, expand first and navigate second (${language})`, async ({page},info) => {
    const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
    const card = await fixture(page,language,title);
    const collapsed = card.locator('.sc-ab-root > .sc-ab-list > .sc-ab-item[aria-expanded="false"]').first();
    const anchor = await collapsed.getAttribute('data-sc-anchor');
    const bullet = card.locator(`[data-sc-anchor="${anchor}"]`);
    const term = bullet.locator('.sc-ab-title-text .ref-chip');
    await term.hover();
    const preview = page.getByRole('tooltip').filter({hasText:'cached overview'});
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute('dir',language==='ar'?'rtl':'ltr');
    await expect(preview).toHaveAccessibleName(/expand this bullet/);
    await page.screenshot({path:info.outputPath(`collapsed-title-preview-${language}.png`)});
    await term.click();
    await expect(bullet).toHaveAttribute('aria-expanded','true');
    await expect.poll(()=>page.evaluate(()=>Object.keys((window as any).bulletExport('useGraphStore').getState().project.nodes).length)).toBe(1);
    await expect.poll(()=>page.evaluate(()=>(window as any).bulletExport('useGraphStore').getState().project.selection)).toEqual(['collapsed-terms']);
    await term.click();
    await expect.poll(()=>page.evaluate(()=>Object.keys((window as any).bulletExport('useGraphStore').getState().project.nodes).length)).toBe(2);
    expect(errors).toEqual([]);
  });
}

test('collapsed level-2 terms preview and expand on keyboard or Ctrl-click without spawning', async ({page}) => {
  const card = await fixture(page);
  const first = card.locator('.sc-ab-root > .sc-ab-list > .sc-ab-item[aria-expanded="false"] .sc-ab-inline .ref-chip').first();
  await expect(first).toBeVisible();
  const anchor=await first.evaluate(el=>el.closest('[data-sc-anchor]')!.getAttribute('data-sc-anchor'));
  const bullet=card.locator(`[data-sc-anchor="${anchor}"]`);
  await first.hover();
  await expect(page.getByRole('tooltip').filter({hasText:'A local description'})).toBeVisible();
  await first.click({modifiers:['Control']});
  await expect(bullet).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(()=>Object.keys((window as any).bulletExport('useGraphStore').getState().project.nodes).length)).toBe(1);
  const next=card.locator('.sc-ab-root > .sc-ab-list > .sc-ab-item[aria-expanded="false"]').first();
  const nextAnchor=await next.getAttribute('data-sc-anchor');
  await next.locator('.sc-ab-title-text .ref-chip').focus();
  await page.keyboard.press('Enter');
  await expect(card.locator(`[data-sc-anchor="${nextAnchor}"]`)).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(()=>Object.keys((window as any).bulletExport('useGraphStore').getState().project.nodes).length)).toBe(1);
});
