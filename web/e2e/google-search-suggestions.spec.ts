import { expect, test, type Page } from '@playwright/test';

// Local fixtures only: provider requests are blocked, and every test gets an
// isolated browser profile. No user keys or paid generations are involved.
const snippet = `<style>
  .container { box-sizing:border-box; height:48px; padding:8px; display:flex; align-items:center; gap:8px; border-radius:8px; }
  .carousel { white-space:nowrap; overflow:auto; scrollbar-gutter:stable; }
  .chip { display:inline-block; padding:5px 12px; border:1px solid #999; border-radius:20px; font:14px Arial; margin-right:8px; }
  @media (prefers-color-scheme: dark) { .container { background:#1f1f1f; color:#ddd; box-shadow:0 0 0 1px #ffffff26; } .chip { color:#ddd; } }
  @media (prefers-color-scheme: light) { .container { background:#fafafa; color:#222; box-shadow:0 0 0 1px #0000000f; } .chip { color:#222; } }
  </style><div class="container"><span>G</span><div class="carousel"><a class="chip" href="https://www.google.com/search?q=planetary+orbits">Planetary orbits and orbital mechanics</a><a class="chip" href="https://www.google.com/search?q=solar+system">Solar system observations, planetary composition, and orbital periods</a></div></div>`;

async function openFixture(page: Page, kind: string, history = false) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === 'localhost'
    ? route.continue() : route.abort());
  await page.goto('/');
  await page.getByRole('heading', { name: 'Configure AI models' }).waitFor();
  // Let initial empty-settings hydration finish before installing the fixture.
  await page.waitForTimeout(400);
  await page.evaluate(async ({ kind, snippet, history }) => {
    const version = {
      header: `Search suggestions — ${kind}`, createdAt: 1, generatedBy: 'manual',
      contentType: kind === 'markdown' ? 'answer' : kind, markdownNote: kind === 'markdown',
      body: 'Planets move around the Sun. Observations describe their motion.\n\n'
        + (kind === 'encyclopedic' ? '- Orbits\n  - Period: Time required for one orbit.\n  - Shape: Most planetary orbits are nearly circular.\n- Composition\n  - Rocky: Terrestrial planets.\n  - Gaseous: Giant planets.' : 'Different planets have different orbital periods.'),
      width: 680, ...(kind === 'chat' || kind === 'answer' || kind === 'markdown' ? { bodyMaxHeight: 360 } : {}),
      googleSearchSuggestions: [snippet],
      ...(['chat', 'answer', 'markdown'].includes(kind) ? { chat: { turnId: 'turn', question: 'How do planets move?', title: 'Planetary motion',
        informationChunking: false, state: 'complete', contextPath: [] } } : {}),
    };
    const firstSearch = snippet.replace('Planetary orbits and orbital mechanics', 'First version search');
    const secondSearch = snippet.replace('Planetary orbits and orbital mechanics', 'Second version search');
    const versions = history ? [
      { ...version, createdAt: 1, googleSearchSuggestions: [firstSearch], webSearched: true,
        sources: [{ n: 1, url: 'https://first.example/source' }] },
      { ...version, createdAt: 2, googleSearchSuggestions: [firstSearch, secondSearch], webSearched: true,
        sources: [{ n: 1, url: 'https://second.example/source' }] },
      { ...version, createdAt: 3, googleSearchSuggestions: [firstSearch, secondSearch], webSearched: false },
    ] : [version];
    const node = { id: 'fixture', type: 'root', position: { x: 0, y: 0 }, frozen: true,
      versions, currentVersionIndex: history ? 1 : 0, bulletsCollapsed: false,
      ...(kind === 'chat' ? { chat: { title: 'Planetary motion', informationChunking: false,
        turns: [{ id: 'turn', versionCreatedAts: [1], selectedVersionCreatedAt: 1 }], parentSnapshots: {}, compactions: [] } } : {}),
    };
    const project = { id: 'fixture-project', name: 'Search suggestions', rootNodeId: node.id,
      createdAt: 1, updatedAt: 1, nodes: { [node.id]: node }, arrows: {}, groups: {},
      viewport: { x: 370, y: 40, zoom: 1 }, selection: [] };
    const settings = { providers: [{ id: 'fixture', preset: 'gemini', apiKey: 'fixture-not-a-real-key', enabledModels: ['gemini-test'] }],
      activeModelRef: { providerId: 'fixture', model: 'gemini-test' }, autoTermPreviews: false, autoFreeImages: false };
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable(); await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const dir = await root.getDirectoryHandle('projects', { create: true });
    await write(dir, `${project.id}.json`, project);
    await write(dir, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
    sessionStorage.removeItem('scatter.onboarding');
    localStorage.setItem('sc-theme', 'dark');
  }, { kind, snippet, history });
  await page.reload();
  await page.locator('[data-node-id="fixture"] .node-header').click();
  await page.locator('.google-search-suggestions iframe').waitFor();
}

test('search rows belong only to the relevant version, including older saved projects', async ({ page }) => {
  await openFixture(page, 'encyclopedic', true);
  const frames = page.locator('.google-search-panel iframe');
  const expectSearch = async (label: string) => {
    await expect(frames).toHaveCount(1);
    await expect(page.frameLocator('.google-search-panel iframe').getByText(label, { exact: true })).toBeVisible();
  };
  await expectSearch('Second version search');
  await page.getByRole('button', { name: 'Previous version', exact: true }).click();
  await expectSearch('First version search');
  await page.getByRole('button', { name: 'Next version', exact: true }).click();
  await expectSearch('Second version search');
  await page.getByRole('button', { name: 'Next version', exact: true }).click();
  await expect(frames).toHaveCount(0);
  await page.getByRole('button', { name: 'Previous version', exact: true }).click();
  await expectSearch('Second version search');
});

for (const kind of ['encyclopedic', 'explain', 'chat', 'answer', 'markdown']) {
  test(`${kind}: search suggestions fit both themes and scrolling never shifts the layout`, async ({ page }, testInfo) => {
    await openFixture(page, kind);
    const frame = page.frameLocator('.google-search-suggestions iframe');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme === 'dark' ? 'mocha' : 'latte';
        document.documentElement.style.colorScheme = theme;
        window.dispatchEvent(new CustomEvent('scatter:themechange'));
      }, theme);
      await expect(frame.locator('.container')).toHaveCSS('background-color', theme === 'dark' ? 'rgb(31, 31, 31)' : 'rgb(250, 250, 250)');
      await expect(page.locator('.google-search-suggestions iframe')).toHaveCSS('height', '50px');
      // Show Google's entire outline, not only the corners that fit inside
      // an edge-to-edge iframe. There must be no second stroke over it.
      await expect(page.locator('.google-search-suggestions-frame')).toHaveCSS('border-width', '0px');
      await expect(page.locator('.google-search-suggestions-frame')).toHaveCSS('box-shadow', 'none');
      const outlineSpace = await frame.locator('.container').evaluate(el => {
        const rect = el.getBoundingClientRect();
        return [rect.top, rect.left, innerWidth - rect.right, innerHeight - rect.bottom];
      });
      expect(outlineSpace).toEqual([1, 1, 1, 1]);
      await expect(frame.locator('.container')).not.toHaveCSS('box-shadow', 'none');
      await expect(page.getByRole('heading', { name: 'Forced by Gemini API:' })).toBeVisible();
      await expect(page.locator('.node .google-search-suggestions')).toHaveCount(0);
      await expect(frame.locator('.carousel')).toHaveCSS('scrollbar-width', 'none');
      await expect(frame.locator('.carousel')).toHaveCSS('scrollbar-gutter', 'auto');
      const layout = () => page.locator('.google-search-suggestions').evaluate(row => ({
        height: (row as HTMLElement).offsetHeight, width: (row as HTMLElement).offsetWidth,
        nodeHeight: (document.querySelector('.node') as HTMLElement).offsetHeight,
      }));
      await page.mouse.move(5, 5);
      const before = await layout();
      expect(before.height).toBe(50); // intact 48px content plus its supplied outline
      const bar = page.locator('.google-search-suggestions-scrollbar');
      await expect(bar).toHaveCSS('opacity', '0');
      await expect(bar).toHaveCSS('position', 'absolute');
      await expect(bar).toHaveCSS('height', '2px');
      await frame.locator('.container').hover();
      await expect(bar).toHaveCSS('opacity', '1');
      expect(await layout()).toEqual(before);
      await page.locator('.node-side-panel-stack').screenshot({ path: testInfo.outputPath(`panel-${theme}.png`) });
      await page.mouse.move(5, 5);
      await expect(bar).toHaveCSS('opacity', '0');
      expect(await layout()).toEqual(before);
      await frame.locator('.carousel').evaluate(el => { el.scrollLeft = el.scrollWidth; });
      await expect(bar).toHaveAttribute('data-visible', 'true');
      await expect(bar).toHaveCSS('opacity', '1');
      expect(await layout()).toEqual(before);
      await expect(bar).toHaveAttribute('data-visible', 'false');
      await expect(bar).toHaveCSS('opacity', '0');
      expect(await layout()).toEqual(before);
      // Future provider layouts need not be exactly 48px tall.
      await frame.locator('.container').evaluate(el => { (el as HTMLElement).style.height = '64px'; });
      await expect(page.locator('.google-search-suggestions iframe')).toHaveCSS('height', '66px');
    }
    if (kind === 'encyclopedic') {
      const geometry = () => page.locator('.node-side-panel-stack').evaluate(stack => {
        const actions = stack.children[0] as HTMLElement;
        const search = stack.children[1] as HTMLElement;
        return { gap: search.offsetTop - actions.offsetTop - actions.offsetHeight,
          actionsWidth: actions.offsetWidth, searchWidth: search.offsetWidth, searchTop: search.offsetTop };
      });
      const before = await geometry();
      expect(before.gap).toBe(12);
      expect(before.actionsWidth).toBe(248);
      expect(before.searchWidth).toBe(before.actionsWidth);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const expanded = await geometry();
      expect(expanded.gap).toBe(12);
      expect(expanded.searchTop).toBeGreaterThan(before.searchTop);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      expect(await geometry()).toEqual(before);
      await page.getByRole('button', { name: 'Collapse node', exact: true }).click();
      await expect(page.locator('.google-search-panel iframe')).toBeVisible();
      await page.getByRole('button', { name: 'Expand node', exact: true }).click();
      await expect(page.locator('.google-search-panel iframe')).toBeVisible();
    }
  });
}
