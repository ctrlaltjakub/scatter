import { expect, test, type Page } from '@playwright/test';

// DOM snapshots during focus changes can themselves block animation frames.
// Keep a video and frame samples instead of tracing this motion test.
test.use({ trace: 'off', video: process.env.SCATTER_MOTION_VIDEO ? 'on' : 'off' });

const sections = (count: number) => Array.from({ length: count }, (_, index) =>
  `- Section ${index + 1}\n${Array.from({ length: 4 }, (_, child) =>
    `  - Detail ${child + 1}: A clear explanation of this part of the network and its behavior.`,
  ).join('\n')}`,
).join('\n');

async function fixture(page: Page, selected: boolean, height: number, count = 6) {
  await page.setViewportSize({ width: 1500, height: 1200 });
  await page.route('**/*', route => ['localhost', '127.0.0.3', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(({ body, selected, height }) => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`bullet-click-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const graph = win.testExport('useGraphStore');
    win.testExport('useSettingsStore').setState({ autoTermPreviews: false, autoFreeImages: false, providers: [], activeModelRef: null });
    const node = { id: 'bullet-fixture', type: 'term-click', frozen: true, position: { x: 0, y: 0 },
      versions: [{ header: 'Network sections', body, createdAt: 1, generatedBy: 'manual', contentType: 'encyclopedic',
        width: 650, bodyMaxHeight: height }], currentVersionIndex: 0 };
    const project = graph.getState().project;
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: 'other', arrows: {}, groups: {},
      selection: selected ? [node.id] : [], viewport: { x: 520, y: 50, zoom: 1 } });
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
  }, { body: `An introduction to how a network shares information. Each section describes a different part of the process.\n\n${sections(count)}`, selected, height });
  await page.locator('[data-node-id="bullet-fixture"] .node-body').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
}

type MotionFrame = { time: number; top: number; height: number; width: number; targetTop: number; targetHeight: number };
type Motion = { frames: MotionFrame[]; cancelled: string[]; done: boolean };

async function recordMotion(page: Page, action: () => Promise<unknown>): Promise<Motion> {
  await page.evaluate(() => new Promise<void>(resolve => {
    const capture: Motion = { frames: [], cancelled: [], done: false };
    (window as any).scrollbarMotion = capture;
    const start = performance.now();
    const onCancel = (event: TransitionEvent) => {
      if ((event.target as Element).matches('.node-scrollbar-bar')) capture.cancelled.push(event.propertyName);
    };
    document.addEventListener('transitioncancel', onCancel);
    const sample = () => {
      const bar = document.querySelector<HTMLElement>('[data-node-id="bullet-fixture"] .node-scrollbar-bar');
      if (bar) {
        const style = getComputedStyle(bar);
        capture.frames.push({ time: performance.now() - start, top: parseFloat(style.top), height: parseFloat(style.height),
          width: parseFloat(style.width), targetTop: parseFloat(bar.style.top), targetHeight: parseFloat(bar.style.height) });
      }
      resolve();
      if (performance.now() - start < 2300) requestAnimationFrame(sample);
      else { capture.done = true; document.removeEventListener('transitioncancel', onCancel); }
    };
    requestAnimationFrame(sample);
  }));
  await action();
  await expect.poll(() => page.evaluate(() => (window as any).scrollbarMotion.done)).toBe(true);
  return page.evaluate(() => (window as any).scrollbarMotion);
}

function expectUninterruptedMotion(motion: Motion) {
  const { frames } = motion;
  const first = frames[0]!;
  const last = frames.at(-1)!;
  expect(Math.abs(last.top - first.top)).toBeGreaterThan(20);
  expect(motion.cancelled).toEqual([]);
  // No stale collapsed range between the original and final targets, no
  // reversal, and no change in the scrollbar's thickness.
  for (const frame of frames) {
    expect([first, last].some(target => Math.abs(frame.targetTop - target.targetTop) < 0.1
      && Math.abs(frame.targetHeight - target.targetHeight) < 0.1)).toBe(true);
    expect(frame.width).toBe(first.width);
  }
  const direction = Math.sign(last.top - first.top);
  for (let i = 1; i < frames.length; i++) expect((frames[i]!.top - frames[i - 1]!.top) * direction).toBeGreaterThanOrEqual(-0.1);
  // Require actual intermediate positions, not merely a transition event.
  const intermediate = frames.filter(frame => Math.abs(frame.top - first.top) > 1 && Math.abs(frame.top - last.top) > 1);
  expect(new Set(intermediate.map(frame => frame.top)).size).toBeGreaterThanOrEqual(5);
  expect(Math.abs(last.top - last.targetTop)).toBeLessThan(0.1);
  expect(Math.abs(last.height - last.targetHeight)).toBeLessThan(0.1);
}

test('click expansion, wheel movement, and refocusing have one uninterrupted scrollbar animation', async ({ page }, info) => {
  await fixture(page, true, 620, 12);
  const node = page.locator('[data-node-id="bullet-fixture"]');
  const size = await node.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  const click = async (index: number) => {
    const bullet = node.locator(`[data-sc-anchor="b-${index}"]`);
    const rect = (await bullet.boundingBox())!;
    await page.mouse.move(rect.x + 3, rect.y + 8);
    const motion = await recordMotion(page, () => page.mouse.click(rect.x + 3, rect.y + 8));
    await expect(bullet).toHaveClass(/is-active/);
    return motion;
  };
  const focused = await click(4);
  expectUninterruptedMotion(focused);
  const wheel = await recordMotion(page, () => page.mouse.wheel(0, 240));
  expectUninterruptedMotion(wheel);
  await page.evaluate(() => (window as any).testExport('useGraphStore').getState().setSelection([]));
  await page.waitForTimeout(700);
  const refocused = await click(2);
  expectUninterruptedMotion(refocused);
  expect(await node.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))).toEqual(size);
  await info.attach('scrollbar-frames.json', { body: JSON.stringify({ focused, wheel, refocused }), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('expanded-section.png') });
});

test('the first focus + bullet click also has intermediate scrollbar frames', async ({ page }) => {
  await fixture(page, false, 320);
  const third = page.locator('[data-node-id="bullet-fixture"] [data-sc-anchor="b-2"]');
  await expect(third).toHaveAttribute('aria-expanded', 'false');
  const rect = (await third.boundingBox())!;
  await page.mouse.move(rect.x + 3, rect.y + 8);
  const motion = await recordMotion(page, () => page.mouse.click(rect.x + 3, rect.y + 8));
  await expect(third).toHaveClass(/is-active/);
  expectUninterruptedMotion(motion);
});

test('fully visible bullets still become active by click and keyboard without changing the node size', async ({ page }, info) => {
  await fixture(page, true, 1000);
  const node = page.locator('[data-node-id="bullet-fixture"]');
  const first = node.locator('[data-sc-anchor="b-0"]');
  const second = node.locator('[data-sc-anchor="b-1"]');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  const size = await node.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  await first.click({ position: { x: 3, y: 8 } });
  await expect(first).toHaveClass(/is-active/);
  await second.focus();
  await page.keyboard.press('Enter');
  await expect(second).toHaveClass(/is-active/);
  await expect(first).not.toHaveClass(/is-active/);
  expect(await node.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }))).toEqual(size);
  expect(await node.locator('.node-body').evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await page.waitForTimeout(400);
  await page.screenshot({ path: info.outputPath('fully-visible-active.png') });
});
