import { test, expect, type Page } from '@playwright/test';

/* Regression: dragging the camera WHILE a node's text streams in must not make
 * the camera flicker (jump between two positions every frame).
 *
 * Root cause this guards against: every streamed chunk re-mints `project`,
 * which re-runs the [project] effect whose tail reseeded the live camera from
 * the (stale, pre-drag) `project.viewport`. Mid-drag, live (the drag) and
 * project.viewport legitimately differ, so the reseed yanked the camera back —
 * the user's drag pushed one way, each chunk snapped it back = flicker.
 *
 * We reproduce it by streaming SSE chunks over REAL time (the other e2e specs
 * deliver the whole body in one event, so a drag can't overlap it) and sampling
 * the world-transform every animation frame during a strictly-leftward drag.
 * The camera x should decrease monotonically (smooth pan). Any "reversal"
 * (x jumps back up) between consecutive frames is the flicker. */

async function onboardAndSubmitTopic(page: Page, topic: string) {
  await expect(page.getByLabel('API key')).toBeVisible();
  await page.getByLabel('API key').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  // Step 2: tick the (mock) model so "Finish setup" enables.
  await page.getByRole('button', { name: /mock-model/ }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('camera does not flicker when drag-panning during streaming', async ({ page }) => {
  await page.addInitScript(() => {
    // Fresh OPFS so onboarding shows (mirrors the other specs).
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });

    // Override fetch so /chat/completions streams over real time (≈4 s),
    // /models returns a single mock model, everything else passes through.
    const realFetch = window.fetch.bind(window);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).fetch = (input: any, init: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (url.includes('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'mock-model' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('/chat/completions')) {
        const enc = new TextEncoder();
        const words = (
          'Streaming body about cellular metabolism and energy production. ' +
          'Glycolysis breaks down glucose into pyruvate over several enzymatic steps. ' +
          'The Krebs cycle then oxidizes acetyl groups releasing carbon dioxide. ' +
          'Finally the electron transport chain pumps protons to make ATP overall.'
        ).split(' ');
        let i = 0;
        const stream = new ReadableStream({
          start(controller) {
            const push = () => {
              if (i < words.length) {
                const delta = (i === 0 ? '' : ' ') + words[i];
                const evt = `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;
                controller.enqueue(enc.encode(evt));
                i++;
                setTimeout(push, 90);
              } else {
                controller.enqueue(enc.encode('data: [DONE]\n\n'));
                controller.close();
              }
            };
            setTimeout(push, 90);
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        );
      }
      return realFetch(input, init);
    };
  });

  await page.goto('/');
  await onboardAndSubmitTopic(page, 'cells');

  // Root node appears and is streaming.
  const card = page.locator('[data-node-id]').first();
  await card.waitFor({ timeout: 15000 });

  // Install a per-frame sampler of the world-transform translateX. The
  // CameraTransform wrapper is the only ancestor of a node card whose inline
  // transform contains scale() (node wrappers translate but never scale).
  await page.evaluate(() => {
    const camX = (): number => {
      let el: Element | null = document.querySelector('[data-node-id]');
      while (el) {
        const t = (el as HTMLElement).style?.transform ?? '';
        if (t.includes('scale(')) {
          const m = /translate\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px\s*\)/.exec(t);
          if (m && m[1]) return parseFloat(m[1]);
        }
        el = el.parentElement;
      }
      return NaN;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__cam = [];
    w.__camX = camX;
    w.__sampling = false; // started after the drag's first move (below)
    const tick = () => {
      if (w.__sampling) {
        const x = camX();
        if (!Number.isNaN(x)) w.__cam.push(x);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const bodyLen = () =>
    page.evaluate(() => {
      const b = document.querySelector('[data-node-id] .node-body') as HTMLElement | null;
      return b?.innerText.length ?? 0;
    });
  const lenBefore = await bodyLen();

  // Drag-pan strictly leftward, pressing on a guaranteed-empty spot BELOW the
  // node card (it's large at this zoom). Pointer capture keeps the whole drag
  // on the canvas host even as it later passes over the node.
  const host = await page.locator('.canvas-host').boundingBox();
  const nodeBox = await card.boundingBox();
  if (!host || !nodeBox) throw new Error('missing layout boxes');
  const downX = Math.round(host.x + host.width - 80);
  const downY = Math.round(Math.min(nodeBox.y + nodeBox.height + 60, host.y + host.height - 20));
  const totalLeft = 360;
  const steps = 24;

  await page.mouse.move(downX, downY);
  await page.mouse.down();
  await page.mouse.move(downX - 12, downY); // first move claims the pan, cancels any tween
  await page.evaluate(() => { (window as any).__sampling = true; });
  for (let k = 1; k <= steps; k++) {
    const x = downX - 12 - Math.round(((totalLeft - 12) * k) / steps);
    await page.mouse.move(x, downY);
    await page.waitForTimeout(42); // ~1 s total drag; chunks arrive every 90 ms
  }
  await page.evaluate(() => { (window as any).__sampling = false; });
  await page.mouse.up();

  const lenAfter = await bodyLen();

  const stats = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xs: number[] = (window as any).__cam;
    let reversals = 0;
    for (let i = 1; i < xs.length; i++) {
      const cur = xs[i] ?? 0;
      const prev = xs[i - 1] ?? 0;
      if (cur > prev + 3) reversals++; // x jumped back up during a leftward drag = flicker
    }
    return {
      n: xs.length,
      min: Math.min(...xs),
      max: Math.max(...xs),
      reversals,
    };
  });

  // The stream was genuinely active during the drag (so this test is meaningful).
  expect(lenAfter, 'node body grew while dragging (chunks were streaming)').toBeGreaterThan(
    lenBefore,
  );
  // We captured frames and the drag did reach a meaningfully-left position at
  // some point (robust to the bug, which resets the camera back to ~0).
  expect(stats.n, 'captured camera samples').toBeGreaterThan(10);
  expect(stats.min, 'drag moved the camera meaningfully left').toBeLessThan(-100);
  // THE flicker check: a strictly-leftward drag must never jump back up. Pre-fix
  // the per-chunk seedFrom snaps the camera toward the stale viewport (~0) on
  // every chunk → many reversals. Post-fix → none.
  expect(stats.reversals, 'camera jumps back (flicker) during streaming drag').toBeLessThanOrEqual(
    2,
  );
});
