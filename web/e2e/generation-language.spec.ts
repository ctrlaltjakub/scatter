import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Isolated sandbox fixtures only. Block every external request, including LLMs.
async function fixture(page: Page) {
  await page.route('**/*', route => ['localhost', '127.0.0.3', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await page.goto('/sandbox');
  await page.locator('[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const win = window as any;
    win.webpackChunk_N_E.push([[`languages-${Date.now()}`], {}, (require: any) => {
      win.testExport = (name: string) => {
        for (const entry of Object.values(require.c) as any[]) if (entry.exports?.[name]) return entry.exports[name];
        throw new Error(`Missing test export: ${name}`);
      };
    }]);
    const graph = win.testExport('useGraphStore');
    win.testExport('useSettingsStore').setState({ generationLanguage: 'en', nodeFontId: 'app', autoTermPreviews: false, autoFreeImages: false,
      providers: [{ id: 'fixture', preset: 'custom', apiKey: 'not-a-real-key', enabledModels: ['google/gemini-3.8-flash'] }],
      activeModelRef: { providerId: 'fixture', model: 'google/gemini-3.8-flash' }, webSearch: false });
    win.testExport('useModelCatalogStore').getState().setCatalog('fixture', [{ id: 'google/gemini-3.8-flash', caps: { textOutput: true, vision: true }, reasoning: { supportedEfforts: ['low', 'high'] } }]);
    const versions = [
      { language: 'en', header: 'Reading fonts', body: 'Clear explanations make complex ideas easier to understand. A second sentence checks wrapping.\n\n- Reading\n  - Font: One consistent family per node.\n  - Language: Stored with every version.' },
      { language: 'ar', header: 'اللغة والخط', body: 'تساعد التفسيرات الواضحة على فهم الأفكار المعقدة. هذه جملة أخرى لاختبار عرض النص.\n\n- القراءة\n  - الخط: يستخدم النص خطاً واضحاً ومتناسقاً.\n  - اللغة: تحفظ اللغة مع كل إصدار.' },
      { language: 'ja', header: '言語と読みやすさ', body: '明確な説明は複雑な考えを理解しやすくします。これは文章の表示を確認するための文です。\n\n- 読みやすさ\n  - 書体: 全体で同じ書体を使います。\n  - 言語: 言語は各バージョンに保存されます。' },
    ].map((v, i) => ({ ...v, createdAt: i + 1, generatedBy: 'manual', contentType: 'encyclopedic', width: 650 }));
    const node = { id: 'language-fixture', type: 'root', position: { x: 0, y: 0 }, frozen: true, currentVersionIndex: 0, versions };
    const project = graph.getState().project;
    graph.getState().setProject({ ...project, nodes: { [node.id]: node }, rootNodeId: node.id, arrows: {}, selection: [node.id], viewport: { x: 520, y: 50, zoom: .9 } });
    graph.setState({ activeProjectId: project.id });
    graph.getState().requestPanTo(null);
  });
  await page.locator('[data-node-id="language-fixture"]').waitFor();
}

async function checkModelRow(page: Page, surface: string) {
  const row = page.locator(`${surface} .sc-modelpicker-row`).first();
  const sizes = await row.evaluate(row => {
    const button = row.querySelector('.sc-modelpicker-btn')!;
    const label = row.querySelector('.sc-modelpicker-label')!;
    const language = row.querySelector('.sc-language-trigger')!;
    const icon = row.querySelector('.sc-reasoning-trigger svg')!;
    const chevron = button.querySelector('svg')!;
    const style = getComputedStyle(button);
    const range = document.createRange(); range.selectNodeContents(language);
    const languageWidth = range.getBoundingClientRect().width;
    const text = label.firstChild!;
    const space = text.textContent!.indexOf(' ');
    range.setStart(text, space); range.setEnd(text, space + 1);
    const spaceWidth = range.getBoundingClientRect().width;
    range.setStart(text, 0); range.setEnd(text, 1);
    return { languageWidth, iconWidth: icon.getBoundingClientRect().width, spaceWidth,
      letterWidth: range.getBoundingClientRect().width, left: style.paddingLeft, right: style.paddingRight,
      gap: chevron.getBoundingClientRect().left - label.getBoundingClientRect().right,
      chevronWidth: chevron.getBoundingClientRect().width };
  });
  expect(sizes.languageWidth).toBeGreaterThanOrEqual(sizes.iconWidth * .85);
  expect(sizes.languageWidth).toBeLessThanOrEqual(sizes.iconWidth * 1.1);
  expect(sizes.left).toBe(sizes.right);
  expect(sizes.gap).toBeLessThanOrEqual(2.1);
  expect(sizes.chevronWidth).toBe(8);
  expect(sizes.spaceWidth / sizes.letterWidth).toBeCloseTo(.5, 1);
}

test('language button lowers only its letters by 10% of their height', async ({ page }, info) => {
  await fixture(page);
  const button = page.getByRole('button', { name: 'Generation language: English' }).first();
  const dimensions = await button.evaluate(button => {
    const label = button.querySelector('.sc-language-trigger-label')!;
    const buttonRect = button.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    return { width: buttonRect.width, height: buttonRect.height, labelHeight: labelRect.height,
      offset: labelRect.top + labelRect.height / 2 - (buttonRect.top + buttonRect.height / 2) };
  });
  expect(dimensions.width).toBe(32);
  expect(dimensions.height).toBe(32);
  expect(dimensions.offset).toBeCloseTo(dimensions.labelHeight * .1, 1);
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('.sidebar .sc-modelpicker-row').first()
      .screenshot({ path: info.outputPath(`language-button-${theme}.png`) });
  }
});

test('language list fades at scroll edges and uses the settings scrollbar', async ({ page }, info) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Generation language: English' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Generation language' });
  const list = dialog.getByRole('listbox', { name: 'Languages' });
  await expect(list).toHaveCSS('--language-fade-top', '0px');
  await expect(list).toHaveCSS('--language-fade-bottom', '24px');
  const scrollbar = await list.evaluate(el => ({ width: getComputedStyle(el, '::-webkit-scrollbar').width,
    radius: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderRadius,
    widthMode: getComputedStyle(el).scrollbarWidth }));
  expect(scrollbar).toEqual({ width: '8px', radius: '4px', widthMode: 'auto' });
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await list.evaluate(el => { el.scrollTop = 175; });
    await expect(list).toHaveCSS('--language-fade-top', '24px');
    await expect(list).toHaveCSS('--language-fade-bottom', '24px');
    await dialog.screenshot({ path: info.outputPath(`language-fades-${theme}.png`) });
    await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(list).toHaveCSS('--language-fade-bottom', '0px');
    await dialog.screenshot({ path: info.outputPath(`language-bottom-${theme}.png`) });
  }
  await dialog.getByRole('searchbox').fill('日本語');
  await expect(list).toHaveCSS('--language-fade-top', '0px');
  await expect(list).toHaveCSS('--language-fade-bottom', '0px');
  await expect(list.getByRole('option')).toHaveCount(1);
});

test('language controls, full-node fallback and RTL render in both themes', async ({ page }, info) => {
  test.setTimeout(120_000);
  await fixture(page);
  await checkModelRow(page, '.sidebar');
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    const button = page.getByRole('button', { name: 'Generation language: English' }).first();
    await button.click();
    await expect(page.getByRole('dialog', { name: 'Generation language' })).toBeVisible();
    await expect(page.getByRole('option')).toHaveCount(20);
    await page.screenshot({ path: info.outputPath(`picker-${theme}.png`) });
    await page.keyboard.press('Escape');
    for (const [index, family, direction] of [[1, 'Noto Sans Arabic', 'rtl'], [2, 'Noto Sans JP', 'ltr']] as const) {
      await page.evaluate(index => {
        const graph = (window as any).testExport('useGraphStore');
        graph.getState().updateNode('language-fixture', { currentVersionIndex: index });
      }, index);
      const body = page.locator('[data-node-id="language-fixture"] .sc-ab-root');
      await expect(body).toHaveCSS('direction', direction);
      await expect(page.locator('[data-node-id="language-fixture"] .sc-ab-freetext').first()).toHaveCSS('font-family', new RegExp(family));
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: info.outputPath(`node-${index}-${theme}.png`) });
    }
  }
  // A selection change is a preference, not a change to existing content.
  await page.getByRole('button', { name: 'Generation language: English' }).first().click();
  await page.getByRole('searchbox', { name: 'Search languages' }).fill('Polsh');
  await page.screenshot({ path: info.outputPath('picker-filtered.png') });
  await page.getByRole('option', { name: /Polish/ }).click({ timeout: 5000 });
  await expect(page.getByRole('button', { name: 'Generation language: Polish' }).first()).toHaveText('PL');
  await expect(page.locator('[data-node-id="language-fixture"] .node-language-tag')).toHaveText('Japanese');
  const data = readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2').toString('base64');
  await page.evaluate(data => {
    const find = (window as any).testExport;
    const id = 'custom-font-' + 'a'.repeat(64);
    find('useSettingsStore').setState({ nodeFontId: id, customNodeFonts: [{ id, name: 'Test Latin', fileName: 'test.woff2', format: 'woff2', data, byteLength: atob(data).length }] });
    find('useGraphStore').getState().updateNode('language-fixture', { currentVersionIndex: 0 });
  }, data);
  await expect(page.locator('[data-node-id="language-fixture"] .sc-ab-freetext').first()).toHaveCSS('font-family', /ScatterCustomFont/);
  await page.evaluate(() => (window as any).testExport('useGraphStore').getState().updateNode('language-fixture', { currentVersionIndex: 1 }));
  await expect(page.locator('[data-node-id="language-fixture"] .sc-ab-freetext').first()).toHaveCSS('font-family', /Noto Sans Arabic/);
  await expect(page.locator('[data-node-id="language-fixture"] .node-title').last()).toHaveCSS('font-family', /Noto Sans Arabic/);
});

test('picker stays visible in the compact toolbar and topic picker, with settings copy beside font scope', async ({ page }, info) => {
  test.setTimeout(90_000);
  await fixture(page);
  await page.evaluate(async () => {
    const find = (window as any).testExport;
    const settings = find('useSettingsStore').getState();
    const project = find('useGraphStore').getState().project;
    const root = await navigator.storage.getDirectory();
    const write = async (dir: FileSystemDirectoryHandle, name: string, value: unknown) => {
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable(); await stream.write(JSON.stringify(value)); await stream.close();
    };
    await write(root, 'settings.json', settings);
    const projects = await root.getDirectoryHandle('projects', { create: true });
    await write(projects, `${project.id}.json`, project);
    await write(projects, 'index.json', { activeId: project.id, items: [{ id: project.id, name: project.name, createdAt: 1, updatedAt: 1 }] });
  });
  await page.goto('/');
  await page.locator('[data-node-id="language-fixture"]').waitFor();
  await page.getByRole('button', { name: 'Start new project' }).click();
  const picker = page.locator('.welcome--picker');
  await checkModelRow(page, '.welcome--picker');
  await picker.getByRole('button', { name: 'Generation language: English' }).click();
  const menu = picker.getByRole('dialog', { name: 'Generation language' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('searchbox')).toBeVisible();
  await menu.getByRole('searchbox').fill('日本語');
  await menu.getByRole('option', { name: /Japanese/ }).click();
  await expect(picker.getByRole('button', { name: 'Generation language: Japanese' })).toHaveText('JA');
  await picker.getByRole('button', { name: 'Generation language: Japanese' }).click();
  await page.screenshot({ path: info.outputPath('topic-picker.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Close topic picker' }).click();
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await checkModelRow(page, '.canvas-topright');
  await page.locator('.canvas-topright').getByRole('button', { name: 'Generation language: Japanese' }).click();
  await expect(page.getByRole('dialog', { name: 'Generation language' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('compact-toolbar.png') });
  await page.keyboard.press('Escape');
  await page.locator('.canvas-topright').getByRole('button', { name: /Settings/i }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const scope = page.locator('.settings-node-fonts .settings-reading-subheading p');
  await expect(scope).toContainText('Used for node titles and text, including chats.');
  await expect(scope).toContainText('whole node or chat answer');
  await scope.scrollIntoViewIfNeeded();
  await expect(page.locator('.settings-reading-preview')).toContainText('Japanese');
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.screenshot({ path: info.outputPath(`font-settings-${theme}.png`) });
  }
});

test('chat answers retain independent languages, fonts and reading directions', async ({ page }, info) => {
  await fixture(page);
  await page.evaluate(() => {
    const find = (window as any).testExport;
    let node = find('createChatNode')({ id: 'mixed-chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 430 });
    for (const [turnId, language, body, createdAt] of [
      ['en-answer', 'en', '**Water** is essential for **life**.', 2],
      ['ar-answer', 'ar', '**الماء** ضروري لجميع أشكال **الحياة**.', 3],
      ['ja-answer', 'ja', '**[[水]]**は**[[生命]]**に不可欠です。', 4],
    ]) {
      node = find('appendChatAnswer')(node, { turnId, createdAt, question: 'Describe water.' });
      node = find('updateChatAnswer')(node, { turnId, versionCreatedAt: createdAt }, { body, language }, { state: 'complete' });
    }
    node.frozen = true;
    node.generating = false;
    node.streamingText = false;
    node.generatingVersionIndex = undefined;
    const graph = find('useGraphStore');
    graph.getState().setProject({ ...graph.getState().project, nodes: { [node.id]: node }, rootNodeId: node.id,
      selection: [node.id], viewport: { x: 400, y: 35, zoom: .9 } });
  });
  const english = page.locator('[data-chat-answer="en-answer"]');
  const arabic = page.locator('[data-chat-answer="ar-answer"]');
  const japanese = page.locator('[data-chat-answer="ja-answer"]');
  await expect(english.locator('.chat-markdown')).toHaveAttribute('lang', 'en-US');
  await expect(arabic.locator('.chat-markdown')).toHaveCSS('direction', 'rtl');
  await expect(arabic.locator('.chat-markdown')).toHaveCSS('font-family', /Noto Sans Arabic/);
  await expect(japanese.locator('.chat-markdown')).toHaveCSS('font-family', /Noto Sans JP/);
  await expect(japanese.locator('.chat-markdown')).toHaveCSS('direction', 'ltr');
  await expect(page.locator('.chat-answer-language')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: info.outputPath('mixed-chat.png') });
  await expect(japanese.getByRole('button', { name: 'Copy text', exact: true })).toBeVisible();
  await japanese.getByRole('button', { name: 'Copy to node', exact: true }).click();
  const panel = page.locator('.answer-side-actions');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Regenerate', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add node', exact: true }).click();
  for (const label of ['Chat', 'Image or video', 'Encyclopedic node', 'Explanation', 'Interactive node', 'Markdown text node'])
    await expect(panel.getByRole('button', { name: label, exact: true })).toHaveAttribute('data-tip', /.+/);
  await page.screenshot({ path: info.outputPath('answer-text-node.png') });
});

test('chunked sentences keep formatting, citations and native punctuation across scripts', async ({ page }, info) => {
  test.setTimeout(120_000);
  await fixture(page);
  const samples = [
    { language: 'ja', header: '日本語 · Sentence boundaries', body: '**脳神経診察は、頭蓋底を出入りする12対の脳神経の機能を系統的に評価し、脳幹や頭蓋内病変の解剖学的局在診断を導く神経学的診察の基本的な手法です。**⟦1⟧この検査では、[[脳幹]]の反射や感覚・運動経路を直接評価し、他の検査で得られた情報と組み合わせて病変の位置を調べます。**「眼球運動も観察します。」** ⟦2⟧（検査結果を統合します。）' },
    { language: 'zh', header: '简体中文 · Sentence boundaries', body: '**清晰的解释有助于理解复杂概念。**⟦1⟧[[阅读]]时可以查看术语预览。**「每句话从新的一行开始。」** ⟦2⟧（文字和标点保持完整。）' },
    { language: 'ko', header: '한국어 · Sentence boundaries', body: '**명확한 설명은 이해를 돕습니다.** ⟦1⟧ [[읽기]]는 정보를 전달합니다. **“다음 문장은 새 줄에서 시작합니다.”** ⟦2⟧ (문장 부호를 유지합니다.)' },
    { language: 'ar', header: 'العربية · Sentence boundaries', body: '**هل هذا الشرح واضح؟** ⟦1⟧ تساعد [[القراءة]] على فهم الأفكار. **«تبدأ الجملة التالية في سطر جديد.»** ⟦2⟧ (يبقى النص متصلاً وواضحاً.)' },
    { language: 'hi', header: 'हिन्दी · Sentence boundaries', body: '**स्पष्ट व्याख्या समझने में मदद करती है।** ⟦1⟧ [[पढ़ना]] उपयोगी है।**“अगला वाक्य नई पंक्ति में है।”** ⟦2⟧ (पाठ और विराम चिह्न सुरक्षित रहते हैं॥)' },
    { language: 'es', header: 'Español · Sentence boundaries', body: '**Una explicación clara ayuda a comprender.** ⟦1⟧ ¿Cómo funciona la [[lectura]]? **¡La siguiente frase empieza en otra línea!** ⟦2⟧ (La puntuación se conserva.)' },
    { language: 'ru', header: 'Русский · Sentence boundaries', body: '**Ясные объяснения помогают понять сложные идеи.** ⟦1⟧ [[Чтение]] передаёт информацию. **«Следующее предложение начинается с новой строки.»** ⟦2⟧ (Знаки препинания сохраняются.)' },
    { language: 'vi', header: 'Tiếng Việt · Sentence boundaries', body: '**Giải thích rõ ràng giúp hiểu ý tưởng phức tạp.** ⟦1⟧ [[Đọc]] giúp tiếp nhận thông tin. **“Câu tiếp theo bắt đầu trên dòng mới.”** ⟦2⟧ (Dấu câu và dấu thanh được giữ nguyên.)' },
  ];
  await page.evaluate(samples => {
    const find = (window as any).testExport;
    find('useSettingsStore').setState({ sentencePerLine: true });
    find('useGraphStore').getState().updateNode('language-fixture', {
      chunkIntro: true,
      versions: samples.map((sample, i) => ({ ...sample, createdAt: i + 1, generatedBy: 'manual', contentType: 'encyclopedic', width: 650,
        sources: [1, 2].map(n => ({ n, url: `https://example.com/${n}`, domain: 'example.com', title: 'Fixture source' })) })),
    });
  }, samples);
  for (const theme of ['mocha', 'latte']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const [index, sample] of samples.entries()) {
      await page.evaluate(index => (window as any).testExport('useGraphStore').getState().updateNode('language-fixture', { currentVersionIndex: index }), index);
      const node = page.locator('[data-node-id="language-fixture"]');
      const text = node.locator('.sc-ab-root > .sc-ab-freetext');
      const sentences = text.locator('.sc-ab-sentence');
      await expect(sentences).toHaveCount(4);
      await expect(text.locator('.cite-marker')).toHaveCount(2);
      await expect(text.locator('.ref-chip')).toHaveCount(1);
      await expect(text).not.toContainText('**');
      await page.evaluate(() => document.fonts.ready);
      const rects = await sentences.evaluateAll(items => items.map(item => { const r = item.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
      for (let i = 1; i < rects.length; i++) expect(rects[i]!.top).toBeGreaterThanOrEqual(rects[i - 1]!.bottom - 1);
      await text.screenshot({ path: info.outputPath(`sentences-${sample.language}-${theme}.png`) });
      await page.evaluate(() => (window as any).testExport('useGraphStore').getState().updateNode('language-fixture', { chunkIntro: false }));
      await expect(text.locator('.sc-ab-sentence')).toHaveCount(0);
      await expect(text).not.toContainText('**');
      await page.evaluate(() => (window as any).testExport('useGraphStore').getState().updateNode('language-fixture', { chunkIntro: true }));
    }
  }
});
