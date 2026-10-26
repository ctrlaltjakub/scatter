import { expect, test } from '@playwright/test';

for (const chunked of [false, true]) test(`chat selection actions survive list rendering (chunking=${chunked})`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  // No accounts, model requests, or real projects are involved.
  await page.route('**/*', route => ['127.0.0.3', 'localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(chunked => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`chat-selection-${Date.now()}`], {}, (require: any) => {
      win.selectionTestExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const get = win.selectionTestExport;
    get('useSettingsStore').setState({ providers: [], activeModelRef: null, autoTermPreviews: false, autoFreeImages: false });
    get('useChatRuntimeStore').setState({ views: {} });
    let node = get('createChatNode')({ id: 'selection-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 650 });
    node.frozen = true;
    const bodies = [
      ['en', 'List selection', '## Selection checks\n\nA paragraph stays selectable.\n\n- A **selected phrase**. Another sentence.\n  - Nested selectable text.\n- [ ] An unfinished task.\n\n1. Numbered selectable text.\n2. Another numbered item.\n\n| Name | Value |\n|---|---|\n| Table selection | 123 |'],
      ['ja', '日本語', '- **明確な説明は複雑な考えを理解しやすくします。** 次の文です。'],
      ['ar', 'العربية', '- **تساعد التفسيرات الواضحة على فهم الأفكار المعقدة.**'],
      ['hi', 'हिन्दी', '- **स्पष्ट व्याख्याएँ जटिल विचारों को समझने में मदद करती हैं।**'],
    ];
    bodies.forEach(([language, question, body], index) => {
      const turnId = `turn-${index}`, createdAt = index + 2;
      node = get('appendChatAnswer')(node, { turnId, createdAt, question, metadata: { informationChunking: chunked } });
      node = get('updateChatAnswer')(node, { turnId, versionCreatedAt: createdAt }, { body, language }, { state: 'complete' });
    });
    node.generating = false; node.generatingVersionIndex = undefined;
    const graph = get('useGraphStore');
    const project = graph.getState().project;
    graph.setState({ project: { ...project, nodes: { [node.id]: node }, arrows: {}, rootNodeId: node.id,
      selection: [node.id], viewport: { x: 560, y: 90, zoom: 1 } }, activeProjectId: project.id, panTo: null });
  }, chunked);
  const chat = page.locator('[data-node-id="selection-chat"]');
  const scrolling = chat.locator('.chat-scroll');
  await scrolling.evaluate(el => { el.scrollTop = 0; });
  const phrase = chat.locator('[data-chat-answer="turn-0"] strong').first();
  await phrase.scrollIntoViewIfNeeded();
  const bounds = (await phrase.boundingBox())!;
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  const toolbar = page.locator('.sc-sel-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Explore', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).selectionTestExport('useNodeTextSelectionStore').getState().selection?.text)).toBe('selected phrase');
  await expect.poll(() => page.evaluate(() => (window as any).selectionTestExport('useGraphStore').getState().project.nodes['selection-chat'].currentVersionIndex)).toBe(1);
  const asking = chat.getByRole('button', { name: 'Stop asking about: selected phrase' });
  await expect(asking).toBeVisible();
  await expect(asking).toHaveText('Asking about: selected phrase');
  await expect(chat.getByRole('textbox', { name: 'Chat message' })).not.toBeFocused();
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: info.outputPath(`chat-selection-${chunked}-${theme}.png`), animations: 'disabled' });
  }
  await page.keyboard.press('Escape');
  await expect(toolbar).toHaveCount(0);
  await expect(asking).toHaveCount(0);

  // Exercise source mapping in additional layouts and non-space-delimited/RTL scripts.
  for (const selector of [
    '[data-chat-answer="turn-0"] li li',
    '[data-chat-answer="turn-0"] .task-list-item',
    '[data-chat-answer="turn-0"] ol li',
    '[data-chat-answer="turn-0"] td',
    '[data-chat-answer="turn-1"] strong',
    '[data-chat-answer="turn-2"] strong',
    '[data-chat-answer="turn-3"] strong',
  ]) {
    const content = chat.locator(selector).first();
    await content.scrollIntoViewIfNeeded();
    // Native Range handles complete multi-line/RTL selections without relying on glyph widths.
    const selectedText = await content.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return selection.toString().trim();
    });
    await expect(toolbar.getByRole('button', { name: 'Explore', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).selectionTestExport('useNodeTextSelectionStore').getState().selection?.text)).toBe(selectedText);
    await expect(chat.locator('.chat-answer-reference')).toHaveText('Asking about: ' + selectedText.replace(/\s+/gu, ' '));
    if (selector.includes('turn-2')) await page.screenshot({ path: info.outputPath(`arabic-chat-selection-${chunked}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
  }
  // User questions are selectable for ordinary copying, but never become the
  // assistant-answer scope or display answer selection actions.
  const userMessage = chat.locator('.chat-user-message').first();
  await userMessage.scrollIntoViewIfNeeded();
  await userMessage.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(chat.locator('.chat-answer-reference')).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
  // Keep the answer scope when focusing and typing into the composer, then
  // dismiss it through the same single-line label as the Ask about button.
  await phrase.scrollIntoViewIfNeeded();
  await phrase.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(asking).toBeVisible();
  await chat.getByRole('textbox', { name: 'Chat message' }).click();
  await chat.getByRole('textbox', { name: 'Chat message' }).fill('Explain this');
  await expect(asking).toBeVisible();
  await asking.click();
  await expect(asking).toHaveCount(0);
  await expect(chat.getByRole('textbox', { name: 'Chat message' })).toHaveValue('Explain this');
});
