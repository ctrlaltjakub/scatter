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

test('round opaque orb cores follow existing glyph-field cooling without a separate opacity trail', async ({ page }) => {
  const result = await page.evaluate(() => {
    const get = (window as any).opacityExport;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const gl = canvas.getContext('webgl2')!;
    if (!gl) throw new Error('WebGL2 is required');
    function program(fragment: string) {
      const p = gl.createProgram()!;
      for (const [type, source] of [[gl.VERTEX_SHADER, get('VERTEX_SRC')], [gl.FRAGMENT_SHADER, get(fragment)]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
        gl.attachShader(p, shader); gl.deleteShader(shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
      return p;
    }
    function texture(width: number, height: number, internal: number, format: number, type: number, data: Uint8Array | Float32Array | null) {
      const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
      return tex;
    }
    const a = program('PASS_A_FRAGMENT_SRC'), b = program('PASS_B_FRAGMENT_SRC');
    gl.bindVertexArray(gl.createVertexArray()); gl.viewport(0, 0, 64, 64);
    const records = texture(8, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
    const atlas = texture(256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(1024).fill(255));
    const overlay = texture(64, 64, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64*64*4));
    const targets = [0, 1].map(() => {
      const state = texture(64, 64, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const history = texture(64, 64, gl.RG8, gl.RG, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, history, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Orb history framebuffer is incomplete');
      return { state, history, fbo };
    });
    const bind = (p: WebGLProgram, unit: number, name: string, tex: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(p, name), unit);
    };
    let next = 0;
    function step(x: number, dt: number, reset = false, ripple = false, trails = true,
      options: { zoom?: number; opacity?: number; alpha?: number; label?: boolean; overlap?: boolean } = {}) {
      const read = targets[1-next]!, write = targets[next]!; next = 1-next;
      // One output pixel per cell with opaque atlas coverage isolates ink
      // alpha. World coordinates still use the real 9 CSS-pixel cell pitch.
      const zoom = options.zoom ?? 0.75, toWorld = 9 / zoom, alpha = options.alpha ?? 0.8;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, records);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 8, 1, gl.RGBA, gl.FLOAT,
        new Float32Array([
          x*toWorld,32.5*toWorld,0,0,12*toWorld,1,alpha,0,1,1,1,ripple?1:0,ripple?0:-1,-1,-1,-1,
          24.5*toWorld,32.5*toWorld,0,0,12*toWorld,1,alpha,0,1,0,0,0,-1,-1,-1,-1,
        ]));
      gl.bindTexture(gl.TEXTURE_2D, overlay);
      const overlayData = new Uint8Array(64*64*4);
      if (options.label) for (let i=0;i<overlayData.length;i+=4) overlayData[i]=1;
      gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,overlayData);
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo); gl.useProgram(a);
      bind(a, 0, 'uRecords', records); bind(a, 1, 'uPrevState', read.state); bind(a, 2, 'uPrevOpacityHistory', read.history);
      gl.uniform1i(gl.getUniformLocation(a,'uRecordCount'),options.overlap?2:1);
      gl.uniform3f(gl.getUniformLocation(a,'uViewport'),0,0,zoom);
      gl.uniform1f(gl.getUniformLocation(a,'uCellCssPx'),9);
      gl.uniform1f(gl.getUniformLocation(a,'uDtMs'),dt);
      gl.uniform1f(gl.getUniformLocation(a,'uCoolRate'),4); // same two-second cooldown as restoration
      gl.uniform1i(gl.getUniformLocation(a,'uResetHistory'),reset?1:0);
      gl.uniform1i(gl.getUniformLocation(a,'uPointOpacityTrails'),trails?1:0);
      gl.drawArrays(gl.TRIANGLES,0,3);
      const history = new Uint8Array(64*64*4), state = new Uint8Array(history.length);
      gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,state);
      gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,history);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.useProgram(b);
      bind(b,0,'uCellState',write.state); bind(b,1,'uRecords',records); bind(b,2,'uAtlas',atlas);
      bind(b,3,'uOverlay',overlay); bind(b,4,'uOpacityHistory',write.history);
      gl.uniform1i(gl.getUniformLocation(b,'uPointOpacityTrails'),trails?1:0);
      for (const name of ['uOpacity','uLabelOpacity','uDeviceCellPx','uCellCssPx']) gl.uniform1f(gl.getUniformLocation(b,name),1);
      gl.uniform1f(gl.getUniformLocation(b,'uOpacity'),options.opacity??1);
      gl.uniform1f(gl.getUniformLocation(b,'uCellCssPx'),9);
      gl.uniform1f(gl.getUniformLocation(b,'uCanvasHpx'),64);
      gl.uniform3f(gl.getUniformLocation(b,'uViewport'),0,0,zoom);
      gl.uniform2i(gl.getUniformLocation(b,'uCellsMax'),63,63);
      gl.uniform4f(gl.getUniformLocation(b,'uNeutral'),1,1,1,alpha);
      gl.drawArrays(gl.TRIANGLES,0,3);
      const pixels = new Uint8Array(history.length); gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Orb cooldown GPU probe failed');
      return { history, state, pixels };
    }
    const initial = step(16.5,0,true);
    const full: number[] = [];
    for (let i=3;i<initial.pixels.length;i+=4) if (initial.pixels[i]===204) full.push(i);
    const count = (frame: ReturnType<typeof step>) => full.filter(i=>frame.pixels[i]===204).length;
    const moved = step(48.5,16);
    const retained = count(moved);
    const fadedFrame = step(48.5,600);
    const fading = count(fadedFrame);
    const cooled = step(48.5,2500);
    const reset = step(16.5,0,true);
    const resetMoved = step(48.5,0,true);
    const plain = step(16.5,0,true);
    const ripple = step(16.5,0,true,true);
    step(16.5,0,true,false,false);
    const regularMoved = step(48.5,16,false,false,false);
    const pixelAlpha = (frame: ReturnType<typeof step>, x: number, y: number) => frame.pixels[((63-y)*64+x)*4+3]!;
    const proximity = (frame: ReturnType<typeof step>, x: number, y: number) => {
      const i=(y*64+x)*4;
      return (frame.history[i]!+frame.history[i+1]!/255)/8;
    };
    const coreCells: [number, number][] = [];
    let circleMatches = true;
    for (let y=0;y<64;y++) for(let x=0;x<64;x++) {
      const inCircle = Math.hypot(x+0.5-16.5,y+0.5-32.5)*9 <= get('POINT_ORB_CORE_RADIUS_PX');
      if(inCircle) coreCells.push([x,y]);
      if ((pixelAlpha(initial,x,y)===255)!==inCircle) circleMatches=false;
    }
    const dark = step(16.5,0,true,false,true,{alpha:0.7});
    const light = step(16.5,0,true,false,true,{alpha:1});
    const zero = step(16.5,0,true,false,true,{opacity:0});
    const half = step(16.5,0,true,false,true,{opacity:0.5});
    const label = step(16.5,0,true,false,true,{label:true});
    const overlap = step(16.5,0,true,false,true,{overlap:true});
    const zoomed = step(16.5,0,true,false,true,{zoom:1.5});
    step(16.5,0,true);
    let highRefresh = initial;
    for(let i=0;i<240;i++) highRefresh=step(48.5,1000/120);
    const result = {
      full:full.length,retained,fading,cooled:count(cooled),reset:count(resetMoved),
      allCooledHalf:full.every(i=>cooled.pixels[i]===102),
      hasGlyphWake:moved.state.some((v,i)=>i%4===0 && v>0 && moved.state[i+2]===255),
      rippleHistoryEqual:plain.history.every((v,i)=>v===ripple.history[i]),
      rippleChangesGlyphs:plain.state.some((v,i)=>i%4===0 && v!==ripple.state[i]),
      regularRetained:count(regularMoved),
      resetReproducible:initial.pixels.every((v,i)=>v===reset.pixels[i]),
      coreCount:coreCells.length,circleMatches,
      opaqueBothThemes:coreCells.every(([x,y])=>pixelAlpha(dark,x,y)===255 && pixelAlpha(light,x,y)===255),
      coreWake:{initial:pixelAlpha(initial,16,32),moved:pixelAlpha(moved,16,32),fading:pixelAlpha(fadedFrame,16,32),cooled:pixelAlpha(cooled,16,32)},
      proximity:{moved:proximity(moved,16,32),fading:proximity(fadedFrame,16,32),cooled:proximity(cooled,16,32),reset:proximity(resetMoved,16,32)},
      noSeparateCoreHistory:initial.history.every((v,i)=>i%4!==2&&i%4!==3||v===(i%4===2?0:255)),
      noLingeringOpacity:pixelAlpha(highRefresh,16,32)<255,
      hidden:zero.pixels.every((v,i)=>i%4!==3||v===0),
      halfCore:coreCells.every(([x,y])=>pixelAlpha(half,x,y)===128),
      labelsUnchanged:coreCells.every(([x,y])=>pixelAlpha(label,x,y)===204),
      overlapPreservesCore:coreCells.every(([x,y])=>pixelAlpha(overlap,x,y)===255 && overlap.state[(y*64+x)*4+2]===0),
      secondCoreOwner:overlap.state[(32*64+24)*4+2],
      zoomIndependent:initial.pixels.every((v,i)=>v===zoomed.pixels[i]),
      regularOpaque:regularMoved.pixels.some((v,i)=>i%4===3&&v===255),
    };
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return result;
  });
  expect(result.full).toBeGreaterThan(10);
  expect(result.retained).toBeGreaterThan(result.full*0.8);
  expect(result.fading).toBeLessThan(result.retained);
  expect(result.cooled).toBe(0);
  expect(result.reset).toBe(0);
  expect(result.allCooledHalf).toBe(true);
  expect(result.hasGlyphWake).toBe(true);
  expect(result.rippleHistoryEqual).toBe(true);
  expect(result.rippleChangesGlyphs).toBe(true);
  expect(result.regularRetained).toBe(0);
  expect(result.resetReproducible).toBe(true);
  expect(result.coreCount).toBeGreaterThan(10);
  expect(result.coreCount).toBeLessThan(30);
  expect(result.circleMatches).toBe(true);
  expect(result.opaqueBothThemes).toBe(true);
  expect(result.coreWake.initial).toBe(255);
  expect(result.coreWake.moved).toBe(255);
  expect(result.coreWake.fading).toBeLessThan(result.coreWake.moved);
  expect(result.coreWake.cooled).toBe(102);
  expect(result.proximity.moved).toBeCloseTo(0.992,3);
  expect(result.proximity.fading).toBeCloseTo(0.692,3);
  expect(result.proximity.cooled).toBe(0);
  expect(result.proximity.reset).toBe(0);
  expect(result.noSeparateCoreHistory).toBe(true);
  expect(result.noLingeringOpacity).toBe(true);
  expect(result.hidden).toBe(true);
  expect(result.halfCore).toBe(true);
  expect(result.labelsUnchanged).toBe(true);
  expect(result.overlapPreservesCore).toBe(true);
  expect(result.secondCoreOwner).toBe(1);
  expect(result.zoomIndependent).toBe(true);
  expect(result.regularOpaque).toBe(false);
});

test('the real orb renderer retains its opacity history through resize and graphics-context restoration', async ({ page }, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expose(page);
  await page.evaluate(() => {
    const get = (window as any).opacityExport;
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999' });
    document.body.append(host);
    const root = get('createRoot')(host);
    (window as any).orbTestRoot = root;
    root.render(get('createElement')(get('ProjectRestorationScreen'), {}));
  });
  const enabled = () => page.evaluate(() => {
    const canvas = document.querySelector('.project-restoration-canvas canvas') as HTMLCanvasElement;
    const gl = canvas?.getContext('webgl2');
    if (!gl || gl.isContextLost()) return false;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const location = program ? gl.getUniformLocation(program, 'uPointOpacityTrails') : null;
    return location !== null && gl.getUniform(program, location) === true;
  });
  const ink = (mode: 'total' | 'opaque' = 'total') => page.evaluate(async mode => {
    const canvas = document.querySelector('.project-restoration-canvas canvas') as HTMLCanvasElement;
    const capture = (window as any).opacityExport('screenshotRenderer')(canvas);
    const img = new Image(); img.src = await capture(1); await img.decode();
    const copy = document.createElement('canvas'); copy.width = img.width; copy.height = img.height;
    const ctx = copy.getContext('2d')!; ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let sum = 0, opaque = 0;
    for (let i=3; i<pixels.length; i+=4) { sum += pixels[i]!; if(pixels[i]===255) opaque++; }
    const gl = canvas.getContext('webgl2')!;
    if (gl.getError() !== gl.NO_ERROR) throw new Error('The orb renderer reported a GPU error');
    return mode === 'opaque' ? opaque : sum;
  }, mode);
  await expect.poll(enabled).toBe(true);
  await expect.poll(ink).toBeGreaterThan(0);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => (window as any).opacityExport('applyThemePreference')(theme), theme);
    await expect.poll(() => ink('opaque')).toBeGreaterThan(100);
    await page.waitForTimeout(500);
    await page.screenshot({ path: info.outputPath(`orbs-opacity-wake-${theme}.png`) });
  }
  // A restoration failure stops the orbit and its recoloring timer. The old
  // dense glyphs must still finish cooling, rather than freezing when the renderer idles.
  await page.evaluate(() => {
    const get = (window as any).opacityExport;
    (window as any).orbTestRoot.render(get('createElement')(get('ProjectRestorationScreen'), {
      error: new Error('Synthetic restoration failure'),
    }));
  });
  const fadingCells = () => page.evaluate(() => {
    const canvas = document.querySelector('.project-restoration-canvas canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const p = gl.getParameter(gl.CURRENT_PROGRAM);
    const historyLocation = gl.getUniformLocation(p, 'uOpacityHistory');
    const sizeLocation = gl.getUniformLocation(p, 'uCellsMax');
    if (!historyLocation || !sizeLocation) throw new Error('Orb composite uniforms are missing');
    const unit = gl.getUniform(p, historyLocation);
    const max = gl.getUniform(p, sizeLocation) as Int32Array;
    const active = gl.getParameter(gl.ACTIVE_TEXTURE), prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.activeTexture(gl.TEXTURE0 + unit);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixels = new Uint8Array((max[0]!+1)*(max[1]!+1)*4);
    gl.readPixels(0,0,max[0]!+1,max[1]!+1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER,prev); gl.deleteFramebuffer(framebuffer); gl.activeTexture(active);
    const pitch = gl.getUniform(p, gl.getUniformLocation(p, 'uCellCssPx')!);
    let fading=0;
    for(let y=0;y<=max[1]!;y++) for(let x=0;x<=max[0]!;x++) {
      const i=(y*(max[0]!+1)+x)*4;
      if (pixels[i+2]!==0||pixels[i+3]!==255) throw new Error('Unexpected separate core history');
      const proximity=(pixels[i]!+pixels[i+1]!/255)/8;
      const dx=(x+0.5)*pitch-canvas.clientWidth/2, dy=(y+0.5)*pitch-canvas.clientHeight/2;
      const distance=Math.min(Math.hypot(dx,dy-150),Math.hypot(dx,dy+150));
      if((1-proximity)*225<=24 && distance>24.2) fading++;
    }
    return fading;
  });
  await expect.poll(fadingCells).toBeGreaterThan(0);
  await expect.poll(fadingCells, { timeout: 5_000 }).toBe(0);
  await page.setViewportSize({ width: 1320, height: 900 });
  await expect.poll(ink).toBeGreaterThan(0);
  await page.evaluate(() => new Promise<void>(resolve => {
    const canvas = document.querySelector('.project-restoration-canvas canvas') as HTMLCanvasElement;
    const extension = canvas.getContext('webgl2')!.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context-loss extension is required for this test');
    (window as any).orbContextLoss = extension;
    canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
    extension.loseContext();
  }));
  await expect.poll(() => page.evaluate(() => (document.querySelector('.project-restoration-canvas canvas') as HTMLCanvasElement)
    .getContext('webgl2')!.isContextLost())).toBe(true);
  await page.evaluate(() => (window as any).orbContextLoss.restoreContext());
  await expect.poll(enabled).toBe(true);
  await expect.poll(ink).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).orbTestRoot.unmount());
  expect(errors).toEqual([]);
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

test('the GPU shader uses only 5% full and 95% half opacity near nodes and orbs, halves ambient dots and preserves labels', async ({ page }) => {
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
      let innerFull=0, outerFull=0;
      for (let row=0; row<512; row++) for (let col=0; col<512; col++) {
        const d = Math.hypot(Math.max(x-col-0.5,0,col+0.5-x-width),Math.max(y-row-0.5,0,row+0.5-y-height));
        if (d <= 0 || d >= radius) continue;
        const perimeter = 2 * (width + height);
        const area = (perimeter*d + Math.PI*d*d) / (perimeter*radius + Math.PI*radius*radius);
        const a = pixels[((511-row)*512+col)*4+3]!;
        counts[a] = (counts[a] ?? 0) + 1;
        if (area < 0.25) {
          innerSum+=a; innerCount++;
          if (a === 204) innerFull++;
        }
        if (area > 0.75) { outerSum+=a; outerCount++; if (a === 204) outerFull++; }
      }
      output.push({name,counts,inner:innerSum/innerCount,outer:outerSum/outerCount,
        innerFullShare:innerFull/counts[204]!,outerFullShare:outerFull/outerCount,
        stable:pixels.every((a,i)=>a===first[i])});
    }
    // No winner and stage zero: ambient dots are all half opacity, not a
    // lottery. Labels over the same cells must still bypass that reduction.
    for (let i=0; i<state.length; i+=4) state[i+2]=255;
    texture(0,'uCellState',512,512,state);
    gl.drawArrays(gl.TRIANGLES,0,3);
    const ambient = new Uint8Array(state.length);
    gl.readPixels(0,0,512,512,gl.RGBA,gl.UNSIGNED_BYTE,ambient);
    for(let i=3;i<ambient.length;i+=4) {
      if(ambient[i]!==102) throw new Error(`Ambient dot is not half opacity: ${ambient[i]}`);
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
    expect(Object.keys(result.counts).map(Number).sort((a,b)=>a-b)).toEqual([102,204]);
    const total = Object.values(result.counts).reduce((a,b)=>a+b,0);
    expect(result.counts[102]!/total).toBeCloseTo(0.95,2);
    expect(result.counts[204]!/total).toBeCloseTo(0.05,2);
    expect(result.inner).toBeGreaterThan(result.outer + 18);
    expect(result.innerFullShare).toBeGreaterThan(0.93);
    expect(result.outerFullShare).toBeLessThan(0.001);
    expect(result.stable).toBe(true);
  }
});
