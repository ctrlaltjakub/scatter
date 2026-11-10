import { expect, test } from '@playwright/test';
import { LANGUAGES } from '../src/lib/languages';

test('language samples produce distinct ink and reach the actual WebGL label overlay', async ({page}, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({width: 1360, height: 900});
  // Keep all data local; this is a rendering test, not model generation.
  await page.route(/^https?:\/\//, route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox', {waitUntil: 'domcontentloaded'});
  await expect(page.locator('[data-node-id]').first()).toBeVisible({timeout: 45_000});
  const samples = LANGUAGES.map(l => l.sample.toUpperCase());
  const visible = await page.evaluate(async samples => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`label-test-${Date.now()}`], {}, (require: any) => {
      win.labelExport = (name: string) => Object.values(require.c).map((m: any) => m.exports?.[name]).find(Boolean);
    }]);
    const get = win.labelExport;
    const font = get('labelFont'), paint = get('paintLabelRun'), line = get('labelLine');
    const faces = new Set<string>(), masks = new Set<string>();
    for (const sample of samples) {
      const family = font(sample);
      await document.fonts.load(family, sample);
      const sheet = paint(sample, line(sample).width) as HTMLCanvasElement;
      const ctx = sheet.getContext('2d')!;
      if (!ctx.getImageData(0, 0, sheet.width, sheet.height).data.some((v, i) => i % 4 === 3 && v > 0)) throw Error('Blank: '+ sample);
      masks.add(sheet.toDataURL()); faces.add(family);
    }
    // Distinguish real glyphs from identical missing-character boxes.
    for (const [a,b] of [['Ж','Ю'],['語','字'],['한','말'],['ش','ك'],['ज्ञ','क्ष'],['Ế','Ằ']]) {
      await Promise.all([a,b].map(t => document.fonts.load(font(t),t)));
      if (paint(a,1).toDataURL() === paint(b,1).toDataURL()) throw Error('Indistinguishable: '+a+b);
    }
    const node = [...document.querySelectorAll<HTMLElement>('[data-node-id]')].find(el => {
      const r = el.getBoundingClientRect(); return r.x >= 0 && r.x < innerWidth - 80 && r.y > 70 && r.y < innerHeight - 70;
    });
    if (!node) throw Error('No visible sandbox node');
    get('useNodeStatusStore').getState().setStatus(node.dataset.nodeId!, 'موسيقى ۱۲۳ AI · राग · 音楽 · ŁÓDŹ');
    return {samples: masks.size, faces: faces.size};
  }, samples);
  expect(visible.samples).toBe(samples.length); expect(visible.faces).toBeGreaterThan(4);
  // Read the final cell texture after type-on, not just the measured DOM font.
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.canvas-host > canvas')!;
    const gl = canvas.getContext('webgl2')!;
    const capture = (window as any).labelExport('screenshotRenderer')(canvas);
    if (!capture || !gl) return 0;
    capture(1);
    const prog = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
    const unit = gl.getUniform(prog, gl.getUniformLocation(prog, 'uOverlay')!);
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const pitch = gl.getUniform(prog, gl.getUniformLocation(prog, 'uDeviceCellPx')!);
    const w = Math.ceil(canvas.width / pitch), h = Math.ceil(canvas.height / pitch);
    const pixels = new Uint8Array(w*h*4), fbo = gl.createFramebuffer();
    try {
      gl.activeTexture(gl.TEXTURE0+unit); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gl.getParameter(gl.TEXTURE_BINDING_2D), 0);
      gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER,prev); gl.deleteFramebuffer(fbo); gl.activeTexture(active);
    }
    return pixels.filter((v,i) => i%4 === 1 && v >= 128).length;
  }), {timeout: 15_000}).toBeGreaterThan(8);
  await page.screenshot({path: info.outputPath('multilingual-canvas.png')});
  await page.evaluate(async samples => {
    const get = (window as any).labelExport;
    const panel = document.createElement('div');
    panel.id = 'language-proof';
    panel.style.cssText = 'position:fixed;inset:0;z-index:99999;overflow:auto;background:#161616;color:white;padding:24px;font:14px sans-serif';
    for (const sample of samples) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-direction:column;margin-bottom:12px;gap:5px';
      const title = document.createElement('div'); title.textContent = sample;
      const strip = get('paintLabelRun')(sample, get('labelWidth')(sample)) as HTMLCanvasElement;
      strip.style.cssText = 'image-rendering:pixelated;width:'+strip.width+'px;height:16px';
      row.append(title, strip); panel.append(row);
    }
    document.body.append(panel);
  }, samples);
  await page.screenshot({path: info.outputPath('language-proof.png')});
});
