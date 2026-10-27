import { expect, test } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium',
  viewport: { width: 1440, height: 1100 } });

test('version navigation preserves background generation and captures the visible answer for continuation', async ({ page }) => {
  test.setTimeout(90_000);
  const gates = Array.from({ length: 3 }, () => {
    let release = () => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
  });
  const requests: any[] = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (url.hostname !== 'fixture.invalid') return route.abort();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const index = requests.push(route.request().postDataJSON()) - 1;
    if (gates[index]) await gates[index].promise;
    const content = [
      'A **cache** stores data. 日本語、हिन्दी، العربية, café and `mixed_code` stay intact.',
      '{"terms":["cache"]}',
      '{"previews":[{"id":0,"parts":["A cache is a ","temporary store"," that provides ","faster access"," to previously retrieved data."]}]}',
      'Follow-up completed.',
    ][index] ?? '{"terms":[]}';
    return route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`chat-background-${Date.now()}`], {}, (require: any) => {
      win.chatTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.chatTestExport;
    const settings = get('useSettingsStore');
    settings.setState({ providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture-not-a-real-key', enabledModels: ['fixture-model'] }], activeModelRef: { providerId: 'fixture', model: 'fixture-model' },
      secondaryUseSameModel: true, webSearch: false, autoTermPreviews: true, autoFreeImages: false,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    get('useModelCatalogStore').getState().setCatalog('fixture', [{ id: 'fixture-model', contextLength: 128000,
      caps: { tools: true, vision: true, textOutput: true } }]);
    let node = get('createChatNode')({ id: 'background-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 500 });
    node = get('appendChatAnswer')(node, { turnId: 'first', createdAt: 2, question: 'Original question' });
    node = get('updateChatAnswer')(node, { turnId: 'first', versionCreatedAt: 2 }, { body: 'Original answer chosen for continuation.' }, { state: 'complete' });
    node = { ...node, frozen: true, generating: false, streamingText: false, generatingVersionIndex: undefined,
      chat: { ...node.chat, titleManual: true } };
    const graph = get('useGraphStore');
    const project = { ...graph.getState().project, nodes: { [node.id]: node }, rootNodeId: node.id,
      arrows: {}, groups: {}, selection: [node.id], viewport: { x: 400, y: 55, zoom: .9 } };
    graph.getState().setProject(project);
    graph.setState({ activeProjectId: project.id, panTo: null });
    get('useChatRuntimeStore').getState().view(node.id, { atBottom: false, scrollTop: 0 });
  });
  const card = page.locator('[data-node-id="background-chat"]');
  const first = card.locator('[data-chat-turn="first"]');
  const warning = card.getByText('Alternative version — not used in later replies', { exact: true });
  const state = () => page.evaluate(() => {
    const node = (window as any).chatTestExport('useGraphStore').getState().project.nodes['background-chat'];
    return { selected: node.chat.turns[0].selectedVersionCreatedAt,
      answers: node.versions.filter((version: any) => version.chat?.turnId === 'first'), generating: node.generating };
  });
  try {
    await card.getByRole('button', { name: 'Regenerate', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    for (let stage = 0; stage < 3; stage++) {
      // Writing, marking and preview generation all remain active while their
      // answer is hidden. The user can return to it and away again each time.
      if (stage > 0) await first.getByRole('button', { name: 'Next answer' }).click();
      await expect(first.getByRole('button', { name: 'Previous answer' })).toBeEnabled();
      await first.getByRole('button', { name: 'Previous answer' }).click();
      await expect(first).toHaveAttribute('data-chat-version', '2');
      await expect(warning).toHaveCount(0);
      expect((await state()).selected).toBe(2);
      await first.getByRole('button', { name: 'Next answer' }).click();
      await expect(first).not.toHaveAttribute('data-chat-version', '2');
      await expect(warning).toHaveCount(0);
      await first.getByRole('button', { name: 'Previous answer' }).click();
      gates[stage]!.release();
      if (stage < 2) await expect.poll(() => requests.length).toBe(stage + 2);
    }
    await expect.poll(async () => (await state()).answers[1]?.termPreviews?.entries.cache)
      .toContain('**temporary store**');
    const finished = await state();
    expect(finished.generating).toBe(false);
    expect(finished.answers[1].body).toContain('**[[cache]]**');
    expect(finished.answers[1].chat.state).toBe('complete');
    await expect(first).toHaveAttribute('data-chat-version', '2');
    await card.getByRole('textbox', { name: 'Chat message' }).fill('Continue from this answer');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(4);
    expect(requests[3].messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.content))
      .toEqual(['Original answer chosen for continuation.']);
    await first.getByRole('button', { name: 'Next answer' }).click();
    await expect(warning).toHaveCount(1);
    expect((await state()).selected).toBe(2);
  } finally { gates.forEach(gate => gate.release()); }
});
