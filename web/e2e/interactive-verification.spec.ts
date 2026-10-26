import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import JSZip from 'jszip';

test('saved failed program captures both themes and its planned interaction states', async ({ page }, info) => {
  test.skip(!process.env.SCATTER_CAPTURE_PROJECT, 'Optional local project; never commit a project export.');
  test.setTimeout(120_000);
  const zip = await JSZip.loadAsync(await readFile(process.env.SCATTER_CAPTURE_PROJECT!));
  const data = JSON.parse(await zip.file('project.json')!.async('text'));
  const project = data.project ?? data;
  const versions = Object.values(project.nodes).flatMap((node: any) => node.versions);
  const version: any = versions.filter((v: any) => v.interactiveBuild?.error?.includes('Alternate-theme')).at(-1);
  expect(version).toBeTruthy();
  await page.goto('/sandbox'); await page.locator('[data-node-id]').first().waitFor();
  const results = await page.evaluate(async (build: any) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`saved-capture-${Date.now()}`], {}, (require: any) => {
      win.savedCaptureExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(name);
      };
    }]);
    const get = win.savedCaptureExport, results = [];
    const theme = { ...get('DEFAULT_INTERACTIVE_HOST_STATE').theme, mode: 'dark', background: '#171717', text: '#eee', primary: '#23bec9' };
    for (const alternateTheme of [false, true]) results.push(await get('checkInteractiveDocument')(build.draftHtml, theme,
      new AbortController().signal, [], { screenshot: true, alternateTheme }));
    return results;
  }, version.interactiveBuild);
  for (const [index, result] of results.entries()) {
    expect(result.captureError, JSON.stringify({ errors: result.errors, captureError: result.captureError, viewport: result.viewport })).toBeUndefined();
    expect(result.screenshot).toBeTruthy();
    await writeFile(info.outputPath(`saved-program-${index}.png`), Buffer.from(result.screenshot.split(',')[1], 'base64'));
  }
});

test('accepts a detailed large screenshot in both themes', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  const results = await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`large-capture-${Date.now()}`], {}, (require: any) => {
      win.largeCaptureExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(name);
      };
    }]);
    const get = win.largeCaptureExport;
    const html = `<!doctype html><html><head><meta name="scatter-viewport" content="width=1600,height=1600">
      <style>body{margin:0;background:var(--sc-bg);color:var(--sc-text)}canvas{display:block;outline-color:var(--sc-primary)}</style></head><body>
      <canvas width="1600" height="1600"></canvas><script>
      const c=document.querySelector('canvas').getContext('2d'), image=c.createImageData(1600,1600);
      let n=123456;for(let i=0;i<image.data.length;i+=4){for(let k=0;k<3;k++){n=(Math.imul(n,1664525)+1013904223)>>>0;image.data[i+k]=n>>>24;}image.data[i+3]=255;}c.putImageData(image,0,0);
      </script></body></html>`;
    const results = [];
    for (const alternateTheme of [false, true]) {
      const result = await get('checkInteractiveDocument')(html, get('DEFAULT_INTERACTIVE_HOST_STATE').theme,
        new AbortController().signal, [], { screenshot: true, alternateTheme });
      const image = new Image();
      if (result.screenshot) { image.src = result.screenshot; await image.decode(); }
      results.push({ ok: result.ok, errors: result.errors, captureError: result.captureError, length: result.screenshot?.length,
        format: result.screenshot?.slice(0, 23), width: image.naturalWidth, height: image.naturalHeight });
    }
    return results;
  });
  for (const result of results) {
    expect(result.captureError, JSON.stringify(result)).toBeUndefined();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.length).toBeGreaterThan(1000);
    expect(result.length).toBeLessThan(5_000_000);
    expect(result.format).toBe('data:image/jpeg;base64,');
    expect([result.width, result.height]).toEqual([1600, 1600]);
  }
});

test('adapts portrait and overflowing layouts without treating decorative clipping as fatal', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  const results = await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`layout-${Date.now()}`], {}, (require: any) => {
      win.layoutExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(name);
      };
    }]);
    const get = win.layoutExport;
    const build = (width: number, height: number, contentWidth: number) => `<!doctype html><html><head><meta name="scatter-viewport" content="width=${width},height=${height}"><style>body{background:var(--sc-bg);color:var(--sc-text);font:20px Arial}.content{width:${contentWidth}px;padding:30px}.clip{width:150px;height:30px;overflow:hidden;background:var(--sc-primary)}.decoration{width:200px;height:40px;background:var(--sc-primary)}</style></head><body><section class="content"><h1>Flexible layout</h1><p>日本語。 العربية हिन्दी</p><div class="clip"><div class="decoration"></div></div><button id="action">Working control</button></section></body></html>`;
    const check = get('checkInteractiveDocument'); const theme = get('DEFAULT_INTERACTIVE_HOST_STATE').theme;
    const results = [];
    for (const input of [[720, 960, 720], [840, 840, 840], [960, 720, 1130]] as const) results.push(await check(build(input[0], input[1], input[2]), theme, new AbortController().signal, [], { screenshot: true }));
    results.push(await check(build(960, 720, 2000), theme, new AbortController().signal));
    return results;
  });
  expect(results[0].viewport).toEqual({ width: 720, height: 960 });
  expect(results[1].viewport).toEqual({ width: 840, height: 840 });
  expect(results[2].viewport.width).toBeGreaterThanOrEqual(1130);
  for (const [index, result] of results.slice(0, 3).entries()) {
    expect(result.errors).toEqual([]); expect(result.ok).toBe(true);
    expect(result.layoutNotes?.join(' ')).toContain('intentional decoration');
    await writeFile(info.outputPath(`adaptive-${index}.png`), Buffer.from(result.screenshot.split(',')[1], 'base64'));
  }
  expect(results[3].ok).toBe(false);
  expect(results[3].errors.join(' ')).toContain('1600');
});

test('screenshot verification preserves live checkbox and radio states', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  const results = await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`interactive-controls-${Date.now()}`], {}, (require: any) => {
      win.interactiveTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.interactiveTestExport;
    const html = `<!doctype html><html><head><style>
      body{margin:0;background:var(--sc-bg);color:var(--sc-text);font:20px sans-serif}
      input{position:absolute;left:40px;top:60px;width:28px;height:28px;margin:0;accent-color:var(--sc-primary)}
      #radio{top:120px}label{position:absolute;left:80px;top:60px}label[for=radio]{top:120px}
      </style></head><body><input type="checkbox" id="seed"><label for="seed">Seed online</label>
      <input type="radio" id="radio" checked><label for="radio">Radio state</label>
      <script>document.querySelector('#seed').checked=true;document.querySelector('#radio').checked=false;</script></body></html>`;
    const light = get('DEFAULT_INTERACTIVE_HOST_STATE').theme;
    const theme = { ...light, mode: 'dark', background: '#171717', text: '#eee', primary: '#a4c5b8' };
    const results = [];
    for (const colors of [light, theme]) for (const clicked of [false, true]) results.push(await get('checkInteractiveDocument')(html, colors, new AbortController().signal,
      clicked ? [{ selector: '#seed', action: 'click' }, { selector: '#radio', action: 'click' }] : [], {
        assertions: [{ selector: '#seed', property: 'checked', operator: 'equals', expected: !clicked },
          { selector: '#radio', property: 'checked', operator: 'equals', expected: clicked }], screenshot: true,
      }));
    const frame = document.createElement('iframe'); frame.id = 'native-controls'; frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:720px;border:0;z-index:2147483647';
    frame.srcdoc = get('buildInteractiveSrcDoc')(html, 'native-controls', { active: true, theme }); document.body.appendChild(frame);
    return results;
  });
  await expect(page.frameLocator('#native-controls').locator('#seed')).toBeChecked();
  await page.locator('#native-controls').screenshot({ path: info.outputPath('native-controls.png') });
  const crops: Buffer[] = [], radios: Buffer[] = [];
  for (const [index, result] of results.entries()) {
    expect(result.ok).toBe(true);
    expect(result.controls).toContainEqual(expect.objectContaining({ selector: '#seed', checked: index % 2 === 0, label: 'Seed online' }));
    expect(result.controls).toContainEqual(expect.objectContaining({ selector: '#radio', checked: index % 2 === 1 }));
    const bytes = Buffer.from(result.screenshot.split(',')[1], 'base64');
    await writeFile(info.outputPath(`captured-controls-${index < 2 ? 'light' : 'dark'}-${index % 2 ? 'off' : 'on'}.png`), bytes);
    crops.push(await sharp(bytes).extract({ left: 40, top: 60, width: 28, height: 28 }).raw().toBuffer());
    radios.push(await sharp(bytes).extract({ left: 40, top: 120, width: 28, height: 28 }).raw().toBuffer());
  }
  // A checked property set by JavaScript must survive SVG serialization. The
  // old capture produced identical unchecked pixels in both states.
  for (const start of [0, 2]) {
    expect(crops[start]!.equals(crops[start + 1]!)).toBe(false);
    expect(radios[start]!.equals(radios[start + 1]!)).toBe(false);
  }
});

test('isolated verifier checks outcomes and captures real canvas, SVG and text states', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  const results = await page.evaluate(async () => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`interactive-check-${Date.now()}`], {}, (require: any) => {
      win.interactiveTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.interactiveTestExport;
    const html = `<!doctype html><html><head><title>Visual counter</title><style>
      *{box-sizing:border-box}body{margin:0;padding:30px;background:var(--sc-bg);color:var(--sc-text);font:18px sans-serif}
      button{background:var(--sc-primary);color:var(--sc-bg);padding:12px;border:0;border-radius:6px;margin-right:12px}
      svg,canvas{display:inline-block;margin:16px;border:1px solid var(--sc-border)}
      </style></head><body><h1>Visual verification</h1><p>日本語 · العربية · हिन्दी · Zażółć gęślą jaźń</p>
      <p>Count: <output id="count">0</output></p><button id="add">Add one</button><button id="reset">Reset</button><br>
      <svg width="220" height="180"><circle cx="110" cy="90" r="60" fill="#e94545"/></svg>
      <canvas id="plot" width="220" height="180"></canvas><script>
      var n=0;document.getElementById('add').onclick=function(){document.getElementById('count').textContent=String(++n)};
      document.getElementById('reset').onclick=function(){n=0;document.getElementById('count').textContent='0'};
      var ctx=document.getElementById('plot').getContext('2d');ctx.fillStyle='#1675e0';ctx.fillRect(40,30,140,120);
      </script></body></html>`;
    const check = get('checkInteractiveDocument');
    const light = get('DEFAULT_INTERACTIVE_HOST_STATE').theme;
    const dark = { ...light, mode: 'dark', background: '#171717', text: '#eee', border: '#666', primary: '#a4c5b8' };
    const assertion = { selector: '#count', property: 'text', operator: 'equals', expected: '1' };
    const images = [];
    for (const theme of [light, dark]) images.push(await check(html, theme, new AbortController().signal,
      [{ selector: '#add', action: 'click' }], { assertions: [assertion], screenshot: true }));
    const originalTheme = document.documentElement.dataset.theme;
    images.push(await check(html, dark, new AbortController().signal,
      [{ selector: '#add', action: 'click' }], { assertions: [assertion], screenshot: true, alternateTheme: true }));
    const noop = html.replace("document.getElementById('count').textContent=String(++n)", 'n++');
    const failure = await check(noop, light, new AbortController().signal, [{ selector: '#add', action: 'click' }], { assertions: [assertion] });
    return { images, failure, originalTheme, currentTheme: document.documentElement.dataset.theme,
      leakedFrames: document.querySelectorAll('iframe[title="Checking interactive program"]').length };
  });
  expect(results.failure.ok).toBe(false);
  expect(results.failure.errors.join(' ')).toContain('observed "0"');
  expect(results.leakedFrames).toBe(0);
  expect(results.currentTheme).toBe(results.originalTheme);
  expect(results.images[2].themeMode).toBe('light');
  for (const [index, result] of results.images.entries()) {
    expect(result.errors).toEqual([]);
    expect(result.captureError).toBeUndefined();
    expect(result.screenshot).toMatch(/^data:image\/png;base64,/);
    await writeFile(info.outputPath(`interactive-capture-${['light', 'dark', 'alternate'][index]}.png`), Buffer.from(result.screenshot.split(',')[1], 'base64'));
  }
});
