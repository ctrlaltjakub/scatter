import { expect, test, type Page } from '@playwright/test';

async function expose(page: Page) {
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`opacity-${Date.now()}`], {}, (require: any) => {
      win.opacityExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing export: ${name}`);
      };
    }]);
  });
}

async function alphaSum(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('.canvas-host > canvas') as HTMLCanvasElement;
    const capture = (window as any).opacityExport('screenshotRenderer')(canvas);
    if (!capture) throw new Error('ASCII screenshot renderer is missing');
    const image = new Image(); image.src = await capture(1); await image.decode();
    const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0; for (let index = 3; index < pixels.length; index += 4) sum += pixels[index]!;
    return sum;
  });
}

async function uniform(page: Page, name = 'uOpacity') {
  return page.evaluate(name => {
    const canvas = document.querySelector('.canvas-host > canvas') as HTMLCanvasElement;
    const gl = canvas?.getContext('webgl2');
    if (!gl) return null;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const location = program ? gl.getUniformLocation(program, name) : null;
    return location ? gl.getUniform(program, location) : null;
  }, name);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await expect(page.locator('[data-node-id]').first()).toBeVisible();
  await expose(page);
  await expect.poll(() => page.evaluate(() => (window as any).opacityExport('useSettingsStore').getState().hydrated)).toBe(true);
  await expect.poll(() => uniform(page)).toBe(1);
});

test('opacity scales all rendered ink, updates an idle field, resets and survives reload', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const get = (window as any).opacityExport, graph = get('useGraphStore');
    const project = graph.getState().project;
    graph.setState({ project: { ...project, nodes: Object.fromEntries(Object.entries(project.nodes)
      .map(([id, node]: [string, any]) => [id, { ...node, frozen: true }])) } });
    get('useNodeStatusStore').getState().setStatus(project.rootNodeId, 'Opacity test');
  });
  // The sandbox's recording toolbar overlaps this corner; open through the
  // real keyboard action, then exercise the settings controls normally.
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  const slider = page.getByRole('slider', { name: 'ASCII opacity' });
  await expect(slider).toHaveValue('100');
  await slider.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('appearance-opacity.png') });
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
    await page.waitForTimeout(600); // Let the existing theme/label animations settle.
    const original = await alphaSum(page); expect(original).toBeGreaterThan(0);
    await slider.focus(); await page.keyboard.press('Home');
    await expect.poll(() => uniform(page)).toBe(0);
    expect(await alphaSum(page)).toBe(0); // Includes labels/statuses, not just background cells.
    await page.getByRole('spinbutton', { name: 'ASCII opacity value' }).fill('50');
    await expect.poll(() => uniform(page)).toBe(0.5);
    const faded = await alphaSum(page);
    expect(faded).toBeLessThan(original * 0.8); expect(faded).toBeGreaterThan(original * 0.3);
    await slider.focus(); await page.keyboard.press('End');
    await expect.poll(() => uniform(page)).toBe(2);
    expect(await alphaSum(page)).toBeGreaterThan(original * 1.1);
    await page.getByRole('button', { name: 'Reset ASCII opacity to default' }).click();
    await expect.poll(() => uniform(page)).toBe(1);
  }
  await page.getByRole('spinbutton', { name: 'ASCII opacity value' }).fill('175');
  await expect.poll(async () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return JSON.parse(await (await (await root.getFileHandle('settings.json')).getFile()).text()).asciiOpacity;
  })).toBe(175);
  await page.reload(); await expose(page);
  await expect.poll(() => uniform(page)).toBe(1.75);
  expect(errors).toEqual([]);
});

test('interactive side panel has no add-to-sources action', async ({ page }) => {
  await page.evaluate(() => {
    const graph = (window as any).opacityExport('useGraphStore');
    const project = graph.getState().project, node = project.nodes[project.rootNodeId];
    graph.getState().updateNode(node.id, { type: 'interactive', frozen: true, versions: [{ ...node.versions[0],
      contentType: 'interactive', interactiveStandalone: true,
      interactive: { html: '<button>Counter</button>', model: 'fixture', providerId: 'fixture', request: 'Counter' } }] });
    graph.getState().setSelection([node.id]); graph.getState().requestPanTo(node.id);
  });
  const panel = page.locator('.interactive-node-actions');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /sources/i })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Open enlarged', exact: true })).toBeVisible();
});

test('independent labels remain visible with a hidden background and restore their saved setting', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.evaluate(() => {
    const get = (window as any).opacityExport;
    get('useNodeStatusStore').getState().setStatus(get('useGraphStore').getState().project.rootNodeId, 'Label opacity test');
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).focus();
  await page.keyboard.press('Enter');
  const slider = page.getByRole('slider', { name: 'Label and status opacity' });
  const toggle = page.getByRole('switch', { name: /Independent label opacity/ });
  await expect(slider).toBeDisabled();
  await slider.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('label-opacity-disabled.png') });
  await page.getByRole('spinbutton', { name: 'ASCII opacity value', exact: true }).fill('0');
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(0);
  expect(await alphaSum(page)).toBe(0);
  await toggle.check();
  await expect(slider).toBeEnabled();
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(1);
  await expect.poll(() => alphaSum(page)).toBeGreaterThan(0);
  await expect.poll(() => uniform(page)).toBe(0);
  await slider.focus(); await page.keyboard.press('Home');
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(0);
  expect(await alphaSum(page)).toBe(0);
  await page.getByRole('spinbutton', { name: 'ASCII opacity value', exact: true }).fill('100');
  await expect.poll(() => alphaSum(page)).toBeGreaterThan(0);
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(0);
  await page.getByRole('spinbutton', { name: 'Label and status opacity value' }).fill('125');
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(1.25);
  await toggle.uncheck();
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(1);
  await expect(slider).toHaveValue('125');
  await toggle.check();
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(1.25);
  await slider.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('label-opacity-enabled.png') });
  await expect.poll(async () => page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const saved = JSON.parse(await (await (await root.getFileHandle('settings.json')).getFile()).text());
    return [saved.asciiLabelOpacityEnabled, saved.asciiLabelOpacity];
  })).toEqual([true, 125]);
  await page.reload(); await expose(page);
  await expect.poll(() => uniform(page, 'uLabelOpacity')).toBe(1.25);
});

test('the actual GPU shader scatters three tiers around rectangles and point orbs, but not labels', async ({ page }) => {
  const results = await page.evaluate(() => {
    const get = (window as any).opacityExport;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true })!;
    if (!gl) throw new Error('WebGL2 is required');
    const program = gl.createProgram()!;
    for (const [type, name] of [[gl.VERTEX_SHADER, 'VERTEX_SRC'], [gl.FRAGMENT_SHADER, 'PASS_B_FRAGMENT_SRC']] as const) {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, get(name)); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compilation failed');
      gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Shader linking failed');
    gl.useProgram(program); gl.bindVertexArray(gl.createVertexArray());
    const u = (name: string) => gl.getUniformLocation(program, name);
    function texture(unit: number, name: string, width: number, height: number, data: Uint8Array | Float32Array) {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, data instanceof Float32Array ? gl.RGBA32F : gl.RGBA8,
        width, height, 0, gl.RGBA, data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
      gl.uniform1i(u(name), unit);
    }
    gl.uniform1f(u('uOpacity'), 1); gl.uniform1f(u('uLabelOpacity'), 1);
    gl.uniform1f(u('uAlphaBoost'), 0); gl.uniform1f(u('uDeviceCellPx'), 1);
    gl.uniform1f(u('uCellCssPx'), 1); gl.uniform1f(u('uCanvasHpx'), 512);
    gl.uniform3f(u('uViewport'), 0, 0, 1); gl.uniform2i(u('uCellsMax'), 511, 511);
    gl.uniform4f(u('uNeutral'), 1, 1, 1, 0.8); gl.uniform1i(u('uPaletteCount'), 0);
    texture(2, 'uAtlas', 256, 1, new Uint8Array(256 * 4).fill(255)); // Opaque glyphs: test ink alpha only.
    const state = new Uint8Array(512 * 512 * 4), overlay = new Uint8Array(state.length);
    for (let i = 0; i < state.length; i += 4) state[i + 3] = 204;
    texture(0, 'uCellState', 512, 512, state); texture(3, 'uOverlay', 512, 512, overlay);
    const output = [];
    for (const [name, width, height, radius, focused] of [
      ['unfocused', 120, 180, 150, 0], ['focused', 120, 180, 160, 1], ['orb', 0, 0, 240, 1],
    ] as const) {
      const x = (512 - width) / 2, y = (512 - height) / 2;
      texture(1, 'uRecords', 4, 1, new Float32Array([x,y,width,height,radius,focused,0.8,0,1,1,1,0,0,0,0,0]));
      const pixels = new Uint8Array(state.length);
      const draw = () => { gl.drawArrays(gl.TRIANGLES, 0, 3); gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, pixels); };
      draw(); const first = pixels.slice(); draw();
      const counts: Record<number, number> = {}; let innerSum=0, innerCount=0, outerSum=0, outerCount=0;
      for (let row=0; row<512; row++) for (let col=0; col<512; col++) {
        const d = Math.hypot(Math.max(x-col-0.5,0,col+0.5-x-width),Math.max(y-row-0.5,0,row+0.5-y-height));
        if (d <= 0 || d >= radius) continue;
        const a = pixels[((511-row)*512+col)*4+3]!;
        counts[a] = (counts[a] ?? 0) + 1;
        if (d < radius/3) { innerSum+=a;innerCount++; }
        if (d > radius*2/3) { outerSum+=a;outerCount++; }
      }
      output.push({name,counts,inner:innerSum/innerCount,outer:outerSum/outerCount,stable:pixels.every((a,i)=>a===first[i])});
    }
    // Labels, statuses and selection marks all use overlay glyphs. None get
    // the aura scatter, and they still render with uOpacity == 0.
    for (const mode of [0, 255, 254, 252]) {
      for (let i=0; i<overlay.length; i+=4) {overlay[i]=1;overlay[i+3]=mode;}
      texture(3,'uOverlay',512,512,overlay);
      gl.uniform1f(u('uOpacity'),0);gl.uniform1f(u('uLabelOpacity'),0.5);
      gl.drawArrays(gl.TRIANGLES,0,3);
      const pixel = new Uint8Array(4);gl.readPixels(256,256,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      if (pixel[3] !== 102) throw new Error(`Overlay mode ${mode} inherited aura opacity or noise: ${pixel[3]}`);
    }
    if(gl.getError()!==gl.NO_ERROR) throw new Error('GPU opacity probe failed');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return output;
  });
  for (const result of results) {
    expect(Object.keys(result.counts).map(Number).sort((a,b)=>a-b)).toEqual([102,153,204]);
    const total = Object.values(result.counts).reduce((a,b)=>a+b,0);
    expect(result.counts[102]!/total).toBeCloseTo(0.25,2);
    expect(result.counts[153]!/total).toBeCloseTo(0.5,2);
    expect(result.counts[204]!/total).toBeCloseTo(0.25,2);
    expect(result.inner).toBeGreaterThan(result.outer + 15);
    expect(result.stable).toBe(true);
  }
});
