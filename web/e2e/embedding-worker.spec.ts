import { expect, test } from '@playwright/test';

// Opt-in because this downloads the public quantized model. No provider key or
// paid inference is involved. Run against the webpack dev server in both engines.
test.skip(process.env.SCATTER_EMBEDDING_SMOKE !== '1', 'Enable the public-model download explicitly.');
test('browser embedding worker returns normalized multilingual vectors', async ({ page }) => {
  test.setTimeout(240_000);
  await page.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return ['localhost', '127.0.0.1', 'huggingface.co', 'cdn.jsdelivr.net'].includes(host) || host.endsWith('.hf.co')
      ? route.continue() : route.abort();
  });
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  const result = await page.evaluate(async () => {
    const win = window as any;
    let embed: ((texts: string[]) => Promise<Float32Array>) | undefined;
    win.webpackChunk_N_E.push([[`embedding-smoke-${Date.now()}`], {}, (require: any) => {
      for (const entry of Object.values(require.c) as any[]) {
        if (entry.exports?.embedSourceTexts) { embed = entry.exports.embedSourceTexts; break; }
      }
    }]);
    if (!embed) throw new Error('Browser embedding module was not loaded.');
    const values = await embed(['The library contains books.', 'Résumé العربية 日本語 हिंदी']);
    const norms = [0, 384].map(start => Math.sqrt(values.slice(start, start + 384).reduce((sum, value) => sum + value * value, 0)));
    return { length: values.length, finite: Array.from(values).every(Number.isFinite), norms };
  });
  expect(result.length).toBe(768);
  expect(result.finite).toBe(true);
  for (const norm of result.norms) expect(norm).toBeCloseTo(1, 3);
});
