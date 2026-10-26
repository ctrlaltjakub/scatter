import { expect, test, type Page } from '@playwright/test';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function exportsFor(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`tooltip-qa-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const module of Object.values(require.c) as any[]) if (module.exports?.[name]) return module.exports[name];
        throw new Error(`Missing test export ${name}`);
      };
    }]);
  });
}

async function seed(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => ['localhost', '127.0.0.3', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await exportsFor(page);
  await page.evaluate(async () => {
    const find = (window as any).testExport;
    const version: any = { header: 'Memory systems', body: 'A [[cache]] stores frequently used information.', createdAt: 1,
      generatedBy: 'manual', contentType: 'answer', width: 600, bodyMaxHeight: 240,
      chat: { turnId: 'answer', question: 'Explain caches.', title: 'Memory systems', state: 'complete', contextPath: [] } };
    version.termPreviews = { fingerprint: find('termPreviewFingerprint')(version),
      entries: { cache: 'A cache stores frequently used data so later requests can retrieve it faster.' } };
    const node = { id: 'tooltip-node', type: 'follow-up', frozen: true, position: { x: 0, y: 0 }, versions: [version], currentVersionIndex: 0 };
    const project = { ...find('useGraphStore').getState().project, id: 'tooltip-project', name: 'Tooltip QA',
      rootNodeId: node.id, nodes: { [node.id]: node }, arrows: {}, groups: {}, selection: [node.id], color: '#8fb44f',
      viewport: { x: 540, y: 170, zoom: 1 } };
    const settings = { ...find('useSettingsStore').getState(), autoFreeImages: false, autoTermPreviews: true,
      providers: [{ id: 'fixture', preset: 'custom', apiKey: 'fixture-not-a-key', baseUrl: 'https://fixture.invalid/v1', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' }, webSearch: false };
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, data: unknown) => {
      const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await stream.write(JSON.stringify(data)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const dir = await root.getDirectoryHandle('projects', { create: true });
    await write(dir, `${project.id}.json`, project);
    await write(dir, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
  });
  await page.goto('/');
  await page.locator('[data-node-id="tooltip-node"] .node-header').click();
  await exportsFor(page);
}

async function verifyButtonDescriptions(page: Page) {
  const missing = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], [role="switch"], [role="tab"]'))
    .filter(el => el.getClientRects().length && !el.closest('[inert], [aria-hidden="true"], [data-reference-term], .ref-chip')
      && el.getAttribute('data-tip') !== '')
    .filter(el => !(window as any).testExport('controlTooltipText')(el, el.getAttribute('title')))
    .map(el => el.outerHTML.slice(0, 250)));
  expect(missing).toEqual([]);
}

test('tooltips share the term-preview surface, fit viewport edges, and cover buttons in both themes', async ({ page }, info) => {
  test.setTimeout(90_000);
  await seed(page);
  const tip = page.locator('#scatter-control-tooltip');
  await expect(page.locator('.tooltip-bar')).toHaveCount(0);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(theme => (window as any).testExport('applyThemePreference')(theme), theme);
    await verifyButtonDescriptions(page);
    const settings = page.getByTestId('settings-gear');
    const before = await settings.boundingBox();
    await settings.hover();
    await expect(tip).toHaveText('Settings (⌘,)');
    await expect(tip).toBeVisible();
    await expect(tip.locator('svg')).toHaveCount(0);
    const rect = await tip.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(8);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(992);
    expect(await settings.boundingBox()).toEqual(before);
    await page.screenshot({ path: info.outputPath(`tooltip-toolbar-${theme}.png`) });
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await page.locator('[data-node-id="tooltip-node"] .node-header').click();
    await page.locator('[data-reference-term="cache"]').first().hover();
    await page.waitForTimeout(800);
    await expect(tip).toHaveCount(0);
    await expect(page.locator('#scatter-relation-hover-preview')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`tooltip-term-${theme}.png`) });
    await page.getByRole('button', { name: 'Add node', exact: true }).click();
    const addChat = page.getByRole('button', { name: 'Chat', exact: true });
    await addChat.hover();
    await expect(tip).toHaveText('Start a connected chat using this node as context');
    const actionBox = await addChat.boundingBox(), actionTip = await tip.boundingBox();
    expect(actionTip!.y + actionTip!.height).toBeLessThan(actionBox!.y);
    await expect(tip).toHaveCSS('pointer-events', 'none');
    await page.screenshot({ path: info.outputPath(`tooltip-side-panel-${theme}.png`) });
    await page.getByRole('button', { name: 'Add node', exact: true }).click();
    await settings.click();
    const close = page.getByRole('button', { name: 'Close settings' });
    await close.hover();
    await expect(tip).toHaveText('Close settings');
    await expect(tip).toBeVisible();
    await verifyButtonDescriptions(page);
    await page.screenshot({ path: info.outputPath(`tooltip-settings-${theme}.png`) });
    await close.click();
    await expect(tip).toHaveCount(0);
  }
  // The same global service stays mounted when the sidebar is collapsed.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await page.mouse.move(1400, 80);
  await page.getByTestId('settings-gear').hover();
  await expect(tip).toHaveText('Settings (⌘,)');
  await expect(tip).toBeVisible();
  const gearBox = await page.getByTestId('settings-gear').boundingBox(), belowTip = await tip.boundingBox();
  expect(belowTip!.y).toBeGreaterThanOrEqual(gearBox!.y + gearBox!.height);
  await page.screenshot({ path: info.outputPath('tooltip-collapsed-toolbar.png') });
});

test('text editor buttons and keyboard focus use the same tooltips without stealing the caret', async ({ page }, info) => {
  test.setTimeout(60_000);
  await seed(page);
  await page.evaluate(() => (window as any).testExport('useLiveViewportStore').getState().setZoom(0.5));
  await page.getByRole('button', { name: 'Edit or export text' }).click();
  const editor = page.locator('.text-editor-stage');
  await expect(editor).toBeVisible();
  await verifyButtonDescriptions(page);
  const bold = editor.getByRole('button', { name: 'Bold', exact: true });
  await bold.hover();
  await expect(page.locator('#scatter-control-tooltip')).toBeVisible();
  await expect.poll(() => page.locator('#scatter-control-tooltip').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(1, 2);
  await page.screenshot({ path: info.outputPath('tooltip-editor.png') });
  await bold.click();
  await expect(page.locator('#scatter-control-tooltip')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[contenteditable="true"]'))).toBe(true);
  await bold.focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#scatter-control-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scatter-control-tooltip')).toHaveCount(0);
});

test('canvas tooltips follow their controls through zoom and pan while app-toolbar tooltips stay screen-sized', async ({ page }, info) => {
  test.setTimeout(90_000);
  await seed(page);
  const tip = page.locator('#scatter-control-tooltip');
  const action = page.getByRole('button', { name: 'Add node', exact: true });
  const settings = page.getByTestId('settings-gear');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(theme => {
      const get = (window as any).testExport;
      get('applyThemePreference')(theme);
      get('useLiveViewportStore').getState().setViewport({ x: 540, y: 170, zoom: 1 });
    }, theme);
    await settings.hover();
    await expect(tip).toHaveText('Settings (⌘,)');
    const fixedAtOne = (await tip.boundingBox())!;
    // Keyboard focus keeps the tooltip open as the camera moves the control
    // away from the mouse. No synthetic hover or forced clicks are needed.
    await page.mouse.move(1350, 900);
    await page.keyboard.press('Tab');
    await action.focus();
    await expect(tip).toHaveText('Create a connected node');
    const atOne = (await tip.boundingBox())!;
    const controlAtOne = (await action.boundingBox())!;
    expect(atOne.y + atOne.height).toBeLessThan(controlAtOne.y);
    await page.screenshot({ path: info.outputPath(`tooltip-canvas-100-${theme}.png`), animations: 'disabled' });
    await page.evaluate(() => (window as any).testExport('useLiveViewportStore').getState().setZoom(0.5));
    await expect.poll(async () => (await tip.boundingBox())!.width / atOne.width).toBeCloseTo(0.5, 2);
    const atHalf = (await tip.boundingBox())!, controlAtHalf = (await action.boundingBox())!;
    expect(atHalf.height / atOne.height).toBeCloseTo(0.5, 2);
    expect(controlAtHalf.width / controlAtOne.width).toBeCloseTo(0.5, 2);
    expect(atHalf.y + atHalf.height).toBeCloseTo(controlAtHalf.y - 3, 0);
    await page.screenshot({ path: info.outputPath(`tooltip-canvas-50-${theme}.png`), animations: 'disabled' });
    await page.evaluate(() => {
      const viewport = (window as any).testExport('useLiveViewportStore').getState();
      viewport.setPan(viewport.x + 60, viewport.y + 40);
    });
    await expect.poll(async () => (await tip.boundingBox())!.x).toBeCloseTo(atHalf.x + 60, 0);
    await expect.poll(async () => (await tip.boundingBox())!.y).toBeCloseTo(atHalf.y + 40, 0);
    await settings.hover();
    await expect(tip).toHaveText('Settings (⌘,)');
    const fixedAtHalf = (await tip.boundingBox())!;
    expect(fixedAtHalf.width).toBeCloseTo(fixedAtOne.width, 0);
    expect(fixedAtHalf.height).toBeCloseTo(fixedAtOne.height, 0);
    await page.getByRole('button', { name: 'Tooltip QA', exact: true }).hover();
    await expect(tip).toBeVisible();
    await expect.poll(() => tip.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeCloseTo(1, 2);
  }
});

test('expanded bullet whitespace stays quiet while action hints and term previews still work', async ({ page }, info) => {
  test.setTimeout(60_000);
  await seed(page);
  await page.evaluate(() => {
    const get = (window as any).testExport;
    const graph = get('useGraphStore');
    const node = graph.getState().project.nodes['tooltip-node'];
    const version = { ...node.versions[0], header: 'Game theory', contentType: 'encyclopedic', chat: undefined,
      width: 700, bodyMaxHeight: 620,
      body: 'Game theory studies [[strategy]] and decision-making.\n\n- Information and timing taxonomy\n  - Simultaneous games: Players choose without observing other choices.\n  - Sequential games: Players move in order and can observe earlier decisions.\n  - Perfect information: The complete history is known.\n  - Repeated games: The same players interact over multiple rounds.\n- Applications\n  - Auctions: Rules determine bids and payments.\n  - Negotiation: Participants seek mutually acceptable outcomes.' };
    version.termPreviews = { fingerprint: get('termPreviewFingerprint')(version), entries: {
      strategy: 'A strategy specifies the choices a participant makes in each situation.' } };
    graph.getState().updateNode(node.id, { versions: [version] });
    get('useLiveViewportStore').getState().setViewport({ x: 500, y: 90, zoom: 1 });
  });
  const node = page.locator('[data-node-id="tooltip-node"]');
  const bullet = node.locator('.sc-ab-root > .sc-ab-list > .sc-ab-item').first();
  const tip = page.locator('#scatter-control-tooltip');
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate(theme => (window as any).testExport('applyThemePreference')(theme), theme);
    await node.locator('.node-header').click();
    const box = (await bullet.boundingBox())!;
    await bullet.click({ position: { x: box.width - 12, y: 10 } });
    await expect(bullet).toHaveClass(/is-active/);
    await expect(bullet).toHaveAttribute('aria-expanded', 'true');
    await expect(bullet).toHaveAttribute('data-tip', '');
    await page.mouse.move(1350, 950);
    await bullet.hover({ position: { x: box.width - 12, y: 10 } });
    await page.waitForTimeout(900);
    await expect(tip).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`expanded-bullet-no-tooltip-${theme}.png`) });
    await page.getByRole('button', { name: 'Add node', exact: true }).hover();
    await expect(tip).toHaveText('Create a connected node');
    await node.locator('[data-reference-term="strategy"]').hover();
    await page.waitForTimeout(900);
    await expect(tip).toHaveCount(0);
    await expect(page.locator('#scatter-relation-hover-preview')).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => {
    const get = (window as any).testExport, graph = get('useGraphStore');
    const node = graph.getState().project.nodes['tooltip-node'];
    const version = { ...node.versions[0], factCheck: { complete: {
      schemaVersion: 1, bodyFingerprint: 'fixture', versionCreatedAt: 1,
      providerId: 'fixture', model: 'fixture', startedAt: 1, complete: true, failedUnitIds: [],
      units: [{ id: 'opening:0', order: 0, stage: 'opening', kind: 'sentence',
        text: 'Game theory studies strategy and decision-making.', sentenceIndex: 0, state: 'complete',
        finding: { verdict: 'supported', explanation: 'Test evidence.', evidence: [] } }],
    } } };
    graph.getState().updateNode(node.id, { versions: [version] });
    get('useCitationPanelStore').getState().openFact(node.id, 1, 'opening:0');
  });
  const claim = node.locator('.sc-ab-root > .sc-ab-freetext [data-fact-unit="opening:0"]');
  await expect(claim).toHaveAttribute('data-tip', 'Review evidence');
  // Inline span hit boxes differ between engines. Point at the actual opening
  // text, not a term chip or the empty margin around its line box.
  const point = await claim.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element.firstChild!);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await expect(tip).toHaveText('Review evidence');
  await page.screenshot({ path: info.outputPath('fact-check-short-tooltip.png') });
});
