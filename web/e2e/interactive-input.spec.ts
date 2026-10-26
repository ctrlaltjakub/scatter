import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const PROGRAM = `<!doctype html><html><head><style>
body{padding:30px;background:var(--sc-bg);color:var(--sc-text);font:20px sans-serif}
button,input,label{margin:12px;padding:12px}button{background:var(--sc-primary);cursor:var(--sc-cursor-click,pointer)}
</style></head><body><h1>Interactive input regression</h1>
<button id="add"><span>Add one</span></button><output id="count">0</output>
<button id="later">Delayed update</button><output id="delayed">0</output><br>
<label><input id="enabled" type="checkbox">Enabled</label>
<input id="amount" type="range" min="0" max="10" value="5"><input id="name" aria-label="Name">
<button id="disabled" disabled>Unavailable</button>
<script>let n=0;document.querySelector('#add').onclick=()=>document.querySelector('#count').textContent=String(++n);
document.querySelector('#later').onclick=()=>setTimeout(()=>document.querySelector('#delayed').textContent='1',50);</script>
</body></html>`;

// Convert the control's own viewport coordinates through the scaled iframe.
// Cross-process frame locator coordinates can be unscaled in headed Chromium.
async function controlPoint(page: Page, selector: string) {
  const frame = page.frameLocator('iframe[title="Interactive program"]');
  await frame.locator(selector).waitFor({ state: 'visible' });
  // Physical coordinates do not get locator.click's overlay/readiness checks.
  await expect(page.getByRole('status', { name: 'Loading interactive program', exact: true })).toHaveCount(0);
  const outer = await page.locator('iframe[title="Interactive program"]').boundingBox();
  if (!outer) throw new Error('Interactive program is not visible');
  const inner = await frame.locator(selector).evaluate(el => ({
    rect: el.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight,
  }));
  return {
    x: outer.x + (inner.rect.x + inner.rect.width / 2) * outer.width / inner.width,
    y: outer.y + (inner.rect.y + inner.rect.height / 2) * outer.height / inner.height,
  };
}

async function clickControl(page: Page, selector: string) {
  const { x, y } = await controlPoint(page, selector);
  await page.mouse.click(x, y, { delay: 100 });
}

async function seed(page: Page, building = false, html = PROGRAM) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/*', route => ['127.0.0.3', '127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ html, building }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`interactive-input-${Date.now()}`], {}, (require: any) => {
      win.inputExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.inputExport;
    get('useSettingsStore').setState({ providers: [], activeModelRef: null, autoTermPreviews: false, autoFreeImages: false,
      cameraAutoPan: {}, webSearch: false });
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    const node = { id: 'interactive-input', type: 'interactive', frozen: true, position: { x: 0, y: 0 },
      currentVersionIndex: 0, generating: building, generatingVersionIndex: building ? 0 : undefined,
      versions: [{ header: 'Interactive input test', body: '', contentType: 'interactive', createdAt: 1, generatedBy: 'manual',
        language: 'en', interactiveStandalone: true, width: 800, bodyMaxHeight: 573,
        ...(building ? { interactiveBuild: { state: 'building', model: 'moonshotai/kimi-k3.1-pro', steps: Array.from({ length: 45 }, (_, i) => ({ id: i,
          label: `Verification step ${i + 1}`, state: i === 44 ? 'running' : 'complete', detail: 'Checking the program.' })) } }
          : { interactive: { html, request: 'Input test', providerId: 'test', model: 'test', viewportWidth: 960, viewportHeight: 720 } }),
      }] };
    graph.getState().setProject({ ...project, id: 'interactive-input-regression', nodes: { [node.id]: node }, arrows: {},
      rootNodeId: node.id, selection: building ? [] : [node.id], viewport: { x: 590, y: 100, zoom: .85 } });
    graph.setState({ activeProjectId: 'interactive-input-regression', panTo: null });
  }, { html, building });
  await expect(page.locator('[data-node-id="interactive-input"]').first()).toBeVisible();
}

async function openMainPage(page: Page) {
  await page.evaluate(async () => {
    const get = (window as any).inputExport;
    const project = get('useGraphStore').getState().project;
    const settings = { ...get('useSettingsStore').getState(),
      providers: [{ id: 'fixture', preset: 'custom', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-not-a-key', enabledModels: ['fixture'] }],
      activeModelRef: { providerId: 'fixture', model: 'fixture' } };
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
  await page.locator('[data-node-id="interactive-input"] .node-header').click();
  const activate = page.getByRole('button', { name: 'Focus interactive node' });
  if (await activate.isVisible()) await activate.click();
  await expect(page.locator('.sc-interactive-frame-wrap')).not.toHaveClass(/is-paused/);
  // Restored projects may normalize world coordinates; use the app's real
  // focus-camera path rather than assuming the fixture's initial translation.
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`interactive-main-input-${Date.now()}`], {}, (require: any) => {
      for (const entry of Object.values(require.c) as any[]) if (entry.exports?.useGraphStore) {
        entry.exports.useGraphStore.getState().requestPanTo('interactive-input'); break;
      }
    }]);
  });
  await expect.poll(() => page.locator('iframe[title="Interactive program"]').evaluate(el => {
    const box = el.getBoundingClientRect(); return box.left >= 240 && box.right <= innerWidth && box.bottom <= innerHeight;
  })).toBe(true);
}

test('real pointer input keeps the embedded program active and its controls responsive', async ({ page }, info) => {
  await seed(page);
  const wrapper = page.locator('.sc-interactive-frame-wrap');
  const frame = page.frameLocator('iframe[title="Interactive program"]');
  await expect(wrapper).not.toHaveClass(/is-paused/);
  await clickControl(page, '#add');
  await expect(frame.locator('#count')).toHaveText('1');
  await expect(wrapper).not.toHaveClass(/is-paused/);
  await clickControl(page, '#add');
  await expect(frame.locator('#count')).toHaveText('2');
  await clickControl(page, '#enabled');
  await expect(frame.locator('#enabled')).toBeChecked();
  await clickControl(page, '#later');
  await expect(frame.locator('#delayed')).toHaveText('1');
  await frame.locator('#name').fill('Keyboard input');
  await expect(frame.locator('#name')).toHaveValue('Keyboard input');
  await page.screenshot({ path: info.outputPath('interactive-input-working.png') });
});

test('corner resizing preserves proportions and program state, including vertical drags', async ({ page }, info) => {
  await seed(page);
  await clickControl(page, '#add');
  const node = page.locator('.node[data-node-id="interactive-input"]');
  const body = node.locator('.interactive-node-body');
  const frame = page.frameLocator('iframe[title="Interactive program"]');
  await expect(node.locator('.node-resize')).toHaveCount(4);
  for (const corner of ['br', 'tr', 'bl', 'tl']) {
    const before = await node.boundingBox();
    const handle = await node.locator(`.node-resize.${corner}`).boundingBox();
    if (!before || !handle) throw new Error('Resize handle is missing');
    const left = corner.endsWith('l');
    const top = corner.startsWith('t');
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (corner === 'br' ? 0 : left ? -30 : 30), y + (top ? -30 : 30), { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await node.boundingBox())!.width).toBeGreaterThan(before.width + 20);
    const after = (await node.boundingBox())!;
    const surface = (await body.boundingBox())!;
    expect(Math.abs(surface.height - surface.width * .75)).toBeLessThan(1);
    expect(Math.abs((left ? after.x + after.width : after.x) - (left ? before.x + before.width : before.x))).toBeLessThan(2);
    expect(Math.abs((top ? after.y + after.height : after.y) - (top ? before.y + before.height : before.y))).toBeLessThan(2);
    await expect(frame.locator('#count')).toHaveText('1');
  }
  await clickControl(page, '#add');
  await expect(frame.locator('#count')).toHaveText('2');
  await expect(node.locator('.sc-interactive-frame-wrap')).not.toHaveClass(/is-paused/);
  await page.screenshot({ path: info.outputPath('interactive-resized.png') });
});

test('embedded controls show the same brief pointer-press feedback as app controls', async ({ page }) => {
  await seed(page);
  const frame = page.frameLocator('iframe[title="Interactive program"]');
  const hover = await controlPoint(page, '#add');
  await page.mouse.move(hover.x, hover.y);
  await frame.locator('html').evaluate(el => {
    const win = el.ownerDocument.defaultView as any;
    win.pressEvents = [];
    const sample = el.ownerDocument.createElement('span');
    sample.style.cursor = 'var(--sc-cursor-press)'; el.ownerDocument.body.appendChild(sample);
    const expected = getComputedStyle(sample).cursor; sample.remove();
    win.addEventListener('pointerdown', (event: PointerEvent) => {
      const target = event.target as Element;
      win.pressEvents.push({ classes: el.className, target: target.id || target.parentElement?.id,
        matchesPressCursor: getComputedStyle(target).cursor === expected });
    });
  });
  await clickControl(page, '#add');
  await clickControl(page, '#enabled');
  await clickControl(page, '#name');
  await clickControl(page, '#disabled');
  const events = await frame.locator('html').evaluate(el => (el.ownerDocument.defaultView as any).pressEvents);
  expect(events).toEqual([
    { target: 'add', classes: 'sc-pressing', matchesPressCursor: true },
    { target: 'enabled', classes: 'sc-pressing', matchesPressCursor: true },
    { target: 'name', classes: '', matchesPressCursor: false },
    { target: 'disabled', classes: 'sc-disabled-pressing', matchesPressCursor: false },
  ]);
  await expect(frame.locator('html')).not.toHaveClass(/sc-(disabled-)?pressing/);
});

test('main app and expanded viewer retain clicks and recover focus after switching tabs', async ({ page, context }, info) => {
  test.setTimeout(90_000);
  await seed(page);
  await openMainPage(page);
  for (const expanded of [false, true]) {
    if (expanded) await page.getByRole('button', { name: 'Open interactive in a window' }).click();
    const frame = page.frameLocator('iframe[title="Interactive program"]');
    const wrapper = page.locator(`.sc-interactive-frame-wrap--${expanded ? 'viewer' : 'canvas'}`);
    await clickControl(page, '#add');
    await expect(frame.locator('#count')).toHaveText('1');
    const other = await context.newPage();
    await other.goto('about:blank'); await other.bringToFront();
    await page.bringToFront(); await other.close();
    await expect(wrapper).not.toHaveClass(/is-paused/);
    await clickControl(page, '#later');
    await expect(frame.locator('#delayed')).toHaveText('1');
    await clickControl(page, '#add');
    await expect(frame.locator('#count')).toHaveText('2');
    await page.screenshot({ path: info.outputPath(`main-input-${expanded ? 'viewer' : 'canvas'}.png`) });
  }
});

test('saved P2P program accepts real input in the main app and enlarged viewer', async ({ page }, info) => {
  test.skip(!process.env.SCATTER_INTERACTIVE_INPUT_RESULT, 'Optional saved-program reproduction; no model requests.');
  test.setTimeout(90_000);
  const { html } = JSON.parse(await readFile(process.env.SCATTER_INTERACTIVE_INPUT_RESULT!, 'utf8'));
  await seed(page, false, html);
  await openMainPage(page);
  for (const expanded of [false, true]) {
    if (expanded) await page.getByRole('button', { name: 'Open interactive in a window' }).click();
    const frame = page.frameLocator('iframe[title="Interactive program"]');
    await page.screenshot({ path: info.outputPath(`p2p-input-before-${expanded ? 'viewer' : 'canvas'}.png`) });
    await clickControl(page, '#node-btn-B');
    await expect(frame.locator('#node-btn-B')).toHaveClass(/active/);
    const before = await frame.locator('#step-btn').innerText();
    await clickControl(page, '#step-btn');
    await expect(frame.locator('#step-btn')).not.toHaveText(before);
    await page.screenshot({ path: info.outputPath(`p2p-input-${expanded ? 'viewer' : 'canvas'}.png`) });
  }
});

test('scrolling an unfocused generation log does not zoom the canvas, including at its edges', async ({ page }, info) => {
  await seed(page, true);
  const log = page.getByRole('log');
  const viewport = () => page.evaluate(() => {
    const state = (window as any).inputExport('useLiveViewportStore').getState();
    return { x: state.x, y: state.y, zoom: state.zoom };
  });
  const before = await viewport();
  await log.evaluate(el => el.scrollTop = 0);
  await log.hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await viewport()).toEqual(before);
  for (const delta of [-4000, -300, 4000, 300]) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(100);
    expect(await viewport()).toEqual(before);
  }
  await page.screenshot({ path: info.outputPath('unfocused-generation-log.png') });
});

test('generation progress respects manual scrolling and resumes following at the bottom', async ({ page }, info) => {
  await seed(page, true);
  const log = page.getByRole('log');
  const gap = () => log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(gap).toBeLessThan(4);
  await log.hover(); await page.mouse.wheel(0, -700);
  // Browser wheel scaling differs (Firefox may move roughly half the given
  // delta). This tests leaving the bottom, not a particular scroll distance.
  await expect.poll(gap).toBeGreaterThan(100);
  // Wait for the browser's wheel animation to settle before comparing positions.
  await page.waitForTimeout(400);
  const position = await log.evaluate(el => el.scrollTop);
  const addProgress = () => page.evaluate(() => {
    const graph = (window as any).inputExport('useGraphStore').getState();
    const node = graph.project.nodes['interactive-input'];
    const version = node.versions[0], build = version.interactiveBuild;
    graph.updateNode(node.id, { versions: [{ ...version, interactiveBuild: { ...build,
      steps: [...build.steps, { id: String(build.steps.length), label: 'New progress entry', state: 'running', detail: 'Still generating.' }] } }] });
  });
  await addProgress(); await addProgress();
  await expect.poll(() => log.evaluate(el => el.scrollTop)).toBe(position);
  await page.screenshot({ path: info.outputPath('progress-reading-history.png') });
  await log.evaluate(el => el.scrollTop = el.scrollHeight);
  await expect.poll(gap).toBeLessThan(4);
  await addProgress();
  await expect.poll(gap).toBeLessThan(4);
});

test('pinching over an interactive frame zooms the canvas, not the browser page', async ({ page }, info) => {
  await seed(page);
  const viewport = () => page.evaluate(() => {
    const state = (window as any).inputExport('useLiveViewportStore').getState();
    return { zoom: state.zoom, pageWidth: innerWidth, scale: visualViewport?.scale };
  });
  const before = await viewport();
  const point = await controlPoint(page, '#add');
  await page.mouse.move(point.x, point.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await viewport()).zoom).toBeGreaterThan(before.zoom);
  const closer = await viewport();
  expect(closer.pageWidth).toBe(before.pageWidth);
  expect(closer.scale).toBe(before.scale);
  const movedPoint = await controlPoint(page, '#add');
  await page.mouse.move(movedPoint.x, movedPoint.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 50);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await viewport()).zoom).toBeLessThan(closer.zoom);
  expect((await viewport()).pageWidth).toBe(before.pageWidth);
  await clickControl(page, '#add');
  await expect(page.frameLocator('iframe[title="Interactive program"]').locator('#count')).toHaveText('1');
  await page.screenshot({ path: info.outputPath('pinch-canvas-not-page.png') });
});

test('generation and capability probes are silent without muting finished programs', async ({ page }) => {
  test.setTimeout(90_000);
  // Observe the native output boundary before the host installs its sandbox
  // hooks. Never play a test tone or speak to the person running this suite.
  await page.addInitScript(() => {
    const win = window as any;
    win.audioTestRoutes = [];
    win.audioTestSpeech = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
      win.audioTestRoutes.push({ from: this, to: args[0] });
      return Reflect.apply(connect, this, args);
    } as AudioNode['connect'];
    if (typeof SpeechSynthesis !== 'undefined') SpeechSynthesis.prototype.speak = function (utterance) {
      win.audioTestSpeech.push(utterance.volume);
    };
  });
  const html = `<!doctype html><html><head><style>
    body{padding:24px;background:var(--sc-bg);color:var(--sc-text);font:18px sans-serif}
    button{padding:12px;background:var(--sc-primary)}output{display:block}audio,video{display:none}
    </style></head><body><button id="play">Start sequencer</button>
    <output id="gate"></output><output id="media"></output><output id="speech"></output>
    <output id="offline"></output><output id="chain"></output><output id="ticks">0</output>
    <output id="clicked">0</output><audio id="parser" autoplay></audio><script>
    const context=new AudioContext();
    const output=context.createGain();output.gain.value=0;
    // A finished node connects directly; a probe adds its private silent gate.
    // The fixture's own output is also zero, so even a failing test is silent.
    const chained=output.connect(context.destination)===context.destination;
    output.disconnect(context.destination);output.connect(context.destination,0,0);
    const intermediate=context.createGain();output.connect(intermediate);output.disconnect(intermediate);
    output.connect(intermediate.gain);output.disconnect(intermediate.gain);
    document.querySelector('#chain').textContent=chained?'preserved':'broken';
    const audio=new Audio();audio.muted=false;
    const video=document.createElement('video');video.autoplay=true;video.muted=false;document.body.append(video);
    const detached=document.createElement('audio');detached.muted=false;
    let clicks=0,ticks=0;
    function report(){
      const routes=window.audioTestRoutes.filter(r=>r.to===context.destination);
      document.querySelector('#gate').textContent=routes.length&&routes.every(r=>r.from!==output&&r.from.gain.value===0)?'silent':'direct';
      document.querySelector('#media').textContent=[audio,video,detached,document.querySelector('#parser')].every(m=>m.muted)?'silent':'normal';
      document.querySelector('#speech').textContent=typeof speechSynthesis==='undefined'?'unavailable':window.audioTestSpeech.at(-1)===0?'silent':'normal';
    }
    setInterval(()=>{document.querySelector('#ticks').textContent=String(++ticks)},30);
    document.querySelector('#play').onclick=()=>{
      context.resume().catch(()=>{});
      [audio,video,detached,document.querySelector('#parser')].forEach(m=>{m.muted=false;m.play().catch(()=>{})});
      if(typeof speechSynthesis!=='undefined'){
        const utterance=new SpeechSynthesisUtterance('Test');utterance.volume=.8;speechSynthesis.speak(utterance);
      }
      document.querySelector('#clicked').textContent=String(++clicks);report();
    };
    const offline=new OfflineAudioContext(1,128,44100),source=offline.createConstantSource();
    source.offset.value=.25;source.connect(offline.destination);source.start();
    offline.startRendering().then(buffer=>document.querySelector('#offline').textContent=buffer.getChannelData(0)[0]===.25?'preserved':'muted');
    setTimeout(report,50);
    </script></body></html>`;
  await seed(page, true);
  const result = await page.evaluate(async html => {
    const get = (window as any).inputExport;
    return get('checkInteractiveDocument')(html, get('DEFAULT_INTERACTIVE_HOST_STATE').theme, new AbortController().signal,
      [{ selector: '#play', action: 'click' }], { assertions: [
        ...['gate', 'media', 'speech'].map(id => ({ selector: `#${id}`, property: 'text', operator: 'equals', expected: 'silent' })),
        ...['offline', 'chain'].map(id => ({ selector: `#${id}`, property: 'text', operator: 'equals', expected: 'preserved' })),
        { selector: '#clicked', property: 'text', operator: 'equals', expected: '1' },
        { selector: '#ticks', property: 'text', operator: 'greaterThan', expected: 0 },
      ] });
  }, html);
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.assertions).toHaveLength(7);
  expect(result.assertions.every((item: { passed: boolean }) => item.passed)).toBe(true);
  await expect(page.locator('iframe[title="Checking interactive program"]')).toHaveCount(0);

  await seed(page, false, html);
  await clickControl(page, '#play');
  const frame = page.frameLocator('iframe[title="Interactive program"]');
  await expect(frame.locator('#gate')).toHaveText('direct');
  await expect(frame.locator('#media')).toHaveText('normal');
  await expect(frame.locator('#speech')).toHaveText('normal');
  await expect(frame.locator('#offline')).toHaveText('preserved');
  await expect(frame.locator('#chain')).toHaveText('preserved');
  await expect(frame.locator('#clicked')).toHaveText('1');
});

test('verification fits compact content, retains larger states and protects clipped panels and HiDPI canvases', async ({ page }, info) => {
  test.setTimeout(90_000);
  await seed(page, true);
  const results = await page.evaluate(async () => {
    const get = (window as any).inputExport;
    const check = get('checkInteractiveDocument'), theme = get('DEFAULT_INTERACTIVE_HOST_STATE').theme;
    const html = `<!doctype html><html><head><meta name="scatter-viewport" content="width=960,height=720">
      <title>Compact program</title><style>
      body{margin:0;padding:24px;min-height:100vh;display:grid;justify-content:center;background:var(--sc-bg);color:var(--sc-text);font:16px/20px sans-serif}
      .panel{width:600px;height:220px;padding:16px;border:1px solid var(--sc-primary)}p{margin:0 0 12px}
      button{height:36px;margin-bottom:8px}svg{display:block}.extra{width:600px;height:350px}
      </style></head><body><main class="panel"><p>日本語 · العربية · हिन्दी · Zażółć gęślą jaźń</p>
      <button id="expand">Show details</button><svg width="200" height="80"><circle cx="40" cy="40" r="30" fill="var(--sc-primary)"/></svg></main>
      <aside id="extra" class="extra" hidden>Expanded information</aside>
      <script>document.querySelector('#expand').onclick=()=>document.querySelector('#extra').hidden=false;</script></body></html>`;
    const basic = await check(html, theme, new AbortController().signal, [], { screenshot: true });
    const expanded = await check(html, theme, new AbortController().signal, [{ selector: '#expand', action: 'click' }]);
    const clipped = await check(html.replace('</style>', '.panel{overflow:auto}.panel svg{width:1800px;height:1000px}</style>'),
      theme, new AbortController().signal);
    const overflowing = await check(html.replaceAll('width:600px', 'width:1200px'), theme, new AbortController().signal);
    const tooLarge = await check(html.replaceAll('width:600px', 'width:2000px'), theme, new AbortController().signal);
    const canvas = await check(`<!doctype html><html><head><style>
      body{margin:0;background:var(--sc-bg);color:var(--sc-text)}canvas{display:block;width:100%;height:100%;outline-color:var(--sc-primary)}
      </style></head><body><canvas></canvas><script>const canvas=document.querySelector('canvas');canvas.width=innerWidth*2;canvas.height=innerHeight*2;</script></body></html>`,
      theme, new AbortController().signal);
    return { basic, expanded, clipped, overflowing, tooLarge, canvas };
  });
  for (const result of [results.basic, results.expanded, results.clipped, results.overflowing, results.canvas]) {
    expect(result.errors, JSON.stringify(result)).toEqual([]);
    expect(result.ok).toBe(true);
  }
  expect(results.basic.viewport).toEqual({ width: 648, height: 268 });
  expect(results.expanded.viewport).toEqual({ width: 648, height: 618 });
  expect(results.clipped.viewport).toEqual({ width: 648, height: 268 });
  expect(results.overflowing.viewport).toEqual({ width: 1248, height: 268 });
  expect(results.tooLarge.ok).toBe(false);
  expect(results.tooLarge.errors.join(' ')).toContain('1600');
  expect(results.canvas.viewport).toEqual({ width: 960, height: 720 });
  expect(results.basic.text).toContain('العربية');
  expect(results.basic.text).toContain('हिन्दी');
  const screenshot = results.basic.screenshot!;
  expect(screenshot).toMatch(/^data:image\/png;base64,/);
  await page.evaluate(screenshot => {
    const image = document.createElement('img'); image.id = 'fitted-program-preview'; image.src = screenshot;
    image.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647'; document.body.append(image);
  }, screenshot);
  await page.locator('#fitted-program-preview').screenshot({ path: info.outputPath('interactive-fitted-content.png') });
});
