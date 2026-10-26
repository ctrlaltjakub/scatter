import { expect, test } from '@playwright/test';
import { INTERACTIVE_PLAN_FIXTURE, INTERACTIVE_REVIEW_FIXTURE } from '../src/test/interactiveFixture';

const HTML = `<!doctype html><html><head><title>Counter</title><style>
body{padding:30px;background:var(--sc-bg);color:var(--sc-text);font:20px sans-serif}
button{padding:12px;background:var(--sc-primary);color:var(--sc-on-primary)}
</style></head><body><h1>Counter</h1><output id="count">0</output>
<button id="add">Add one</button><button id="reset">Reset</button>
<script>let n=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=String(Math.min(1,++n));
document.querySelector('#reset').onclick=()=>{n=0;document.querySelector('#count').textContent='0';};</script></body></html>`;

test('generation starts with guidance and survives a simulated visibility interruption', async ({ page }, info) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ html, plan, review }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`visibility-${Date.now()}`], {}, (require: any) => {
      win.visibilityExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing export: ${name}`);
      };
    }]);
    const get = win.visibilityExport;
    get('useSettingsStore').setState({ providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-not-a-key', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' }, interactiveModelRef: undefined,
      autoTermPreviews: false, autoFreeImages: false, cameraAutoPan: {}, webSearch: false });
    get('useModelCatalogStore').getState().setCatalog('fixture', [{ id: 'fixture', caps: { vision: true, tools: false, textOutput: true } }]);
    const graph = get('useGraphStore'), project = graph.getState().project;
    const node = { id: 'visibility', type: 'interactive', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Interactive generation', body: '', createdAt: 1, generatedBy: 'manual', contentType: 'interactive',
        interactiveStandalone: true, width: 800, bodyMaxHeight: 573 }] };
    graph.getState().setProject({ ...project, id: 'visibility-regression', nodes: { visibility: node }, arrows: {}, rootNodeId: node.id,
      selection: [node.id], viewport: { x: 500, y: 80, zoom: 1 } });
    graph.setState({ activeProjectId: 'visibility-regression', panTo: null });
    win.modelCalls = 0;
    const planning = new Promise<void>(resolve => { win.releasePlanning = resolve; });
    get('getAdapter')('custom').streamChat = async function* (_key: string, options: any) {
      win.modelCalls++;
      if (win.modelCalls === 1) { await planning; yield { delta: JSON.stringify(plan), done: true }; }
      else if (options.conversation.some((message: any) => message.images?.length)) yield { delta: JSON.stringify(review), done: true };
      else yield { delta: html, done: true };
    };
    win.buildPromise = get('buildInteractiveNode')('visibility', 'Build a counter', 'create');
  }, { html: HTML, plan: INTERACTIVE_PLAN_FIXTURE, review: INTERACTIVE_REVIEW_FIXTURE });
  const notice = page.locator('.interactive-build-step.is-info');
  await expect(notice).toHaveText('Keep this tab visible during interactive generation. Browser checks may pause while the tab is in the background.');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => (window as any).visibilityExport('applyThemePreference')(theme), theme);
    await page.locator('.interactive-build').screenshot({ path: info.outputPath(`generation-notice-${theme}.png`) });
  }
  await page.evaluate(() => (window as any).releasePlanning());
  await page.locator('iframe[title="Checking interactive program"]').waitFor({ state: 'attached' });
  // Both Playwright engines force documents active (Chromium focus emulation;
  // Firefox docShell.forceActiveState). Exercise the lifecycle explicitly;
  // the workflow, disposable frames, assertions and screenshots remain real.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');
  await expect(page.locator('.interactive-build-step.is-paused')).toContainText('Verification paused — return to this tab to continue.');
  await expect(page.locator('iframe[title="Checking interactive program"]')).toHaveCount(0);
  // Exceed both original browser-check deadlines. Hidden time must not fail
  // the build, request another code pass, or retain an active verifier frame.
  await page.waitForTimeout(16_000);
  expect(await page.evaluate(() => {
    const win = window as any, node = win.visibilityExport('useGraphStore').getState().project.nodes.visibility;
    return { calls: win.modelCalls, generating: node.generating, error: node.generationError,
      repairs: node.versions[0].interactiveBuild.repairPasses };
  })).toEqual({ calls: 2, generating: true, error: undefined, repairs: 0 });
  await page.evaluate(() => {
    delete (document as unknown as { visibilityState?: string }).visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect(page.locator('.interactive-build-step.is-paused')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).visibilityExport('useGraphStore').getState().project.nodes.visibility.versions[0].interactiveBuild.state),
    { timeout: 40_000 }).toBe('complete');
  expect(await page.evaluate(() => (window as any).modelCalls)).toBe(3);
});
