import { test, expect, type Page } from '@playwright/test';

/**
 * Helper: complete Welcome A (fill API key + click "Connect & continue"),
 * wait for Welcome B to appear, then fill and submit the topic.
 */
async function onboardAndSubmitTopic(page: Page, topic: string) {
  await expect(page.getByPlaceholder('sk-…')).toBeVisible();
  await page.getByPlaceholder('sk-…').fill('sk-test');
  await page.getByRole('button', { name: 'Connect & continue' }).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();

  await expect(page.getByPlaceholder('A topic or a question…')).toBeVisible();
  await page.getByPlaceholder('A topic or a question…').fill(topic);
  // Submit via the arrow button (aria-label="Submit topic")
  await page.getByRole('button', { name: 'Submit topic' }).click();
}

test('cascade delete removes a subtree; Ctrl+Z restores it', async ({ page }) => {
  await page.addInitScript(() => {
    void navigator.storage?.getDirectory?.().then(async (root) => {
      // @ts-expect-error 'entries' is supported
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    });
  });

  await page.route('https://api.openai.com/v1/models', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'mock-model' }] }) });
  });
  let callCount = 0;
  await page.route('https://api.openai.com/v1/chat/completions', async (route) => {
    // The auto-naming call fires alongside root generation; answer it with a
    // title so it doesn't consume the node-generation call-order sequence.
    if ((route.request().postData() ?? '').includes('short title for a research project')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: {"choices":[{"delta":{"content":"Topic"}}]}\n\ndata: [DONE]\n\n` });
      return;
    }
    callCount += 1;
    const body = callCount === 1
      ? `data: {"choices":[{"delta":{"content":"Root with [[child-term]]."}}]}\n\ndata: [DONE]\n\n`
      : `data: {"choices":[{"delta":{"content":"Child body content."}}]}\n\ndata: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });

  await page.goto('/');
  await onboardAndSubmitTopic(page, 'topic');

  // Wait for the chip from the root node
  await expect(page.getByRole('button', { name: 'child-term' })).toBeVisible();
  // Click the chip to spawn child node — use direct JS click to bypass canvas selection capture
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    const chip = btns.find(b => b.textContent === 'child-term');
    chip?.click();
  });
  await expect(page.getByText('Child body content.')).toBeVisible();

  // Select the root node via the header's pointer-up flow (selection now lives on the header drag handle).
  // The root node header contains "topic" (the submitted topic text). We find its cursor-grab
  // wrapper and dispatch pointerdown + pointerup to trigger the select-on-click path.
  await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('h3')) as HTMLHeadingElement[];
    // Root node header text is the topic ("topic"), not the body. Pick the first one.
    const rootHeader = headers.find(h => h.textContent?.trim() === 'topic');
    if (rootHeader) {
      const wrapper = rootHeader.closest('[class*="cursor-grab"]') as HTMLElement;
      wrapper?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      wrapper?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    }
  });
  // Wait for React to re-render the SidePanel after selection
  await page.waitForTimeout(200);
  // Click the X delete button via JS to avoid viewport/stability issues from physics animation
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    // The SidePanel X button has hover:text-ctp-red class
    const xBtn = btns.find(b => b.classList.contains('hover:text-ctp-red') || b.querySelector('svg.lucide-x'));
    xBtn?.click();
  });

  // Both Root with and Child body should be gone now
  await expect(page.getByText('Child body content.')).toHaveCount(0);
  await expect(page.getByText('Root with')).toHaveCount(0);

  // Blur any focused input so Ctrl+Z reaches the window handler (not blocked by inEditable check)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  // Ctrl+Z should restore them
  await page.keyboard.press('Control+z');
  await expect(page.getByText('Child body content.')).toBeVisible();
  await expect(page.getByText('Root with')).toBeVisible();
});
