import { expect, test, type Page } from '@playwright/test';

// Fresh browser storage, sandbox project, and no external requests/inference.
async function sandbox(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', 'localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`media-regression-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    win.testExport('useSettingsStore').setState({ autoTermPreviews: false, autoFreeImages: false,
      providers: [], activeModelRef: null, webSearch: false, sentencePerLine: false });
  });
}

async function mediaFixture(page: Page) {
  await sandbox(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const canvas = document.createElement('canvas'); canvas.width = 500; canvas.height = 320;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#dc684e'; context.beginPath(); context.arc(155, 155, 70, 0, Math.PI * 2); context.fill();
    context.fillStyle = '#3883cb'; context.fillRect(285, 105, 115, 115);
    const media = { kind: 'image', source: 'link', mimeType: 'image/png', url: canvas.toDataURL(), naturalWidth: 500, naturalHeight: 320 };
    const graph = find('useGraphStore');
    const project = graph.getState().project;
    const make = (id: string, y: number, type: string, body: string) => ({ id, type, frozen: true, position: { x: 0, y },
      currentVersionIndex: 0, versions: [{ header: id, body, createdAt: 1, generatedBy: 'manual', contentType: type,
        width: 500, bodyMaxHeight: type === 'media' ? 320 : 100, ...(type === 'media' ? { media } : {}) }] });
    const image = make('Transparent image', 0, 'media', '');
    const top = make('Above the image', -280, 'explain', 'An image-region answer above its source.');
    const bottom = make('Below the image', 620, 'explain', 'An image-region answer below its source.');
    const arrows = Object.fromEntries([['top', top, .1], ['bottom', bottom, .8]].map(([id, child, y]: any) => [id, {
      id, kind: 'auto', fromNodeId: image.id, toNodeId: child.id,
      sourceImage: { sourceMedia: media, regions: [{ x: .45, y, width: .1, height: .1 }] },
    }]));
    graph.getState().setProject({ ...project, nodes: { [image.id]: image, [top.id]: top, [bottom.id]: bottom },
      arrows, selection: [image.id], rootNodeId: image.id, viewport: { x: 680, y: 300, zoom: .75 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  await expect(page.locator('.sc-media-img')).toHaveJSProperty('complete', true);
}

async function openMainPage(page: Page, nodeId: string) {
  await page.evaluate(async () => {
    const find = (window as any).testExport;
    const project = find('useGraphStore').getState().project;
    const settings = { ...find('useSettingsStore').getState(),
      providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', enabledModels: ['fixture-model'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture-model' } };
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
  });
  await page.goto('/');
  await page.locator(`[data-node-id="${nodeId}"] .node-header`).click();
}

for (const provider of ['youtube', 'vimeo'] as const) {
  test(`${provider} video posters use custom cursors and open their player with pointer or keyboard input`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await mediaFixture(page);
    await page.evaluate(provider => {
      const graph = (window as any).testExport('useGraphStore');
      const project = graph.getState().project;
      const image = project.nodes['Transparent image'];
      const video = { ...image, versions: [{ ...image.versions[0], header: 'Video controls', media: {
        kind: 'embed', source: 'embed', provider, embedId: '123456789',
        thumbnailUrl: image.versions[0].media.url, naturalWidth: 500, naturalHeight: 320,
      } }] };
      graph.getState().setProject({ ...project, nodes: { [video.id]: video }, arrows: {},
        rootNodeId: video.id, viewport: { x: 450, y: 140, zoom: 1 } });
      graph.getState().requestPanTo(null);
    }, provider);
    const node = page.locator('[data-node-id="Transparent image"]');
    const poster = node.locator('.sc-media-embed-poster');
    const play = node.getByRole('button', { name: 'Play video' });
    const expectedCursor = await page.evaluate(() => {
      const sample = document.createElement('span');
      sample.style.cursor = 'var(--cur-click)'; document.body.appendChild(sample);
      const cursor = getComputedStyle(sample).cursor; sample.remove(); return cursor;
    });
    expect(expectedCursor).not.toBe('pointer');
    for (const theme of ['mocha', 'latte']) for (const zoom of [.55, 1, 1.5]) {
      await page.evaluate(({ theme, zoom }) => {
        document.documentElement.dataset.theme = theme;
        (window as any).testExport('useGraphStore').getState().setViewport({ x: 450, y: 140, zoom });
      }, { theme, zoom });
      await poster.hover({ position: { x: 20, y: 20 } });
      await expect(poster).toHaveCSS('cursor', expectedCursor);
      await play.hover();
      await expect(play).toHaveCSS('cursor', expectedCursor);
      await expect(play.locator('svg')).toHaveCSS('cursor', expectedCursor);
      await expect(play).toHaveCSS('outline-style', 'none');
      await expect(play).toHaveCSS('border-radius', '50%');
      await expect(play).toHaveCSS('border-top-width', '1px');
      if (zoom === 1) await node.screenshot({ path: info.outputPath(`${provider}-play-${theme}.png`) });
    }
    // Freeze an actual hover transition halfway through: screenshots taken
    // after it finishes miss the transient outline seams reported in Zen.
    await page.mouse.move(1400, 950);
    await expect.poll(() => play.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    await play.hover();
    await play.evaluate(el => {
      for (const animation of el.getAnimations()) {
        if (animation instanceof CSSTransition && animation.transitionProperty === 'transform') {
          animation.pause(); animation.currentTime = 75;
        }
      }
    });
    await expect(play).toHaveCSS('outline-style', 'none');
    await expect(play).toHaveCSS('border-top-width', '1px');
    await node.screenshot({ path: info.outputPath(`${provider}-play-mid-transition.png`) });
    await play.evaluate(el => el.getAnimations().forEach(animation => animation.finish()));
    if (provider === 'youtube') {
      await play.focus();
      await expect(play).toHaveCSS('border-top-width', '3px');
      await page.keyboard.press('Enter');
    } else {
      await poster.click({ position: { x: 20, y: 20 } });
    }
    await expect(node.getByTitle('Embedded video')).toHaveAttribute('src', provider === 'youtube'
      ? 'https://www.youtube.com/embed/123456789?autoplay=1'
      : 'https://player.vimeo.com/video/123456789?autoplay=1');
    await expect(play).toHaveCount(0);
  });
}

test('transparent images stay white and image-origin arrows cross the header/footer under the panels', async ({ page }, info) => {
  test.setTimeout(60_000);
  await mediaFixture(page);
  const node = page.locator('[data-node-id="Transparent image"]');
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect(node.locator('.sc-media-img')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(node.locator('[data-image-atlas-chrome]')).toBeVisible();
    await expect(node.locator('[data-image-atlas-chrome] [data-image-origin]')).toHaveCount(2);
    const layers = await page.evaluate(() => ({
      chrome: Number(getComputedStyle(document.querySelector('.image-atlas-chrome-layer')!).zIndex),
      panel: Number(getComputedStyle(document.querySelector('.node-side-panel-stack')!).zIndex),
      bottom: Number(getComputedStyle(document.querySelector('.node-followup-bar')!).zIndex),
    }));
    expect(layers.chrome).toBeLessThan(layers.panel);
    expect(layers.chrome).toBeLessThan(layers.bottom);
    await page.mouse.move(1500, 900);
    await page.waitForTimeout(250);
    await page.screenshot({ path: info.outputPath(`image-arrows-${theme}.png`) });
  }
  await openMainPage(page, 'Transparent image');
  await page.getByRole('button', { name: 'Edit image', exact: true }).click();
  await expect(page.locator('.ie-image-background')).toBeVisible();
  await expect(page.locator('.ie-image-background')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.screenshot({ path: info.outputPath('transparent-image-editor.png') });
});

test('hovering an image hides complete edge-touching selection outlines while chrome arrows remain visible', async ({ page }, info) => {
  test.setTimeout(60_000);
  await mediaFixture(page);
  await page.evaluate(() => {
    const graph = (window as any).testExport('useGraphStore');
    const project = graph.getState().project;
    graph.setState({ project: { ...project, arrows: { ...project.arrows, top: {
      ...project.arrows.top, sourceImage: { ...project.arrows.top.sourceImage, regions: [
        { x: 0, y: 0, width: .2, height: .2 }, { x: .8, y: 0, width: .2, height: .2 },
        { x: 0, y: .8, width: .2, height: .2 }, { x: .8, y: .8, width: .2, height: .2 },
      ] },
    } } } });
  });
  const node = page.locator('[data-node-id="Transparent image"]');
  const bitmap = node.locator('.image-atlas-layer');
  const frame = node.locator('.image-atlas-chrome-layer [data-image-atlas-frame="top"]');
  const links = node.locator('.image-atlas-chrome-layer [data-image-region-connectors="top"]');
  const shaft = node.locator('.image-atlas-chrome-layer [data-arrow-id="top"]');
  const opacity = (element: Element) => {
    let value = 1;
    for (let current: Element | null = element; current; current = current.parentElement) value *= Number(getComputedStyle(current).opacity);
    return value;
  };
  for (const theme of ['mocha', 'latte']) for (const zoom of [1, .65]) {
    await page.evaluate(({ theme, zoom }) => {
      document.documentElement.dataset.theme = theme;
      const graph = (window as any).testExport('useGraphStore');
      graph.getState().setViewport({ x: 680, y: 300, zoom });
      graph.setState({ highlight: { parentNodeId: 'Transparent image', childNodeId: 'Above the image', arrowId: 'top', nonce: 1, source: 'chip' } });
    }, { theme, zoom });
    await page.mouse.move(1500, 950);
    await expect.poll(() => frame.evaluate(opacity)).toBe(1);
    await expect.poll(() => links.evaluate(opacity)).toBe(1);
    if (zoom === 1) await node.screenshot({ path: info.outputPath(`edge-selection-visible-${theme}.png`) });
    await node.locator('.image-selection-surface').hover();
    await expect(bitmap).toHaveCSS('opacity', '0');
    if (zoom === 1) await node.screenshot({ path: info.outputPath(`edge-selection-hover-${theme}.png`) });
    await expect.poll(() => frame.evaluate(opacity)).toBe(0);
    await expect.poll(() => links.evaluate(opacity)).toBe(0);
    expect(await shaft.evaluate(opacity)).toBe(1);
    // Leaving restores both halves of the outline, including highlighted ink.
    await page.mouse.move(1500, 950);
    await expect.poll(() => frame.evaluate(opacity)).toBe(1);
    await expect.poll(() => links.evaluate(opacity)).toBe(1);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await node.locator('.image-selection-surface').hover();
  await expect.poll(() => frame.evaluate(opacity)).toBe(0);
  expect(await shaft.evaluate(opacity)).toBe(1);
});

test('a failed media attachment can be replaced through the visible recovery action', async ({ page }, info) => {
  await mediaFixture(page);
  await page.evaluate(() => {
    const graph = (window as any).testExport('useGraphStore');
    const node = graph.getState().project.nodes['Transparent image'];
    graph.getState().updateNode(node.id, { versions: [{ ...node.versions[0], media: {
      kind: 'image', source: 'link', url: 'https://missing.invalid/bad.png', unsupportedReason: 'Unsupported file format.',
    } }] });
  });
  await page.screenshot({ path: info.outputPath('media-error.png') });
  await page.getByRole('button', { name: 'Choose another file or link' }).click();
  await expect(page.getByRole('textbox', { name: 'Image, GIF, or video link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload a file…' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testExport('useGraphStore').getState().project.nodes['Transparent image'].versions.length)).toBe(2);
  await page.screenshot({ path: info.outputPath('media-recovered.png') });
});

test('manual image resizing can exceed the former media width limit', async ({ page }) => {
  await mediaFixture(page);
  await page.evaluate(() => {
    const graph = (window as any).testExport('useGraphStore');
    const project = graph.getState().project;
    const node = project.nodes['Transparent image'];
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, arrows: {},
      viewport: { x: 350, y: 130, zoom: .6 } });
    graph.getState().requestPanTo(null);
  });
  const corner = page.locator('[data-node-id="Transparent image"] .node-resize.br');
  const box = await corner.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 700, y + 448, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => {
    const node = (window as any).testExport('useGraphStore').getState().project.nodes['Transparent image'];
    return node.versions[node.currentVersionIndex].width;
  })).toBeGreaterThan(1500);
});

test('minimap uses different type silhouettes in both themes', async ({ page }, info) => {
  await sandbox(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const graph = find('useGraphStore');
    const project = graph.getState().project;
    const kinds = ['encyclopedic', 'explain', 'chat', 'media', 'interactive', 'answer'];
    const nodes = Object.fromEntries(kinds.map((kind, i) => [kind, kind === 'chat'
      ? { ...find('createChatNode')({ id: kind, createdAt: 1, position: { x: (i % 3) * 650, y: Math.floor(i / 3) * 480 }, bodyHeight: 270 }), frozen: true }
      : { id: kind, type: kind === 'encyclopedic' ? 'root' : kind,
      frozen: true, position: { x: (i % 3) * 650, y: Math.floor(i / 3) * 480 }, currentVersionIndex: 0, renderedHeight: 350,
      versions: [{ header: kind, createdAt: 1, generatedBy: 'manual', contentType: kind, width: 500, bodyMaxHeight: 270,
        ...(kind === 'answer' ? { markdownNote: true, chat: { turnId: 'note', title: 'Note', question: '', state: 'complete', contextPath: [] } } : {}),
        body: 'A short opening paragraph.\n\n- Topic\n  - Detail: More information.\n  - Another detail: More information.' }] }]));
    graph.getState().setProject({ ...project, nodes, arrows: {}, selection: [], rootNodeId: 'encyclopedic', viewport: { x: 200, y: 160, zoom: .4 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(300);
    await page.locator('.sidebar-minimap').screenshot({ path: info.outputPath(`minimap-${theme}.png`) });
  }
  // A lone chat is enlarged to fill the map: message blocks must still look
  // like bubbles rather than the thin stripes used for ordinary prose.
  await page.evaluate(() => {
    const graph = (window as any).testExport('useGraphStore');
    const project = graph.getState().project;
    const chat = { ...project.nodes.chat, position: { x: 0, y: 0 },
      versions: project.nodes.chat.versions.map((version: any) => ({ ...version, bodyMaxHeight: 560 })) };
    graph.getState().setProject({ ...project, nodes: { chat }, rootNodeId: 'chat', color: '#8fb44f' });
  });
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.waitForTimeout(300);
    await page.locator('.sidebar-minimap').screenshot({ path: info.outputPath(`minimap-single-chat-${theme}.png`) });
  }
});

test('scrolling a chat dismisses a term preview before it can escape the node', async ({ page }, info) => {
  await sandbox(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const graph = find('useGraphStore');
    let chat = find('createChatNode')({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 360 });
    chat = find('appendChatAnswer')(chat, { turnId: 't', createdAt: 2, question: 'What is memory?' });
    chat = find('updateChatAnswer')(chat, { turnId: 't', versionCreatedAt: 2 }, {
      body: 'A [[cache]] retains frequently used information.\n\n' + 'Another paragraph with enough text to fill the scrolling area.\n\n'.repeat(20),
    }, { state: 'complete' });
    chat.frozen = true;
    const child = { id: 'cache', type: 'term-click', frozen: true, position: { x: 1100, y: 0 }, currentVersionIndex: 0,
      versions: [{ createdAt: 3, generatedBy: 'term-click', header: 'Cache', body: 'A fast store for frequently accessed data.' }] };
    const project = graph.getState().project;
    graph.getState().setProject({ ...project, nodes: { chat, cache: child }, rootNodeId: 'chat', selection: ['chat'],
      arrows: { a: { id: 'a', kind: 'auto', fromNodeId: 'chat', toNodeId: 'cache', label: 'cache', sourceAnswer: { turnId: 't', versionCreatedAt: 2 } } },
      viewport: { x: 590, y: 100, zoom: .9 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  const scroll = page.locator('.chat-scroll');
  await scroll.evaluate(el => { el.scrollTop = 0; });
  const term = page.locator('.chat-markdown .ref-chip').filter({ hasText: 'cache' }).first();
  await term.hover();
  await expect(page.locator('.relation-hover-preview')).toBeVisible();
  await scroll.evaluate(el => { el.scrollTop = 500; el.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.locator('.relation-hover-preview')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('chat-scrolled-no-escaped-preview.png') });
});

test('editor DOCX export keeps emphasis and includes the active version bibliography', async ({ page }, info) => {
  await sandbox(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const graph = find('useGraphStore');
    const project = graph.getState().project;
    const node = { id: 'export', type: 'manual-empty', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Formatting and bibliography regression', createdAt: 1, generatedBy: 'manual', contentType: 'answer', markdownNote: true,
        chat: { turnId: 'note', title: 'Formatting', question: '', state: 'complete', contextPath: [] },
        body: '## Interpersonal and Dynamic Qualities\n\n- **Humor and quick wit:** Fast-moving associative thinking supports **improvisational humor**.\n- **[[Passionate info-dumping]]:** Deep enthusiasm for **specialized interests**. ⟦5⟧\n\n## Context-Dependent Dualities\n\n| Underlying mechanism | Challenging manifestation | Positive manifestation |\n|---|---|---|\n| **Attention regulation** | Distractibility during routine tasks. | **Hyperfocus** during captivating activities. |\n| **Arousal baseline** | **Task paralysis** and boredom. | **Focused composure** during emergencies. ⟦2⟧ |\n\nThese personal strengths are linked to **higher [[subjective well-being]]**, improved **quality of life**, and fewer **mental health symptoms**.',
        sources: [{ n: 2, url: 'https://www.example.org/emergencies', title: 'Emergency response' },
          { n: 5, url: 'https://www.example.net/interests', title: 'Specialized interests' }] }] };
    graph.getState().setProject({ ...project, nodes: { export: node }, arrows: {}, rootNodeId: 'export', selection: ['export'], viewport: { x: 600, y: 100, zoom: .85 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  await openMainPage(page, 'export');
  await page.getByRole('button', { name: 'Edit or export text' }).click();
  await expect(page.locator('.text-editor-card')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export to .docx' }).click();
  await (await download).saveAs(info.outputPath('formatting-bibliography.docx'));
  await page.screenshot({ path: info.outputPath('export-editor.png') });
});

test('a term wrapping across opposite line edges has separate rounded frames', async ({ page }, info) => {
  await sandbox(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    const graph = find('useGraphStore');
    const project = graph.getState().project;
    const parent = { id: 'journey', type: 'root', frozen: true, position: { x: 0, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Hero’s journey', createdAt: 1, generatedBy: 'manual', contentType: 'encyclopedic', width: 900,
        body: 'Refusal of the Return · The Magic Flight · Rescue from Without · Crossing of the Return Threshold · [[Master of the Two Worlds]] · Freedom to Live' }] };
    const child = { id: 'master', type: 'term-click', frozen: true, position: { x: 2000, y: 0 }, currentVersionIndex: 0,
      versions: [{ header: 'Master of the Two Worlds', body: 'The integration of ordinary and extraordinary experience.', createdAt: 2, generatedBy: 'term-click' }] };
    graph.getState().setProject({ ...project, nodes: { journey: parent, master: child }, rootNodeId: 'journey', selection: ['master'],
      arrows: { term: { id: 'term', kind: 'auto', fromNodeId: 'journey', toNodeId: 'master', label: 'Master of the Two Worlds' } },
      viewport: { x: 380, y: 150, zoom: .9 } });
    graph.setState({ activeProjectId: project.id }); graph.getState().requestPanTo(null);
  });
  const node = page.locator('[data-node-id="journey"]');
  const term = node.locator('.ref-chip').filter({ hasText: 'Master of the Two Worlds' }).first();
  let wrapped = false;
  for (let width = 550; width <= 1100; width += 20) {
    await page.evaluate(width => (window as any).testExport('useGraphStore').getState().setVersionSize('journey', { width }), width);
    await page.waitForTimeout(50);
    wrapped = await term.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      return rects.length >= 2 && Math.abs(rects[0]!.left - rects.at(-1)!.left) > 180 && rects[0]!.bottom <= rects.at(-1)!.top;
    });
    if (wrapped) break;
  }
  expect(wrapped).toBe(true);
  const outline = node.locator('[data-source-selection-outline="master"]');
  await expect.poll(async () => (await outline.getAttribute('d'))?.match(/M/g)?.length).toBe(2);
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await node.screenshot({ path: info.outputPath(`separate-term-frames-${theme}.png`) });
  }
});
