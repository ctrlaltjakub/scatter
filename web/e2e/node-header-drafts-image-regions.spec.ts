import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function expose(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`node-edit-test-${Date.now()}`], {}, (require: any) => {
      win.nodeEditExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
  });
}
async function start(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await expose(page);
  await page.evaluate(() => (window as any).nodeEditExport('useSettingsStore').setState({
    providers: [], activeModelRef: null, autoTermPreviews: false, autoFreeImages: false, webSearch: false,
    cameraAutoPan: {},
  }));
}
async function seed(page: Page, kind: string, chain = false) {
  await page.evaluate(({ kind, chain }) => {
    const get = (window as any).nodeEditExport;
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 440;
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#f6eee2'; c.fillRect(0, 0, 700, 440);
    for (const [x, y, color] of [[70, 70, '#a13838'], [450, 70, '#3174a8'], [450, 280, '#43835a']] as const) {
      c.fillStyle = color; c.fillRect(x, y, 100, 100);
    }
    const media = { source: 'link', kind: 'image', url: canvas.toDataURL('image/jpeg'), naturalWidth: 700, naturalHeight: 440, mime: 'image/jpeg' };
    const version = { header: 'Example header', body: kind === 'media' ? '' : 'A short opening paragraph.\n\n- **A topic**\n  - A detail: More information.',
      createdAt: 1, generatedBy: 'manual', contentType: kind, language: 'en', width: 700, bodyMaxHeight: 440,
      ...(kind === 'media' ? { media } : {}),
      ...(kind === 'answer' ? { markdownNote: true, chat: { turnId: 'note', title: 'Example header', question: '', state: 'complete', contextPath: [] } } : {}),
      ...(kind === 'interactive' ? { interactive: { html: '<!doctype html><html><body><p>Interactive example</p></body></html>', request: 'example', providerId: 'test', model: 'test', viewportSize: 580 } } : {}),
    };
    const node = kind === 'chat'
      ? { ...get('createChatNode')({ id: kind, createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 440 }), frozen: true }
      : { id: kind, type: kind === 'encyclopedic' ? 'root' : kind, frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0, versions: [version] };
    const child = { id: 'child', type: 'explain', frozen: true, position: { x: 880, y: 280 }, currentVersionIndex: 0,
      versions: [{ header: 'Related answer', body: 'This answer refers to all three selected areas.', createdAt: 2, generatedBy: 'manual', contentType: 'explain', width: 320, bodyMaxHeight: 100 }] };
    graph.getState().setProject({ ...project, id: 'node-edit-regression', nodes: { [node.id]: node, ...(chain ? { child } : {}) },
      arrows: chain ? { relation: { id: 'relation', kind: 'auto', fromNodeId: kind, toNodeId: 'child', sourceImage: { sourceMedia: media,
        regions: [{ x: .08, y: .12, width: .19, height: .3 }, { x: .62, y: .12, width: .19, height: .3 }, { x: .62, y: .6, width: .19, height: .3 }] } } } : {},
      rootNodeId: node.id, selection: [node.id], viewport: { x: 590, y: 130, zoom: chain ? .7 : .9 } });
    graph.setState({ activeProjectId: 'node-edit-regression', panTo: null });
    (window as any).headerBefore = node.chat?.title ?? version.header;
  }, { kind, chain });
  await expect(page.locator(`[data-node-id="${kind}"]`)).toBeVisible();
}

test('Add node follows a live image selection and uses the existing atlas arrow', async ({ page }, info) => {
  await start(page);
  await seed(page, 'media');
  const surface = page.locator('[data-image-selection-surface]');
  await expect(surface).toBeVisible();
  const image = surface.locator('img');
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(700);
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toBeVisible();
  const box = (await image.boundingBox())!;
  const drag = async (x: number, y: number) => {
    await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (x + .16), box.y + box.height * (y + .22), { steps: 6 });
    await page.mouse.up();
  };
  await drag(.1, .12);
  await expect(page.getByRole('button', { name: 'Add node (selection)', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add node', exact: true })).toBeVisible();
  await drag(.1, .12);
  await page.keyboard.down('Control');
  await drag(.6, .5);
  await page.keyboard.up('Control');
  const captured = await page.evaluate(() => (window as any).nodeEditExport('useImageSelectionStore').getState().selection.regions);
  expect(captured).toHaveLength(2);
  await page.getByRole('button', { name: 'Add node (selection)', exact: true }).click();
  await page.getByRole('button', { name: 'Markdown text node', exact: true }).click();
  await expect(page.locator('[data-node-id]')).toHaveCount(2);
  const arrow = await page.evaluate(() => Object.values((window as any).nodeEditExport('useGraphStore').getState().project.arrows)[0] as any);
  expect(arrow.sourceImage.regions).toEqual(captured);
  const frame = page.locator(`[data-image-atlas="media"] [data-image-atlas-frame="${arrow.id}"]`);
  const interior = page.locator(`[data-image-arrow-interior="${arrow.id}"]`);
  await expect(frame).toBeAttached();
  await expect(interior).toBeAttached();
  expect(await frame.getAttribute('stroke-dasharray')).toBe(await interior.getAttribute('stroke-dasharray'));
  await expect(page.locator('.image-region-overlay')).toHaveCount(0);
  await page.mouse.move(1500, 100);
  await page.screenshot({ path: info.outputPath('selection-node-atlas.png') });
});

for (const [kind, label] of [['chat', 'Chat'], ['encyclopedic', 'Encyclopedic node'], ['explain', 'Explanation']]) {
  test(`selected-image Add node supplies whole image and region to ${kind} generation`, async ({ page }) => {
    test.setTimeout(90_000);
    const requests: any[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await start(page);
    await page.route('https://fixture.invalid/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const payload = route.request().postDataJSON();
      requests.push(payload);
      const system = payload.messages?.[0]?.content ?? '';
      const content = system.includes('REQUIRED RESPONSE FORMAT') ? '{"terms":[]}'
        : kind === 'encyclopedic' ? 'The selected **red square** is a **four-sided shape**.\n\n- Shape\n  - Sides: Four edges surround it.\n  - Corners: Four right angles meet.\n- Color\n  - Fill: The surface is red.\n  - Contrast: The background is pale.'
          : 'The selected **red square** is a **four-sided shape**.';
      await route.fulfill({ contentType: 'text/event-stream', headers: { 'access-control-allow-origin': '*' },
        body: `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` });
    });
    await seed(page, 'media');
    await page.evaluate(() => {
      const get = (window as any).nodeEditExport;
      const settings = get('useSettingsStore');
      settings.setState({ providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', enabledModels: ['vision'] }],
        activeModelRef: { providerId: 'fixture', model: 'vision' }, secondaryUseSameModel: true, generationLanguage: 'en',
        cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
      get('useModelCatalogStore').getState().setCatalog('fixture', [{ id: 'vision', contextLength: 128000,
        caps: { tools: true, vision: true, textOutput: true } }]);
    });
    const image = page.locator('[data-image-selection-surface] img');
    await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(700);
    const box = (await image.boundingBox())!;
    await page.mouse.move(box.x + box.width * .08, box.y + box.height * .12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .26, box.y + box.height * .42, { steps: 6 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Add node (selection)', exact: true }).click();
    await page.getByRole('button', { name: label, exact: true }).click();
    const id = await page.evaluate(() => {
      const graph = (window as any).nodeEditExport('useGraphStore');
      const project = JSON.parse(JSON.stringify(graph.getState().project));
      const id = project.selection[0];
      const node = project.nodes[id];
      // Restore the saved child independently, as when its original image was
      // deleted or this branch was imported into another project.
      node.position = { x: 0, y: 0 }; node.frozen = true;
      graph.setState({ project: { ...project, nodes: { [id]: node }, rootNodeId: id, arrows: {}, viewport: { x: 520, y: 100, zoom: .8 } }, panTo: null });
      return id;
    });
    expect(requests).toHaveLength(0);
    const prompt = page.getByRole('textbox', { name: kind === 'chat' ? 'Chat message' : 'Node generation prompt', exact: true });
    await prompt.fill('What is this?');
    await page.getByRole('button', { name: kind === 'chat' ? 'Send message' : 'Generate', exact: true }).click();
    await expect.poll(() => requests.filter(request => request.messages?.some((message: any) => Array.isArray(message.content)
      && message.content.some((part: any) => part.type === 'image_url'))).length).toBe(1);
    const request = requests.find(request => request.messages?.some((message: any) => Array.isArray(message.content)));
    const parts = request.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }]);
    const urls = parts.filter((part: any) => part.type === 'image_url').map((part: any) => part.image_url.url);
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(parts.map((part: any) => part.text ?? '').join('\n')).toContain('If the request is unrelated, answer it without forcing a connection');
    const sizes = await page.evaluate(async (urls: string[]) => Promise.all(urls.map(url => new Promise<number[]>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = reject; image.src = url;
    }))), urls);
    expect(sizes[0]).toEqual([700, 440]);
    expect(sizes[1]![0]).toBeLessThan(200);
    expect(sizes[1]![1]).toBeLessThan(200);
    await expect(page.locator(`[data-node-id="${id}"]`)).toContainText('four-sided shape');
    await expect.poll(() => page.evaluate(id => (window as any).nodeEditExport('useGraphStore').getState().project.nodes[id].generating, id)).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('simple headers edit seamlessly from every side panel and save on outside click', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await start(page);
  for (const kind of ['media', 'encyclopedic', 'chat', 'answer', 'interactive']) {
    await seed(page, kind);
    if (kind === 'encyclopedic') {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.locator(`#node-text-tools-${kind} button`).first()).toHaveText('Edit header');
    }
    await page.getByRole('button', { name: 'Edit header', exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Edit header', exact: true });
    await expect(title).toBeFocused();
    expect(await title.evaluate(element => {
      const range = window.getSelection()!.getRangeAt(0).cloneRange();
      range.setStart(element, 0);
      return range.toString() === element.textContent;
    })).toBe(true);
    await page.keyboard.type(' renamed');
    if (kind === 'media') for (const theme of ['mocha', 'latte']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.screenshot({ path: info.outputPath(`inline-header-${theme}.png`), animations: 'disabled', caret: 'initial' });
    }
    await page.mouse.click(1500, 900);
    await expect(title).toHaveCount(0);
    expect(await page.evaluate(kind => {
      const node = (window as any).nodeEditExport('useGraphStore').getState().project.nodes[kind];
      return node.chat?.title ?? node.versions[0].header;
    }, kind)).toBe(await page.evaluate(() => (window as any).headerBefore + ' renamed'));
    await page.evaluate(() => (window as any).nodeEditExport('useGraphStore').temporal.getState().undo());
    expect(await page.evaluate(kind => {
      const node = (window as any).nodeEditExport('useGraphStore').getState().project.nodes[kind];
      return node.chat?.title ?? node.versions[0].header;
    }, kind)).toBe(await page.evaluate(() => (window as any).headerBefore));
  }
  await seed(page, 'encyclopedic');
  await page.evaluate(() => {
    const graph = (window as any).nodeEditExport('useGraphStore');
    const node = graph.getState().project.nodes.encyclopedic;
    graph.getState().updateNode(node.id, { versions: [{ ...node.versions[0], headerParts: { subject: 'A subject', question: 'Why?', suffix: 'explained' } }] });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit header', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('bottom-panel drafts survive deselection and a browser reload for every node kind', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  for (const kind of ['media', 'encyclopedic', 'explain', 'answer', 'interactive', 'chat']) {
    await seed(page, kind);
    const prompt = page.locator('.node-followup-bar textarea');
    await prompt.fill(`Unsent ${kind} question 日本語 العربية`);
    await page.mouse.click(1500, 900);
    await expect(prompt).toHaveCount(0);
    await page.locator(`[data-node-id="${kind}"] .node-header`).click();
    await expect(prompt).toHaveValue(`Unsent ${kind} question 日本語 العربية`);
  }
  await page.reload();
  await page.locator('[data-node-id]').first().waitFor();
  await expose(page);
  for (const kind of ['media', 'encyclopedic', 'explain', 'answer', 'interactive', 'chat']) {
    await seed(page, kind);
    await expect(page.locator('.node-followup-bar textarea')).toHaveValue(`Unsent ${kind} question 日本語 العربية`);
  }
});

test('separate image selections form a dotted chain using the arrow ink in both themes', async ({ page }, info) => {
  await start(page);
  await seed(page, 'media', true);
  const node = page.locator('[data-node-id="media"]');
  const links = node.locator('.image-atlas-layer [data-image-region-connectors="relation"]');
  await expect(links).toBeAttached();
  expect((await links.getAttribute('d'))!.match(/M/g)).toHaveLength(2);
  const frame = node.locator('.image-atlas-layer [data-image-atlas-frame="relation"]');
  expect(await links.getAttribute('stroke-dasharray')).toBe(await frame.getAttribute('stroke-dasharray'));
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.mouse.move(1500, 900);
    await page.screenshot({ path: info.outputPath(`image-selection-chain-${theme}.png`), animations: 'disabled' });
  }
});

test('an accepted image question clears immediately, before the model responds', async ({ page }) => {
  await start(page);
  await seed(page, 'media');
  // Hold an entirely local stub response. No paid request leaves the browser.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('https://fixture.invalid/v1/chat/completions', async route => {
    requested = true;
    await gate;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'End of fixture test' } }) });
  });
  await page.evaluate(() => {
    const get = (window as any).nodeEditExport;
    get('useSettingsStore').setState({ providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', enabledModels: ['vision-test'] }],
      activeModelRef: { providerId: 'fixture', model: 'vision-test' }, secondaryModelRef: undefined, secondaryUseSameModel: true });
    get('useModelCatalogStore').getState().setCatalog('fixture', [{ id: 'vision-test', caps: { vision: true, textOutput: true, tools: false } }]);
    get('useImageSelectionStore').getState().set({ projectId: 'node-edit-regression', nodeId: 'media', versionCreatedAt: 1,
      regions: [{ x: .08, y: .12, width: .19, height: .3 }, { x: .62, y: .12, width: .19, height: .3 }] });
  });
  const input = page.getByRole('textbox', { name: 'Image follow-up question or modification' });
  await input.fill('What do these selected parts have in common?');
  await input.press('Enter');
  try {
    await expect(input).toHaveValue('');
    await expect.poll(() => requested).toBe(true);
    await expect(input).toHaveValue('');
  } finally { release(); }
});

test('topic image previews put white behind pixels only, not the unused space', async ({ page }, info) => {
  test.setTimeout(90_000);
  await start(page);
  await page.evaluate(async () => {
    const get = (window as any).nodeEditExport;
    const settings = { ...get('useSettingsStore').getState(), providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', enabledModels: ['test'] }], activeModelRef: { providerId: 'fixture', model: 'test' } };
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('settings.json', { create: true });
    const writer = await file.createWritable(); await writer.write(JSON.stringify(settings)); await writer.close();
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Image', exact: true }).click();
  for (const [format, width, height] of [['jpeg', 1000, 600], ['png', 300, 900]] as const) {
    const image = await page.evaluate(({ format, width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const c = canvas.getContext('2d')!;
      if (format === 'jpeg') { c.fillStyle = '#20474d'; c.fillRect(0, 0, width, height); }
      c.fillStyle = '#de8564'; c.fillRect(width * .2, height * .2, width * .6, height * .6);
      return canvas.toDataURL(`image/${format}`).split(',')[1]!;
    }, { format, width, height });
    await page.getByLabel('Upload image file').setInputFiles({ name: `example.${format}`, mimeType: `image/${format}`, buffer: Buffer.from(image, 'base64') });
    const preview = page.locator('.image-project-preview');
    await expect(preview).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start project', exact: true })).toBeEnabled();
    const size = await preview.boundingBox();
    expect(size!.width / size!.height).toBeCloseTo(width / height, 2);
    await expect(preview).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    for (const theme of ['mocha', 'latte']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.screenshot({ path: info.outputPath(`topic-image-${format}-${theme}.png`), animations: 'disabled' });
    }
  }
});
