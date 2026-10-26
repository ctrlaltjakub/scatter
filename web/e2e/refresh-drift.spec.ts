import { test, expect, type Page } from '@playwright/test';

/**
 * Refresh-stability guard. Reloading a persisted project must NOT
 * move settled nodes (R5: a no-op physics-config push re-energized
 * the sim) AND must NOT resize them (R6: font-swap re-measure +
 * physics size-kick + animated body-height correction = a visible
 * "expand and contract" plus a nudge on every reload).
 */

async function clearOpfs(page: Page) {
  await page.addInitScript(() => {
    // Only wipe ONCE per tab — sessionStorage survives reloads
    // (a window-object flag would not).
    if (sessionStorage.getItem('__opfsWiped')) return;
    sessionStorage.setItem('__opfsWiped', '1');
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
}

async function mockApi(page: Page) {
  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ data: [{ id: 'mock-model' }] }),
    });
  });
  // Bullet-rich bodies so the AdaptiveBullets measurement pipeline
  // (labs, min-size commit, cascade) runs — the height-stability
  // assertion has to exercise it, not just plain paragraphs.
  const rootBody =
    'Fermentation overview with [[Pasteur]] context across several pathways and uses.\\n\\n'
    + '- **Lactic pathway** glucose converts under anaerobic conditions into lactic acid which accumulates in muscle tissue during exertion\\n'
    + '- **Alcoholic pathway** yeast converts sugars to ethanol with carbon dioxide as a byproduct that drives bread rise\\n'
    + '- **Industrial use** dairy cultures, sourdough starters, and brewing all depend on controlled fermentation conditions\\n';
  const childBody =
    'Pasteur was a French chemist and microbiologist renowned for germ theory and vaccination breakthroughs.\\n\\n'
    + '- **Germ theory** microorganisms cause disease and spoilage rather than spontaneous generation from inert matter\\n'
    + '- **Pasteurization** gentle heating kills pathogens in milk and wine without ruining flavor or nutrition\\n';
  let calls = 0;
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    calls += 1;
    const content = calls === 1 ? rootBody : childBody;
    await route.fulfill({
      status: 200, contentType: 'text/event-stream',
      body: `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\ndata: [DONE]\n\n`,
    });
  });
}

/** Per-node screen position (DOM transform) + offsetHeight, keyed by a
 *  stable slice of the node's text. */
async function nodeMetrics(page: Page): Promise<Record<string, { x: number; y: number; h: number }>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; h: number }> = {};
    for (const el of Array.from(document.querySelectorAll('.node'))) {
      const key = (el.textContent ?? '?').replace(/\s+/g, ' ').trim().slice(0, 24);
      const t = new DOMMatrixReadOnly(getComputedStyle(el as HTMLElement).transform);
      out[key] = { x: t.e, y: t.f, h: (el as HTMLElement).offsetHeight };
    }
    return out;
  });
}

test('reload moves no node and resizes no node', async ({ page }) => {
  await clearOpfs(page);
  await mockApi(page);

  await page.goto('/');
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill('fermentation');
  await page.getByRole('button', { name: 'Submit topic' }).click();
  await expect(page.getByRole('button', { name: 'Pasteur' })).toBeVisible();
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Pasteur');
    btn?.click();
  });
  await expect(page.getByText(/germ theory/i).first()).toBeVisible();

  // Let streaming + physics fully settle FIRST, so the drag below
  // commits truly-final positions. (A freshly spawned child keeps
  // micro-settling for a couple seconds; dragging before it stops
  // would let the settle-flush persist a mid-settle position, which
  // then re-settles a few px on the next load — the pre-existing
  // streaming quirk, not the reload bug under test.)
  await page.waitForTimeout(5000);

  // Drag a node slightly — the drag-end commit + the 1.5 s settle
  // flush fold ALL live positions (every node, not just the dragged
  // one) into the project, exactly like any real session.
  const node = page.locator('.node').first();
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 25, box.y + 10, { steps: 5 });
  await page.mouse.up();

  await page.waitForTimeout(3500); // physics + settle-flush + autosave quiesce
  const before = await nodeMetrics(page);

  const driftReport: string[] = [];
  let maxPosDrift = 0;
  let maxHeightDrift = 0;

  for (let reload = 1; reload <= 2; reload++) {
    await page.reload();
    await expect(page.getByText(/germ theory/i).first()).toBeVisible();
    await page.waitForTimeout(3500);
    const after = await nodeMetrics(page);
    for (const key of Object.keys(before)) {
      const b = before[key]!;
      const a = after[key];
      if (!a) continue;
      const pos = Math.hypot(a.x - b.x, a.y - b.y);
      const dh = Math.abs(a.h - b.h);
      maxPosDrift = Math.max(maxPosDrift, pos);
      maxHeightDrift = Math.max(maxHeightDrift, dh);
      driftReport.push(`r${reload} ${key.slice(0, 16)}: pos=${pos.toFixed(2)}px h=${b.h}→${a.h} (Δ${dh})`);
    }
  }
  // eslint-disable-next-line no-console
  console.log('[refresh-drift]\n  ' + driftReport.join('\n  '));

  // Settled nodes must not visibly move or resize on reload.
  expect(maxPosDrift).toBeLessThan(1);
  expect(maxHeightDrift).toBeLessThan(2);
});
