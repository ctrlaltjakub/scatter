/** Paid/local integration audit. Never runs in the ordinary test suite.
 * Secrets, generated assets, and full results are deliberately outside git.
 * SCATTER_ACTION_AUDIT=anthropic|openai|ollama|lm-studio npx vitest run src/providers/providerActions.live.test.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import sharp from 'sharp';
import { chromium, type Browser } from '@playwright/test';
import { getAdapter } from './registry';
import type { ChatChunk, ModelInfo, StreamChatOpts } from './types';
import { DEFAULT_SETTINGS, type ProviderPreset, type NodeVersion } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { buildMessages, buildFollowUpClassifierPrompt, type TaskVariant } from '@/lib/promptBuilder';
import { DEFAULT_PROMPTS, substitute } from '@/lib/promptDefaults';
import { FACT_CHECK_SEARCH_POLICY } from '@/lib/factCheckRequest';
import { secondaryTaskCompletion, sourceQueryAlternates, transcribeSourceImage } from '@/lib/secondaryTaskCompletion';
import { markTerms, stripTermMarkers } from '@/lib/termMarking';
import { previewRequest, parseTermPreviews } from '@/lib/termPreviewCore';
import { parseBody } from '@/lib/bulletParse';
import { runChatToolLoop } from '@/lib/chat/toolRuntime';
import { runInteractiveHarness } from '@/lib/interactiveHarness';
import { interactiveTools } from '@/lib/interactiveActions';
import { buildInteractiveSrcDoc, DEFAULT_INTERACTIVE_HOST_STATE, INTERACTIVE_TOOL_ARGUMENT_LIMITS, validateInteractiveDocument } from '@/lib/interactiveDocument';
import type { InteractiveTestAction, InteractiveCheck } from '@/lib/interactiveProbe';

const preset = process.env.SCATTER_ACTION_AUDIT as ProviderPreset | undefined;
const phase = process.env.SCATTER_AUDIT_PHASE ?? 'all';
const selectedActions = process.env.SCATTER_AUDIT_ACTIONS?.split(',');
const root = process.env.SCATTER_PROVIDER_TEST_DIR ?? join(homedir(), '.local/share/scatter-provider-tests/2026-10-12');
const text = '**Triangle perimeter** is the **total distance** around its boundary.\n\n- Calculation\n  - Addition: Add the lengths of all three sides.\n  - Units: Use the same unit for every side.\n- Examples\n  - Equilateral triangle: Three equal sides give a perimeter of three times one side.\n  - Scalene triangle: Sides of 3, 4 and 5 cm give a perimeter of 12 cm.';
const context = { parent: { header: 'Triangle perimeter', body: text }, grandparent: null };
const version: NodeVersion = { header: 'Triangle perimeter', body: text, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic' };
const parseJson = (value: string) => JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));

it.skipIf(!['openai', 'anthropic', 'ollama', 'lm-studio'].includes(preset ?? ''))('tests each model-driven action through real provider adapters', async () => {
  const provider = preset!;
  const secrets = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'));
  const key = secrets[provider] ?? 'local-test';
  const local = provider === 'ollama' || provider === 'lm-studio';
  const main = provider === 'openai' ? 'gpt-6.1-sol' : provider === 'anthropic' ? 'claude-opus-5-5' : process.env.SCATTER_LOCAL_MODEL ?? 'qwen3.5:2b';
  const secondary = provider === 'openai' ? 'gpt-6-luna' : provider === 'anthropic' ? 'claude-sonnet-5-5' : main;
  const base = provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : provider === 'lm-studio' ? 'http://127.0.0.1:1234/v1' : undefined;
  const redact = (s: string) => Object.values(secrets).reduce<string>((t, value) => t.replaceAll(String(value), '[REDACTED]'), s);
  const resultDir = join(root, 'results', `${provider}-${phase}-${Date.now()}`);
  await mkdir(resultDir, { recursive: true, mode: 0o700 });
  const results: Record<string, unknown>[] = [], requests: Record<string, unknown>[] = [];
  const observations: Promise<void>[] = [];
  const nativeFetch = globalThis.fetch;
  let action = 'catalog', requestCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!/^https:\/\/api\.(?:openai|anthropic)\.com\//.test(url) && !/^http:\/\/127\.0\.0\.1:(?:11434|1234)\//.test(url)) throw new Error(`Audit blocked unexpected network request: ${url}`);
    if (init?.method === 'POST' && ++requestCount > 90) throw new Error('Audit request ceiling reached.');
    const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const meta: Record<string, unknown> = { action, url, model: requestBody.model,
      maxTokens: requestBody.max_tokens ?? requestBody.max_completion_tokens ?? requestBody.max_output_tokens,
      reasoning: requestBody.reasoning ?? requestBody.reasoning_effort ?? requestBody.output_config, started: Date.now() };
    const response = await nativeFetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(local ? 180000 : 120000)]) : AbortSignal.timeout(120000) });
    meta.status = response.status; requests.push(meta); await save();
    observations.push(response.clone().text().then(body => {
      meta.ms = Date.now() - Number(meta.started);
      const usage: unknown[] = [];
      const lines = body.startsWith('{') ? [body] : body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5));
      for (const line of lines) try {
        const data = JSON.parse(line); const u = data.usage ?? data.message?.usage ?? data.response?.usage;
        if (u) usage.push(u);
      } catch { /* SSE sentinel or unrelated event. */ }
      meta.usage = usage;
      if (!response.ok) meta.error = redact(body).slice(0, 1500);
    }).catch(error => { meta.observationError = String(error); }));
    return response;
  };
  const adapter = getAdapter(provider);
  let browser: Browser | undefined;
  const save = async () => writeFile(join(resultDir, 'report.json'), redact(JSON.stringify({ provider, main, secondary, phase, results, requests }, null, 2)), { mode: 0o600 });
  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (selectedActions && !selectedActions.includes(name)) return false;
    action = name; const started = Date.now(); await save();
    let result: Record<string, unknown>;
    try { result = { action: name, status: 'pass', details: await fn() }; }
    catch (error) { result = { action: name, status: 'fail', error: redact(String(error)), cause: redact(String((error as Error)?.cause ?? '')) }; }
    result.ms = Date.now() - started; results.push(result); await save();
    console.log(`${provider}: ${name}: ${result.status}`);
    return result.status === 'pass';
  };
  try {
    const catalog = await adapter.listModels(key, base);
    const info = (model: string) => catalog.find(m => m.id === model);
    expect(info(main), `Model ${main} not in catalog`).toBeDefined();
    useSettingsStore.setState({ ...DEFAULT_SETTINGS, providers: [{ id: 'audit', preset: provider, apiKey: key, baseUrl: base, enabledModels: [main] }],
      activeModelRef: { providerId: 'audit', model: main }, secondaryUseSameModel: false,
      secondaryModelRef: { providerId: 'audit', model: secondary }, webSearch: false, customPrompts: undefined });
    useModelCatalogStore.getState().setCatalog('audit', catalog);
    const invoke = (opts: Partial<StreamChatOpts> = {}) => adapter.streamChat(key, { model: main, modelInfo: info(main),
      messages: [], maxOutputTokens: local ? 1024 : 4096, reasoningEffort: local && process.env.SCATTER_LOCAL_REASONING === 'off' ? 'off' : 'low', webSearch: false, signal: AbortSignal.timeout(local ? 180000 : 120000), ...opts }, base);
    const collect = async (opts: Partial<StreamChatOpts>) => {
      const chunks: ChatChunk[] = []; let body = '';
      try { for await (const chunk of invoke(opts)) { chunks.push(chunk); body += chunk.delta; } }
      finally { await writeFile(join(resultDir, `${action}-output.txt`), body); }
      if (chunks.some(c => ['length', 'max_tokens'].includes(c.finishReason ?? ''))) throw new Error(`Output limit reached; received ${body.length} visible characters.`);
      if (!body.trim()) throw new Error('No visible text returned.');
      return { body, citations: chunks.flatMap(c => c.citations ?? []), search: chunks.some(c => c.webSearch?.used) };
    };
    const complete = (system: string, user: string, budget = 2000) => secondaryTaskCompletion({ system, user, maxOutputTokens: budget, signal: AbortSignal.timeout(local ? 180000 : 120000) });
    results.push({ action: 'model-discovery', status: 'pass', details: { main: info(main), secondary: info(secondary) } });

    if (['all', 'main'].includes(phase)) {
      const variants: [string, TaskVariant, 'outline' | 'prose' | 'fragment' | 'markdown'][] = [
        ['root-and-empty-encyclopedic', { kind: 'root', topic: 'Triangle perimeter' }, 'outline'],
        ['term-node', { kind: 'term-click', term: 'equilateral triangle' }, 'outline'],
        ['encyclopedic-follow-up', { kind: 'follow-up', question: 'Tell me about triangle area' }, 'outline'],
        ['selected-text-follow-up', { kind: 'follow-up', question: 'What other units are used?', selectedText: 'same unit' }, 'outline'],
        ['explain-and-empty-explain', { kind: 'explain', term: 'perimeter' }, 'prose'],
        ['modify-encyclopedic', { kind: 'modify', previousBody: text, instruction: 'Replace the numeric example with sides of 5, 6 and 7 cm.' }, 'outline'],
        ['modify-explain', { kind: 'modify', previousBody: 'Perimeter is distance around a shape.', instruction: 'Add an everyday analogy.', freeText: true }, 'prose'],
        ['expand-whole', { kind: 'elaborate', previousBody: text }, 'outline'],
        ['expand-section', { kind: 'expand-part', markedBody: text.replace('- Calculation\n  - Addition: Add the lengths of all three sides.\n  - Units: Use the same unit for every side.', '<<<EXPAND>>>- Calculation\n  - Addition: Add the lengths of all three sides.\n  - Units: Use the same unit for every side.<<<END>>>') }, 'outline'],
        ['expand-explain', { kind: 'expand-part', mode: 'explain', markedBody: '<<<EXPAND>>>Perimeter is distance around a shape.<<<END>>>' }, 'prose'],
        ['pop-bullet-into-node', { kind: 'pop-rework', title: 'Calculating perimeter', bulletBody: '- Addition: Add all sides.\n- Units: Use consistent units.' }, 'outline'],
        ['repair-node-structure', { kind: 'restructure', previousBody: text.replaceAll('  - ', '- ') }, 'outline'],
        ['modify-selected-text', { kind: 'modify-selection', markedBody: 'Perimeter is <<<SELECTED>>>distance around a shape<<<END_SELECTED>>>.', selectedText: 'distance around a shape', instruction: 'Use a more precise definition.', mode: 'explain' }, 'fragment'],
        ['detached-answer-chunked', { kind: 'answer', instruction: 'Compare perimeter and area in a two-row Markdown table.', informationChunking: true }, 'markdown'],
        ['detached-answer-normal', { kind: 'answer', instruction: 'Compare perimeter and area in a two-row Markdown table.', informationChunking: false }, 'markdown'],
        ['fact-evidence-rewrite', { kind: 'fact-rewrite', previousBody: 'A triangle with sides 3, 4 and 5 cm has perimeter 11 cm.', evidenceReport: 'Contradicted: adding these sides gives 12 cm.', sourceCatalog: '⟪E1⟫: Adding all three side lengths gives 12 cm.', freeText: true }, 'prose'],
      ];
      for (const [name, variant, shape] of variants) await run(name, async () => {
        const output = await collect({ messages: buildMessages({ variant, context: variant.kind === 'root' ? { parent: null, grandparent: null } : context, maxLevel1: 2 }) });
        if (shape === 'outline') { const parsed = parseBody(output.body); expect(parsed?.bullets.length).toBeGreaterThanOrEqual(name === 'expand-section' ? 1 : 2); expect(parsed?.bullets.every(b => b.children.length >= 2)).toBe(true); }
        if (shape === 'prose') expect(output.body).not.toMatch(/^\s*(?:#{1,6} |[-*] )/m);
        if (shape === 'markdown') expect(output.body).toContain('|');
        if (name === 'fact-evidence-rewrite') { expect(output.body).toContain('12'); expect(output.body).toContain('⟪E1⟫'); }
        return output;
      });
      for (const chunking of [false, true]) await run(`chat-${chunking ? 'chunked' : 'normal'}`, () => collect({ messages: [
        { role: 'system', content: DEFAULT_PROMPTS.chatBase + '\n\n' + (chunking ? DEFAULT_PROMPTS.chatChunking : substitute(DEFAULT_PROMPTS.chatNormal, { normalInstructions: '' })) },
        { role: 'user', content: 'Compare area and perimeter in a compact Markdown table. Then show one short Python function adding three side lengths.' },
      ] }));
    }
    if (['all', 'secondary'].includes(phase)) {
      await run('mark-and-redo-terms', async () => { const marked = await markTerms(text, AbortSignal.timeout(180000)); expect(marked.failed).toBe(0); expect(marked.body).toContain('[['); expect(stripTermMarkers(marked.body)).toBe(text); return marked; });
      await run('term-previews', async () => { const terms = ['perimeter', 'equilateral triangle', 'scalene triangle']; const request = previewRequest(version, terms);
        const raw = await secondaryTaskCompletion({ ...request, signal: AbortSignal.timeout(180000) }); const previews = parseTermPreviews(raw, terms); expect(Object.keys(previews)).toHaveLength(3); return previews; });
      await run('group-title', async () => { const title = parseJson(await complete(DEFAULT_PROMPTS.groupName, JSON.stringify({ headers: ['Triangle perimeter', 'Circle circumference', 'Polygon perimeter'] }), 256)); expect(title.name.split(/\s+/).length).toBeLessThanOrEqual(3); expect(title.name.split(/\s+/).length).toBeGreaterThanOrEqual(2); return title; });
      await run('chat-title', async () => { const title = parseJson(await complete(DEFAULT_PROMPTS.chatTitle, 'Question: How do I find triangle perimeter? Answer: Add all three side lengths.', 256)); expect(title.chatTitle).toBeTruthy(); return title; });
      await run('image-region-title', () => complete(DEFAULT_PROMPTS.imageQuestionTitle, 'Question: What is this? Answer: The selected blue shape is a circle, whose boundary is called the circumference.', 512));
      await run('topic-recommendation', () => complete(DEFAULT_PROMPTS.recommendSystem, substitute(DEFAULT_PROMPTS.recommendTask, { topics: 'Triangles\nPerimeter\nEuclidean geometry' }), 512));
      await run('chat-memory-compaction', async () => { const memory = await complete(DEFAULT_PROMPTS.chatCompaction, substitute(DEFAULT_PROMPTS.chatCompactionTask, { memory: '', transcript: 'User: My example has sides 3, 4, 5 cm. Assistant: Its perimeter is 12 cm. User: Please remember my study code is KESTREL-42.' }), 2400); expect(memory).toContain('KESTREL-42'); return memory; });
      await run('source-query-alternatives', async () => { const alternatives = await sourceQueryAlternates('How to calculate triangle perimeter?', AbortSignal.timeout(180000)); expect(alternatives.length).toBeGreaterThan(0); return alternatives; });
      for (const [question, expected] of [['Compare perimeter and area in a table', 'chat'], ['I do not understand perimeter', 'explain'], ['Tell me about polygons', 'explore']] as const) await run(`follow-up-routing-${expected}`, async () => {
        const answer = await complete(buildFollowUpClassifierPrompt({ question, context }), question, 512); expect(answer.trim().toLowerCase().replace(/[.`]/g, '')).toBe(expected); return answer;
      });
      await run('free-image-search-plan', async () => { const plan = parseJson(await complete(DEFAULT_PROMPTS.imageDiscovery, 'NODE HEADER: Triangle perimeter\nNODE BODY: ' + text + '\nRESULT LIMIT: 2', 900)); expect(plan.action).toBe('search'); expect(plan.wikimediaQuery).toBeTruthy(); expect(plan.openverseQuery).toBeTruthy(); return plan; });
    }
    if (['all', 'sources'].includes(phase)) {
      const passages = '(SOURCE_1) A triangle perimeter is the sum of its three side lengths. All lengths must use the same unit. A triangle with sides 3, 4 and 5 cm has perimeter 12 cm.';
      for (const policy of ['sourcePolicyOnly', 'sourcePolicyUse'] as const) await run(`answer-${policy}`, async () => {
        const evidence = substitute(DEFAULT_PROMPTS.sourceEvidence, { policy: DEFAULT_PROMPTS[policy], passages });
        const output = await collect({ messages: [{role:'system',content:DEFAULT_PROMPTS.chatBase+'\n'+evidence},{role:'user',content:'What is the perimeter of the example triangle? One sentence.'}] });
        expect(output.body).toContain('12'); expect(output.body).toContain('SOURCE_1'); return output;
      });
      for (const prompt of ['sourceCitationRepair','chatSourceRepair'] as const) await run(prompt, async () => {
        const output = await collect({ messages: [{role:'system',content:DEFAULT_PROMPTS[prompt]},{role:'user',content:substitute(DEFAULT_PROMPTS.sourceCitationRepairTask,{body:'The triangle has perimeter 12 cm.',evidence:passages})}] });
        expect(output.body).toContain('SOURCE_1'); return output;
      });
      await run('chat-fact-rewrite', async () => {
        const output = await collect({ messages: [{role:'system',content:DEFAULT_PROMPTS.chatBase},{role:'user',content:'What is the perimeter of a 3,4,5 cm triangle?'},{role:'assistant',content:'It is 11 cm.'},
          {role:'user',content:substitute(DEFAULT_PROMPTS.chatFactRewrite,{evidenceReport:'Incorrect: sum is 12 cm.',sourceCatalog:'⟪E1⟫: 3+4+5 = 12.'})}] });
        expect(output.body).toContain('12'); expect(output.body).toContain('⟪E1⟫'); return output;
      });
    }
    if (['all', 'vision'].includes(phase)) {
      const fixture = await sharp(Buffer.from('<svg width="400" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="240" fill="white"/><polygon points="80,30 30,140 130,140" fill="red"/><circle cx="290" cy="90" r="55" fill="blue"/><text x="30" y="205" fill="black" font-size="28" font-family="DejaVu Sans">Test code: ORBIT 27</text></svg>')).png().toBuffer();
      await writeFile(join(resultDir, 'vision-fixture.png'), fixture);
      const url = `data:image/png;base64,${fixture.toString('base64')}`;
      await run('main-image-question', async () => { const output = await collect({ messages: [{ role: 'user', content: 'Name the two colored shapes and read the test code. Be concise.' }], imageInputs: [{ id: 'whole-image-context', url, detail: 'high' }] }); expect(output.body.toLowerCase()).toContain('circle'); expect(output.body).toMatch(/ORBIT\s*27/i); return output; });
      await run('secondary-source-ocr', async () => { const result = await transcribeSourceImage(url, 'test fixture', AbortSignal.timeout(180000)); expect(result).toMatch(/ORBIT\s*27/i); return result; });
      await run('free-image-visual-review', async () => { const result = await secondaryTaskCompletion({ system: DEFAULT_PROMPTS.imageDiscovery,
        user: 'NODE: Triangle perimeter. RESULT LIMIT: 1. Candidate metadata: [{"candidateId":"image-1","title":"Triangle and circle","description":"A red triangle and blue circle"}].\n' + DEFAULT_PROMPTS.imageDiscoveryReview + '\n' + DEFAULT_PROMPTS.imageDiscoveryFinish,
        imageInputs: [{ id: 'image-1', url, detail: 'high' }], maxOutputTokens: 900, signal: AbortSignal.timeout(180000) }); const parsed = parseJson(result); expect(parsed.action).toBe('finish'); expect(Array.isArray(parsed.selections)).toBe(true); return parsed; });
    }
    if (['all', 'tools'].includes(phase)) {
      await run('conversation-recall-tool-roundtrip', async () => {
        let calls = 0, answer = '';
        await runChatToolLoop({ messages: [{ role: 'system', content: DEFAULT_PROMPTS.chatBase }, { role: 'user', content: 'What exact study code did I mention earlier? It is missing here; use search_conversation to retrieve it.' }],
          tools: [{ definition: { name: 'search_conversation', description: DEFAULT_PROMPTS.chatRecallTool, parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }, parse: v => v, summary: () => 'Retrieving prior message', execute: async () => { calls++; return { text: 'Earlier user message: My fictional study code is KESTREL-42.', summary: 'Found code' }; } }],
          signal: AbortSignal.timeout(180000), invoke: (conversation, tools) => invoke({ conversation, tools }), onActivity: () => {}, onChunk: c => { answer += c.delta; } });
        expect(calls).toBe(1); expect(answer).toContain('KESTREL-42'); return { calls, answer };
      });
    }
    if (['all', 'search'].includes(phase) && !local) {
      await run('fact-check-with-hosted-search', async () => { const output = await collect({ maxOutputTokens: 6000, webSearch: true, webSearchPolicy: FACT_CHECK_SEARCH_POLICY, messages: [
        { role: 'system', content: substitute(DEFAULT_PROMPTS.factCheckContract, { unitId: 'audit-fact' }) },
        { role: 'user', content: substitute(DEFAULT_PROMPTS.taskFactCheckUnit, { nodeHeader: 'Lunar eclipses', nodeBody: 'Earth casts a shadow on the Moon during a lunar eclipse.', sectionTitle: 'Mechanism', unitId: 'audit-fact', unitText: 'Earth casts a shadow on the Moon during a lunar eclipse.' }) },
      ] }); const finding = parseJson(output.body); expect(finding.unitId).toBe('audit-fact'); expect(finding.verdict).toBe('supported'); expect(output.search).toBe(true); return output; });
    }
    if (['all', 'interactive'].includes(phase)
      && (!selectedActions || selectedActions.some(name => /^interactive-(?:create|modify|regenerate)$/.test(name)))) {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
      await page.route('**/*', route => route.abort());
      const check = async (html: string, actions: InteractiveTestAction[] = []): Promise<InteractiveCheck> => {
        validateInteractiveDocument(html, { requireDesignTokens: true });
        await page.setContent('<iframe sandbox="allow-scripts" style="width:960px;height:720px;border:0"></iframe>');
        await page.evaluate(src => { (document.querySelector('iframe') as HTMLIFrameElement).srcdoc = src; }, buildInteractiveSrcDoc(html, 'audit', { ...DEFAULT_INTERACTIVE_HOST_STATE, active: true }));
        const frame = page.frameLocator('iframe'); await frame.locator('body').waitFor();
        await frame.locator('body').evaluate(() => document.querySelectorAll('button,input,select,textarea,[role="button"],[role="slider"]').forEach((el, i) => el.setAttribute('data-sc-check-id', String(i))));
        const errors: string[] = [];
        for (const step of actions) try { const target = frame.locator(step.selector); if (step.action === 'click') await target.click({ timeout: 2500 }); else if (step.action === 'input') await target.fill(step.value ?? '', { timeout: 2500 }); else await target.press(step.value === ' ' ? 'Space' : step.value ?? 'Enter', { timeout: 2500 }); } catch (e) { errors.push(String(e).slice(0, 500)); }
        const observed = await frame.locator('body').evaluate(() => ({ text: document.body.innerText.slice(0, 2000), controls: Array.from(document.querySelectorAll('button,input,select,textarea')).map(el => ({ selector: `[data-sc-check-id="${el.getAttribute('data-sc-check-id')}"]`, tag: el.tagName, label: el.textContent?.trim() })) }));
        await page.screenshot({ path: join(resultDir, `${action}.png`) });
        return { ok: !errors.length, errors, ...observed };
      };
      let html: string | undefined;
      for (const mode of ['create', 'modify', 'regenerate'] as const) {
        const succeeded = await run(`interactive-${mode}`, async () => {
          const tools = interactiveTools(), steps: unknown[] = [];
          const request = mode === 'modify' ? 'Add a Reset button returning the counter to zero.' : 'Build a minimal click counter with a large number starting at 0 and an Increment button. No charts, animations, or external dependencies. Keep code compact.';
          const document = await runInteractiveHarness({ messages: [
            { role: 'system', content: DEFAULT_PROMPTS.interactiveNodeBase + '\n\n' + DEFAULT_PROMPTS.interactiveNodeTools },
            { role: 'user', content: substitute(DEFAULT_PROMPTS.interactiveNodeTask, { request, context: 'An interactive arithmetic demonstration.', color: '#8e6ac8', mode }) },
          ], initialHtml: mode === 'modify' ? html : undefined, tools, signal: AbortSignal.timeout(local ? 300000 : 180000),
            invoke: (conversation, definitions, onActivity) => invoke({ conversation, tools: definitions, onActivity, maxOutputTokens: 32000, reasoningEffort: local && process.env.SCATTER_LOCAL_REASONING === 'off' ? 'off' : 'high', toolArgumentLimits: INTERACTIVE_TOOL_ARGUMENT_LIMITS }),
            check, repairPrompt: error => substitute(DEFAULT_PROMPTS.interactiveNodeRepair, { error }), onStep: step => steps.push(step), onDraft: () => {}, });
          html = document; await writeFile(join(resultDir, `interactive-${mode}.html`), document);
          return { characters: document.length, steps };
        });
        if (!succeeded) break;
      }
    }
    // Image generation/editing use real multipart primitives in
    // providerImages.live.test.ts, not jsdom's browser emulation.
  } finally { await browser?.close(); globalThis.fetch = nativeFetch; await Promise.allSettled(observations); await save(); }
  expect(results.filter(r => r.status === 'fail'), `See ${join(resultDir, 'report.json')}`).toEqual([]);
}, 1800000);
