import { expect, test, type Page } from '@playwright/test';
import { LANGUAGES } from '../src/lib/languages';

test.use({ browserName: process.env.SCATTER_TEST_BROWSER === 'firefox' ? 'firefox' : 'chromium' });

async function scene(page: Page, zoom = .75) {
  await page.setViewportSize({ width: 1720, height: 1100 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(zoom => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`creation-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const settings = win.testExport('useSettingsStore');
    settings.setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null,
      cameraAutoPan: Object.fromEntries(Object.keys(settings.getState().cameraAutoPan).map(key => [key, false])) });
    const graph = win.testExport('useGraphStore');
    const make = (id: string, x: number, y: number) => ({ id, type: 'manual-empty', position: { x, y }, frozen: true,
      versions: [{ header: id, body: '', emptyText: true, initialTextFrame: true, contentType: 'explain',
        width: 624, createdAt: 1, generatedBy: 'manual' }], currentVersionIndex: 0 });
    graph.getState().setProject({ ...graph.getState().project, id: 'creation-test',
      nodes: { parent: make('parent', 0, 0), obstacle: make('obstacle', 720, 500) },
      arrows: {}, groups: {}, rootNodeId: 'parent', selection: ['parent'], viewport: { x: 800, y: 300, zoom } });
    graph.getState().requestPanTo(null);
    graph.temporal.getState().clear();
  }, zoom);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-node-id="parent"]')).toHaveCSS('height', '390px');
  await page.waitForTimeout(300);
}

async function recordCreation(page: Page, action: 'button' | 'rapid' | 'overview' = 'button') {
  await page.evaluate(() => {
    const win = window as any;
    win.creationSamples = [];
    win.recordCreation = true;
    const frame = () => {
      if (!win.recordCreation) return;
      for (const el of document.querySelectorAll<HTMLElement>('[data-node-id]')) {
        const id = el.dataset.nodeId!;
        if (id === 'parent' || id === 'obstacle') continue;
        const style = getComputedStyle(el), transform = new DOMMatrixReadOnly(style.transform);
        win.creationSamples.push({ id, x: transform.m41, y: transform.m42, width: el.offsetWidth, height: el.offsetHeight,
          opacity: Number(style.opacity), visibility: style.visibility, phase: el.dataset.nodeBirth });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  if (action === 'button') {
    const panel = page.locator('.node-side-panel-stack');
    await panel.getByRole('button', { name: 'Add node', exact: true }).click();
    await expect(page.locator('#add-node-parent')).toHaveAttribute('data-animating', 'false');
    await panel.getByRole('button', { name: 'Encyclopedic node', exact: true }).click();
  } else {
    await page.evaluate(count => {
      const spawn = (window as any).testExport('spawnEmptyTextNode');
      for (let i = 0; i < count; i++) spawn('parent', 'encyclopedic');
    }, action === 'rapid' ? 2 : 1);
  }
  await expect(page.locator('[data-node-id]')).toHaveCount(action === 'rapid' ? 4 : 3);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).testExport('useNodeBirthStore').getState().byNode).length)).toBe(0);
  await page.waitForTimeout(400);
  return page.evaluate(() => { (window as any).recordCreation = false; return (window as any).creationSamples as {
    id: string; x: number; y: number; width: number; height: number; opacity: number; visibility: string; phase?: string;
  }[]; });
}

test('measures, places, then fades in a real child without the pinned-obstacle jump', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await scene(page);
  const samples = await recordCreation(page);
  const visible = samples.filter(s => s.visibility !== 'hidden' && s.opacity > .01);
  expect(visible.length).toBeGreaterThan(2);
  expect(visible.some(s => s.opacity > .05 && s.opacity < .95)).toBe(true);
  expect(visible.every(s => s.width === 624 && s.height === 780)).toBe(true);
  // Right is blocked: use the centred left slot, not a right-hand diagonal.
  expect(visible[0]!.x).toBeCloseTo(-686.5, 2);
  expect(visible[0]!.y).toBeCloseTo(-195, 2);
  for (let i = 1; i < visible.length; i++) {
    expect(Math.hypot(visible[i]!.x - visible[i - 1]!.x, visible[i]!.y - visible[i - 1]!.y)).toBeLessThan(20);
  }
  // The oversized child must never occupy the old 400px-height provisional slot.
  for (const s of visible) {
    const overlap = s.x < 1344 && s.x + s.width > 720 && s.y < 890 && s.y + s.height > 500;
    expect(overlap).toBe(false);
  }
  expect(await page.evaluate(() => (window as any).testExport('useLivePositionsStore').getState().positions.obstacle))
    .toEqual({ x: 720, y: 500 });
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('settled-child.png') });
});

test('rapid creation reserves distinct spaces; undo and redo do not replay the entrance', async ({ page }) => {
  await scene(page);
  await recordCreation(page, 'rapid');
  const rects = await page.evaluate(() => {
    const win = window as any, graph = win.testExport('useGraphStore').getState();
    const live = win.testExport('useLivePositionsStore').getState().positions;
    return Object.values(graph.project.nodes).map((n: any) => ({ id: n.id, ...live[n.id], w: 624, h: n.renderedHeight }));
  });
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i]!, b = rects[j]!;
    expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false);
  }
  await page.evaluate(() => (window as any).testExport('useGraphStore').temporal.getState().undo());
  await expect(page.locator('[data-node-id]')).toHaveCount(3);
  await page.evaluate(() => (window as any).testExport('useGraphStore').temporal.getState().redo());
  await expect(page.locator('[data-node-id]')).toHaveCount(4);
  expect(await page.locator('[data-node-birth]').count()).toBe(0);
});

test('overview creation still measures the full-size card; reduced motion skips the fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await scene(page, .2);
  const samples = await recordCreation(page, 'overview');
  const visible = samples.filter(s => s.visibility !== 'hidden' && s.opacity > 0);
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.every(s => s.height === 780 && s.opacity === 1)).toBe(true);
});

test('all empty node types become usable and chat retains its typing focus', async ({ page }) => {
  test.setTimeout(90_000);
  await scene(page);
  for (const name of ['Chat', 'Image or video', 'Explanation', 'Interactive node', 'Markdown text node']) {
    await page.evaluate(() => {
      const win = window as any, graph = win.testExport('useGraphStore');
      graph.getState().setProject({ ...graph.getState().project,
        nodes: { parent: graph.getState().project.nodes.parent }, arrows: {}, selection: ['parent'],
        viewport: { x: 400, y: 300, zoom: .75 } }, { resetRuntime: true });
    });
    const panel = page.locator('.node-side-panel-stack');
    await expect(page.locator('[data-node-id]')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Add node', exact: true })).toHaveAttribute('aria-controls', 'add-node-parent');
    await panel.getByRole('button', { name: 'Add node', exact: true }).click();
    await expect(page.locator('#add-node-parent')).toHaveAttribute('data-animating', 'false');
    await panel.getByRole('button', { name, exact: true }).click();
    const child = page.locator('[data-node-id]:not([data-node-id="parent"])');
    await expect(child).toBeVisible();
    await expect(child).not.toHaveAttribute('data-node-birth');
    expect((await child.boundingBox())!.height).toBeGreaterThan(100);
    if (name === 'Chat') {
      const composer = child.getByRole('textbox', { name: 'Chat message' });
      await expect(composer).toBeFocused();
      await page.keyboard.type('A draft, without sending a request.');
      await expect(composer).toHaveValue('A draft, without sending a request.');
    }
  }
});

test('measured creation preserves every supported language, including RTL and mixed-script text', async ({ page }) => {
  await scene(page);
  await page.evaluate(languages => {
    const graph = (window as any).testExport('useGraphStore').getState();
    for (const language of languages) {
      const id = `language-${language.id}`;
      graph.addNodeWithArrow({ id, type: 'term', position: { x: 720, y: 0 }, frozen: false,
        currentVersionIndex: 0, versions: [{ header: language.native,
          body: `${language.sample} **${language.sample}**\n\n\`const count = 2;\` · 日本語 · العربية · हिन्दी · café`,
          contentType: 'explain', language: language.id, width: 624, createdAt: 1, generatedBy: 'manual' }],
      }, { id: `arrow-${id}`, fromNodeId: 'parent', toNodeId: id, kind: 'auto' });
    }
  }, LANGUAGES);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).testExport('useNodeBirthStore').getState().byNode).length),
    { timeout: 15_000 }).toBe(0);
  await page.evaluate(() => document.fonts.ready);
  for (const language of LANGUAGES) {
    const card = page.locator(`[data-node-id="language-${language.id}"]`);
    await expect(card).toHaveAttribute('lang', language.locale);
    await expect(card).toHaveAttribute('data-language-direction', language.id === 'ar' ? 'rtl' : 'ltr');
    await expect(card).toContainText(language.sample);
    const size = await card.evaluate(el => ({ width: (el as HTMLElement).offsetWidth, height: (el as HTMLElement).offsetHeight }));
    expect(size.width).toBeGreaterThanOrEqual(624);
    expect(size.height).toBeGreaterThan(100);
  }
});
