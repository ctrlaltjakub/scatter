import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Explicit opt-in: normal suites never spend tokens or load a personal key.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test('live interactive planning, HTML fallback, browser outcomes and screenshot review', async ({ page }, info) => {
  test.skip(process.env.SCATTER_LIVE_INTERACTIVE !== '1', 'Paid live-model check is opt-in.');
  test.setTimeout(600_000);
  const p2p = process.env.SCATTER_INTERACTIVE_CASE === 'p2p';
  const useTools = process.env.SCATTER_INTERACTIVE_TOOLS === '1';
  const apiKey = (await readFile('../.agents/skills/openrouter-test/openrouter.key', 'utf8')).trim();
  if (process.env.SCATTER_INTERACTIVE_CHECK_RESULT) {
    // Re-verify a real previously generated program after changing the gate.
    // Replay parsed plan/code, not raw captured SSE (browser debug protocols
    // may decode response bodies differently from the app's UTF-8 stream).
    const path = process.env.SCATTER_INTERACTIVE_CHECK_RESULT;
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const responses: string[] = JSON.parse(await readFile(join(dirname(path), 'live-provider-responses.json'), 'utf8'));
    const plan = responses[0]!.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .flatMap(line => { try { return [JSON.parse(line.slice(6))]; } catch { return []; } })
      .map(event => event.choices?.[0]?.delta?.content ?? '').join('');
    expect(saved.html).toMatch(/^<!doctype/i);
    let replayed = 0;
    await page.route('https://openrouter.ai/api/v1/chat/completions', async route => {
      if (replayed >= 2) { await route.continue(); return; }
      const delta = replayed++ === 0 ? { content: plan } : useTools
        ? { tool_calls: [{ index: 0, id: 'existing-program', type: 'function', function: { name: 'write_document', arguments: JSON.stringify({ html: saved.html }) } }] }
        : { content: saved.html };
      const body = `data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: Buffer.from(body, 'utf8') });
    });
  }
  const responses: string[] = [];
  page.on('response', response => {
    if (response.url() === 'https://openrouter.ai/api/v1/chat/completions') void response.body().then(body => responses.push(body.toString('utf8'))).catch(() => {});
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ apiKey, p2p, useTools }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`live-interactive-${Date.now()}`], {}, (require: any) => {
      win.interactiveTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.interactiveTestExport;
    get('useSettingsStore').setState({ providers: [{ id: 'live-test', preset: 'openrouter', apiKey, enabledModels: ['google/gemini-3.5-flash'] }],
      activeModelRef: { providerId: 'live-test', model: 'google/gemini-3.5-flash' }, interactiveModelRef: undefined,
      interactiveOutputTokenCap: 50000, interactiveReasoningEffort: 'low', autoTermPreviews: false, autoFreeImages: false, webSearch: false, generationLanguage: 'en', customPrompts: undefined });
    // Test either real tool editing or the full-document fallback, while
    // retaining the repository's required model/reasoning configuration.
    get('useModelCatalogStore').getState().setCatalog('live-test', [{ id: 'google/gemini-3.5-flash', contextLength: 1000000, caps: { tools: useTools, vision: true, textOutput: true } }]);
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    graph.setState({ activeProjectId: project.id });
    const parentId = project.rootNodeId;
    const id = get('spawnInteractiveNode')(parentId, false);
    win.liveInteractiveId = id;
    graph.getState().updateNode(id, { frozen: true, position: { x: 0, y: 0 } });
    const updated = graph.getState().project;
    graph.setState({ project: { ...updated, nodes: { [id]: updated.nodes[id] }, arrows: {}, rootNodeId: id,
      viewport: { x: 470, y: 85, zoom: 0.85 } }, panTo: null });
    void get('buildInteractiveNode')(id, p2p ? 'Explain to me in an interactive way how does the P2P protocol work?'
      : 'Build a small voltage/resistance/current calculator using Ohm’s law. Include labeled numeric inputs (12 V and 6 ohms initially), a clearly visible current result, reset, a small SVG circuit or current visualization, and an explicit error for zero/negative resistance. Keep the code short, no more than about 150 lines. Use deterministic state and exact numeric readouts. No extra features.', 'create');
  }, { apiKey, p2p, useTools });
  const log = page.locator('[aria-label="Interactive build progress"]');
  await expect(log).toBeVisible();
  await page.screenshot({ path: info.outputPath('live-interactive-planning.png') });
  await expect.poll(() => page.evaluate(() => {
    const win = window as any;
    return win.interactiveTestExport('useGraphStore').getState().project.nodes[win.liveInteractiveId]?.generating;
  }), { timeout: 570_000, intervals: [1000, 2000] }).toBe(false);
  const result = await page.evaluate(() => {
    const win = window as any;
    const node = win.interactiveTestExport('useGraphStore').getState().project.nodes[win.liveInteractiveId];
    const version = node.versions[node.currentVersionIndex];
    return { state: version.interactiveBuild?.state, error: version.interactiveBuild?.error, steps: version.interactiveBuild?.steps,
      html: version.interactive?.html, draft: version.interactiveBuild?.draftHtml };
  });
  await writeFile(info.outputPath('live-interactive-result.json'), JSON.stringify(result, null, 2));
  await writeFile(info.outputPath('live-provider-responses.json'), JSON.stringify(responses));
  expect(result.error, JSON.stringify(result.steps)).toBeUndefined();
  expect(result.state).toBe('complete');
  expect(result.steps.some((step: any) => step.label.includes('Reviewing screenshots') && step.state === 'complete')).toBe(true);
  // Visual inspection of the actual generated document in both themes.
  for (const mode of ['light', 'dark']) {
    await page.evaluate(({ html, mode }) => {
      const get = (window as any).interactiveTestExport;
      const theme = { ...get('DEFAULT_INTERACTIVE_HOST_STATE').theme,
        ...(mode === 'dark' ? { mode: 'dark', background: '#171717', surface: '#222', surfaceRaised: '#292929', text: '#eee', muted: '#aaa', border: '#555', primary: '#a4c5b8' } : {}) };
      document.querySelector('#live-result')?.remove();
      const frame = document.createElement('iframe'); frame.id = 'live-result'; frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;left:20px;top:20px;width:960px;height:720px;border:0;z-index:2147483647';
      frame.srcdoc = get('buildInteractiveSrcDoc')(html, 'live-result', { active: true, theme }); document.body.appendChild(frame);
    }, { html: result.html, mode });
    await expect(page.frameLocator('#live-result').locator('button').first()).toBeVisible();
    await page.locator('#live-result').screenshot({ path: info.outputPath(`live-interactive-${mode}.png`) });
  }
});
