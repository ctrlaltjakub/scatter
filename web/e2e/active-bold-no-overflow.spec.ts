import { test, expect, type Page } from '@playwright/test';

// Content crafted so the LONGEST title sits near the wrap boundary at
// font-weight 500 (default). When the user clicks to activate, the title
// jumps to weight 600 (per `.sc-ab-item.is-active .sc-ab-title-text` in
// globals.css), which makes the glyphs slightly wider and can push the
// title to one extra line. The hidden M_max measurement list must
// account for this by carrying `is-active` itself — otherwise A_i
// under-measures and the bottom bullets get cut on activate.
//
// We use several different title lengths so at least one is likely to
// land in the bold-wrap-difference zone at the default 624 px node.
const BODY = `[[Cellular respiration]] is an [[energy-yielding metabolic pathway]] that breaks down [[glucose]] into [[carbon dioxide]] and [[water]], releasing usable chemical energy in the form of [[ATP]] for cellular work.

- [[Glycolysis is the cytoplasmic ten-step pathway that breaks one glucose into two pyruvate molecules with a small net ATP gain]]
    - [[Energy investment phase]]: two [[ATP]] phosphorylate [[glucose]] to prime the rearrangements
    - [[Energy payoff phase]]: substrate-level [[phosphorylation]] generates four [[ATP]] and two [[NADH]]
    - [[Pyruvate]]: end product transported into the [[mitochondrial matrix]] for further oxidation
    - [[Net yield]]: two [[ATP]] and two [[NADH]] per glucose under aerobic conditions
- [[Pyruvate oxidation links glycolysis to the citric acid cycle inside the mitochondrion]]
    - [[Decarboxylation]]: loss of [[CO2]] yields a two-carbon acetyl group bonded to coenzyme A
    - [[NADH generation]]: one [[NADH]] produced per pyruvate during the oxidation step
    - [[Acetyl-CoA]]: feeds directly into the [[citric acid cycle]] for further oxidation
- [[Citric acid cycle continues the oxidation in the mitochondrial matrix and generates electron carriers]]
    - [[Substrate-level phosphorylation]]: one [[GTP]] (or [[ATP]]) per acetyl group oxidized
    - [[Reduced carriers]]: three [[NADH]] and one [[FADH2]] generated per acetyl-CoA
    - [[Carbon dioxide release]]: two [[CO2]] per acetyl group oxidized to completion
- [[Oxidative phosphorylation uses the electron transport chain and chemiosmosis to make the bulk of cellular ATP]]
    - [[Electron transport]]: [[NADH]] and [[FADH2]] donate electrons to complexes embedded in the [[inner membrane]]
    - [[Proton pumping]]: complexes I, III, and IV pump [[H+]] across the membrane to create a gradient
    - [[ATP synthase]]: harnesses the [[proton motive force]] to phosphorylate [[ADP]] into [[ATP]]
    - [[Final electron acceptor]]: [[oxygen]] accepts electrons and combines with [[H+]] to form [[water]]`;

async function setup(page: Page) {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error entries
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });
  await page.route('https://api.openai.com/v1/models', async (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock-model' }] }) }));
  await page.route('https://api.openai.com/v1/chat/completions', async (r) =>
    r.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ choices: [{ delta: { content: BODY } }] })}\n\n` +
        `data: [DONE]\n\n`,
    }));
}

async function onboardAndSubmit(page: Page, topic: string) {
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (!body) return null;
    const items = Array.from(body.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item'));
    return {
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      isOverflowing: body.scrollHeight > body.clientHeight + 1,
      overflowAmount: Math.max(0, body.scrollHeight - body.clientHeight),
      minBodyHeight: Number(body.getAttribute('data-sc-min-body')) || null,
      activeIdx: items.findIndex((it) => it.classList.contains('is-active')),
      itemHeights: items.map((it) => Math.round(it.getBoundingClientRect().height)),
      // Sample the title font-weight to verify the active styling is applied.
      activeTitleWeight: (() => {
        const active = items.find((it) => it.classList.contains('is-active'));
        const title = active?.querySelector<HTMLElement>('.sc-ab-title-text');
        return title ? window.getComputedStyle(title).fontWeight : null;
      })(),
    };
  });
}

test('activating each bullet with long titles never overflows (bold-wrap regression)', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await onboardAndSubmit(page, 'cellular respiration');
  await expect(page.locator('.node-body[data-sc-mode="adaptive"]').first()).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);

  const initial = await snapshot(page);
  console.log('INITIAL', JSON.stringify(initial, null, 2));
  const bulletCount = initial?.itemHeights.length ?? 0;
  expect(bulletCount).toBeGreaterThan(0);

  // Shrink body to the floor first — that's the worst case where A
  // matters: any under-measurement of full_i immediately overflows.
  await page.evaluate((min) => {
    const body = document.querySelector('.node-body[data-sc-mode="adaptive"]') as HTMLElement | null;
    if (body && min) body.style.height = `${min}px`;
  }, initial?.minBodyHeight ?? null);
  await page.waitForTimeout(300);

  for (let i = 0; i < bulletCount; i++) {
    // Deactivate first.
    await page.evaluate(() => {
      const ft = document.querySelector<HTMLElement>(".sc-ab-root > .sc-ab-freetext");
      ft?.click();
    });
    await page.waitForTimeout(120);
    // Activate bullet i.
    await page.evaluate((idx) => {
      const item = document.querySelectorAll<HTMLElement>('.sc-ab-root > .sc-ab-list > .sc-ab-item')[idx];
      if (item) item.click();
    }, i);
    await page.waitForTimeout(250);
    const s = await snapshot(page);
    console.log(`AT FLOOR, activate bullet ${i}:`,
      `bodyH=${s?.bodyHeight} minH=${s?.minBodyHeight} active=${s?.activeIdx}`,
      `weight=${s?.activeTitleWeight} heights=[${s?.itemHeights.join(',')}]`,
      `overflow=${s?.overflowAmount}`);
    // With the safety margin, some bullets may already be at maxMode in
    // the cascade-fit state — clicking them is a no-op (handler returns
    // null to deactivate rather than re-activating an already-max
    // bullet). That's expected per handleBulletClick. Only verify the
    // overflow invariant; if activation actually took, verify bold too.
    if (s?.activeIdx === i) {
      expect(s?.activeTitleWeight, `active title must be bold (600)`).toBe('600');
    }
    expect(s?.isOverflowing, `bullet ${i} at floor must not overflow`).toBe(false);
  }
});
