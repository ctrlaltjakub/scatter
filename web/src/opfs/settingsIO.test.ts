import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings } from './settingsIO';
import { DEFAULT_SETTINGS } from '@/store/types';
import { PROMPT_KEYS } from '@/lib/promptCatalog';
import { CURRENT_ADVANCED_DEFAULTS } from '@/lib/advancedSettingsDefaults';
import { customFontFixture } from '@/test/customFontFixture';

class MockFile { contents = ''; async getFile() { return { text: async () => this.contents }; }
  async createWritable() { return { write: async (s: string) => { this.contents = s; }, close: async () => {} }; } }
class MockDir {
  files = new Map<string, MockFile>(); dirs = new Map<string, MockDir>();
  async getFileHandle(n: string, o?: { create?: boolean }) {
    if (!this.files.has(n)) { if (!o?.create) throw new DOMException('NotFound','NotFoundError'); this.files.set(n, new MockFile()); }
    return this.files.get(n)!;
  }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    if (!this.dirs.has(n)) { if (!o?.create) throw new DOMException('NotFound','NotFoundError'); this.dirs.set(n, new MockDir()); }
    return this.dirs.get(n)!;
  }
}

beforeEach(() => {
  const root = new MockDir();
  // @ts-expect-error mocking
  globalThis.navigator = { storage: { getDirectory: async () => root } };
});

describe('settingsIO', () => {
  it('persists custom font bytes and the selected font across a restart', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, customNodeFonts: [customFontFixture], nodeFontId: customFontFixture.id });
    expect(await loadSettings()).toMatchObject({ customNodeFonts: [customFontFixture], nodeFontId: customFontFixture.id });
  });
  it('persists explicit per-role compatibility overrides and rejects malformed opt-ins', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, modelCompatibilityOverrides: { main: true, image: true } });
    expect((await loadSettings()).modelCompatibilityOverrides).toEqual({ main: true, image: true });
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], modelCompatibilityOverrides: { main: 'true', secondary: 1, interactive: true, image: false, other: true } });
    expect((await loadSettings()).modelCompatibilityOverrides).toEqual({ interactive: true });
    await writeJSON('settings.json', { providers: [] });
    expect((await loadSettings()).modelCompatibilityOverrides).toEqual({});
  });
  it('round-trips intentional lower token limits and both additional task budgets', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, outputTokenCap: 8000, secondaryOutputTokenCap: 18000, interactiveOutputTokenCap: 64000 });
    expect(await loadSettings()).toMatchObject({ generationLimitsVersion: 1, outputTokenCap: 8000, secondaryOutputTokenCap: 18000, interactiveOutputTokenCap: 64000 });
  });
  it('round-trips per-role recommendation preferences and their managed slots', async () => {
    const modelRecommendations = { ...DEFAULT_SETTINGS.modelRecommendations!,
      main: { autoUpdate: true, ref: { providerId: 'or', model: 'google/gemini-3.8-flash' }, version: '2026-10-02' },
      secondary: { autoUpdate: false },
    };
    await saveSettings({ ...DEFAULT_SETTINGS, modelRecommendations });
    expect((await loadSettings()).modelRecommendations).toEqual(modelRecommendations);
  });
  it('defaults previews on and image search off, preserving saved choices', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [] });
    expect(await loadSettings()).toMatchObject({ autoTermPreviews: true, autoFreeImages: false, defaultChatInformationChunking: true });
    await saveSettings({ ...DEFAULT_SETTINGS, autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false });
    expect(await loadSettings()).toMatchObject({ autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false });
    await writeJSON('settings.json', { providers: [], autoTermPreviews: 'false', autoFreeImages: null });
    expect(await loadSettings()).toMatchObject({ autoTermPreviews: true, autoFreeImages: false });
    await saveSettings({ ...DEFAULT_SETTINGS, autoFreeImages: true });
    expect((await loadSettings()).autoFreeImages).toBe(true);
  });
  it('round-trips every catalog prompt, including chat and both previously omitted fact-check prompts', async () => {
    const customPrompts = Object.fromEntries(PROMPT_KEYS.map(key => [key, `Custom ${key}`]));
    await saveSettings({ ...DEFAULT_SETTINGS, customPrompts });
    expect((await loadSettings()).customPrompts).toEqual(customPrompts);
  });
  it('round-trips named connections and independent reasoning preferences', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, reasoningEffort: 'low', interactiveReasoningEffort: 'xhigh',
      providers: [{ id: 'local', preset: 'custom', name: 'Home server', apiKey: 'test', enabledModels: [], webSearchEndpoint: 'https://search.test' }],
    });
    const loaded = await loadSettings();
    expect(loaded.providers[0]?.name).toBe('Home server');
    expect(loaded.providers[0]?.webSearchEndpoint).toBe('https://search.test');
    expect(loaded.reasoningEffort).toBe('low');
    expect(loaded.interactiveReasoningEffort).toBe('xhigh');
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], interactiveReasoningEffort: 'bogus' });
    expect((await loadSettings()).interactiveReasoningEffort).toBe('high');
  });
  it('preserves each server-managed search profile across settings export/import normalization', async () => {
    const profiles = [
      { kind: 'lmstudio-mcp' as const, server: 'search', tools: ['searxng_web_search'] },
      { kind: 'responses-mcp' as const, url: 'https://search.test/mcp', tools: ['search'] },
      { kind: 'localai' as const, servers: ['search'] },
    ];
    for (const serverSearch of profiles) {
      await saveSettings({ ...DEFAULT_SETTINGS, providers: [{ id: 'local', preset: 'custom', apiKey: 'test', enabledModels: [], serverSearch }] });
      expect((await loadSettings()).providers[0]?.serverSearch).toEqual(serverSearch);
    }
  });
  it('persists cross-provider model order and removes duplicate or deleted choices on load', async () => {
    const providers = [
      { id: 'a', preset: 'openai' as const, apiKey: 'test', enabledModels: ['gpt-5.6-luna'] },
      { id: 'b', preset: 'anthropic' as const, apiKey: 'test', enabledModels: ['claude-sonnet-4-6'] },
    ];
    const order = [{ providerId: 'a', model: 'gpt-5.6-luna' }, { providerId: 'b', model: 'claude-sonnet-4-6' }];
    await saveSettings({ ...DEFAULT_SETTINGS, providers, mainModelOrder: [...order, order[0]!, { providerId: 'gone', model: 'missing' }] });
    expect((await loadSettings()).mainModelOrder).toEqual(order);
  });
  it('returns defaults when nothing saved', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect((await loadSettings()).webSearch).toBe(true);
  });
  it('preserves native Gemini assignments when settings are saved and reloaded', async () => {
    const ref = { providerId: 'google', model: 'gemini-3.8-flash' };
    await saveSettings({ ...DEFAULT_SETTINGS, providers: [{ id: 'google', preset: 'gemini', apiKey: 'test-only', enabledModels: [ref.model] }], activeModelRef: ref });
    const loaded = await loadSettings();
    expect(loaded.providers[0]?.preset).toBe('gemini');
    expect(loaded.activeModelRef).toEqual(ref);
  });
  it('persists and reloads custom settings', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      providers: [
        { id: 'p1', preset: 'openai' as const, apiKey: 'sk-123', enabledModels: ['gpt-5.5'] },
      ],
      activeModelRef: { providerId: 'p1', model: 'gpt-5.5' },
      imageModelRef: { providerId: 'p1', model: 'gpt-image-2' },
      webSearch: true, // global per-generation toggle round-trips
    };
    await saveSettings(custom);
    expect(await loadSettings()).toEqual(custom);
  });
  it('defaults web search on when an older file lacks it', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).webSearch).toBe(true);
  });
  it('uses the web-search default when the saved value is invalid', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], webSearch: null });
    expect((await loadSettings()).webSearch).toBe(true);
  });
  it.each([false, true])('preserves an explicit web-search choice of %s', async webSearch => {
    await saveSettings({ ...DEFAULT_SETTINGS, webSearch });
    expect((await loadSettings()).webSearch).toBe(webSearch);
  });
  it('round-trips selection searches and validates older or corrupt settings', async () => {
    const { writeJSON } = await import('./storage');
    const selectionWebSearch = { engineId: 'custom-local', customEngines: [
      { id: 'custom-local', name: 'My search', urlTemplate: 'http://localhost:8888/search?q={query}' },
    ] };
    await saveSettings({ ...DEFAULT_SETTINGS, selectionWebSearch });
    expect((await loadSettings()).selectionWebSearch).toEqual(selectionWebSearch);
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).selectionWebSearch).toEqual({ engineId: 'google', customEngines: [] });
    await writeJSON('settings.json', { ...DEFAULT_SETTINGS, selectionWebSearch: {
      engineId: 'custom-unsafe', customEngines: [{ id: 'custom-unsafe', name: 'Unsafe', urlTemplate: 'javascript:{query}' }],
    } });
    expect((await loadSettings()).selectionWebSearch).toEqual({ engineId: 'google', customEngines: [] });
  });
  it('persists a node font and repairs missing or invalid font ids', async () => {
    const { writeJSON } = await import('./storage');
    await saveSettings({ ...DEFAULT_SETTINGS, nodeFontId: 'merriweather' });
    expect((await loadSettings()).nodeFontId).toBe('merriweather');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).nodeFontId).toBe('app');
    await writeJSON('settings.json', { providers: [], activeModelRef: null, nodeFontId: 'not-a-font' });
    expect((await loadSettings()).nodeFontId).toBe('app');
    await writeJSON('settings.json', { providers: [], activeModelRef: null, nodeFontId: 'press-start' });
    expect((await loadSettings()).nodeFontId).toBe('app');
  });
  it('migrates existing installs to fast-start OpenRouter routing', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).openRouterRouting).toBe('fast-start');
  });
  it('round-trips an explicit cheapest-provider preference', async () => {
    const custom = { ...DEFAULT_SETTINGS, openRouterRouting: 'lowest-cost' as const };
    await saveSettings(custom);
    expect((await loadSettings()).openRouterRouting).toBe('lowest-cost');
  });
  it('defaults older files to hierarchy-aware group colors', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).groupColorAssignment).toBe('hierarchy-aware');
  });
  it('round-trips the hierarchy-aware group color preference', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      groupColorAssignment: 'hierarchy-aware' as const,
    };
    await saveSettings(custom);
    expect((await loadSettings()).groupColorAssignment).toBe('hierarchy-aware');
  });
  it('preserves a saved golden-angle group color preference', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      groupColorAssignment: 'golden-angle' as const,
    };
    await saveSettings(custom);
    expect((await loadSettings()).groupColorAssignment).toBe('golden-angle');
  });
  it('preserves a saved opposites group color preference', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      groupColorAssignment: 'opposites' as const,
    };
    await saveSettings(custom);
    expect((await loadSettings()).groupColorAssignment).toBe('opposites');
  });
  it('round-trips the dedicated secondary-task model settings', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      secondaryUseSameModel: false,
      secondaryModelRef: { providerId: 'p1', model: 'haiku' },
    };
    await saveSettings(custom);
    const loaded = await loadSettings();
    expect(loaded.secondaryUseSameModel).toBe(false);
    expect(loaded.secondaryModelRef).toEqual({ providerId: 'p1', model: 'haiku' });
  });
  it('round-trips a dedicated interactive-explanation model', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      interactiveModelRef: { providerId: 'p1', model: 'gpt-5.6-terra' },
    };
    await saveSettings(custom);
    expect((await loadSettings()).interactiveModelRef).toEqual(custom.interactiveModelRef);
  });
  it('round-trips image model and generation controls', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      imageModelRef: { providerId: 'p1', model: 'gpt-image-2' },
      imageGenerationSettings: {
        ...DEFAULT_SETTINGS.imageGenerationSettings,
        quality: 'medium' as const,
        size: 'custom',
        customWidth: 2048,
        customHeight: 1024,
      },
    };
    await saveSettings(custom);
    const loaded = await loadSettings();
    expect(loaded.imageModelRef).toEqual(custom.imageModelRef);
    expect(loaded.imageGenerationSettings).toEqual(custom.imageGenerationSettings);
  });
  it('round-trips an explicit None image-model choice', async () => {
    const custom = { ...DEFAULT_SETTINGS, imageModelRef: null };
    await saveSettings(custom);
    expect((await loadSettings()).imageModelRef).toBeNull();
  });
  it('gives pre-image-generation OpenAI users the GPT Image 2 default', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      providers: [{ id: 'old-openai', preset: 'openai', apiKey: 'sk-old', enabledModels: ['gpt-5'] }],
      activeModelRef: { providerId: 'old-openai', model: 'gpt-5' },
    });
    expect((await loadSettings()).imageModelRef).toEqual({
      providerId: 'old-openai',
      model: 'gpt-image-2',
    });
  });
  it('gives pre-image-generation OpenRouter users its GPT Image 2 route', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      providers: [{ id: 'old-router', preset: 'openrouter', apiKey: 'sk-old', enabledModels: ['google/gemini'] }],
      activeModelRef: { providerId: 'old-router', model: 'google/gemini' },
    });
    expect((await loadSettings()).imageModelRef).toEqual({
      providerId: 'old-router',
      model: 'openai/gpt-image-2',
    });
  });
  it('defaults secondaryUseSameModel=true for older files without dedicated models', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    const loaded = await loadSettings();
    expect(loaded.secondaryUseSameModel).toBe(true);
    expect(loaded.secondaryModelRef).toBeUndefined();
  });
  it('migrates the legacy routing model into the shared secondary-task model', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      providers: [{ id: 'p1', preset: 'openrouter', apiKey: 'key', enabledModels: ['router'] }],
      activeModelRef: { providerId: 'p1', model: 'main' },
      routingUseSameModel: false,
      routingModelRef: { providerId: 'p1', model: 'router' },
      chipUseSameModel: true,
    });
    const loaded = await loadSettings();
    expect(loaded.secondaryUseSameModel).toBe(false);
    expect(loaded.secondaryModelRef).toEqual({ providerId: 'p1', model: 'router' });
  });
  it('round-trips sentencePerLine=true', async () => {
    const custom = { ...DEFAULT_SETTINGS, sentencePerLine: true };
    await saveSettings(custom);
    expect((await loadSettings()).sentencePerLine).toBe(true);
  });
  it('defaults sentencePerLine=true for older files lacking it', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).sentencePerLine).toBe(true);
  });
  it('round-trips justifyParagraph=false', async () => {
    const custom = { ...DEFAULT_SETTINGS, justifyParagraph: false };
    await saveSettings(custom);
    expect((await loadSettings()).justifyParagraph).toBe(false);
  });
  it('defaults justifyParagraph=true for older files lacking it', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null });
    expect((await loadSettings()).justifyParagraph).toBe(true);
  });
  it('persists the new chip-marking prompt overrides', async () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
      customPrompts: { chipBase: 'CB', taskAddChips: 'TAC {plainBody}' },
    };
    await saveSettings(custom);
    expect((await loadSettings()).customPrompts).toEqual({ chipBase: 'CB', taskAddChips: 'TAC {plainBody}' });
  });
  it('migrates legacy flat settings to the multi-provider shape', async () => {
    // Manually write the oldest (flat) shape via the underlying writeJSON.
    const { writeJSON } = await import('./storage');
    // Unversioned developer overrides reset; credentials and normal preferences survive.
    await writeJSON('settings.json', { apiKey: 'sk-old', selectedModel: 'gpt-old', outputTokenCap: 20000, inputTokenCap: 4000 });
    const loaded = await loadSettings();
    expect(loaded.providers).toHaveLength(1);
    const acct = loaded.providers[0]!;
    expect(acct.apiKey).toBe('sk-old');
    expect(acct.preset).toBe('openai');
    expect(acct.enabledModels).toEqual(['gpt-old']);
    expect(loaded.activeModelRef).toEqual({ providerId: acct.id, model: 'gpt-old' });
    expect(loaded.outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap);
    expect(loaded.inputTokenCap).toBe(4000);
  });
  it('upgrades the old 8k output ceiling to leave room for hidden reasoning', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', { providers: [], activeModelRef: null, outputTokenCap: 8000 });
    expect((await loadSettings()).outputTokenCap).toBe(16_000);
  });
  it('migrates the single textProvider shape to providers[]', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'anthropic', apiKey: 'sk-ant', selectedModel: 'claude-x', webSearch: true },
      physicsSnapshots: [],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    expect(loaded.providers).toHaveLength(1);
    const acct = loaded.providers[0]!;
    expect(acct.preset).toBe('anthropic');
    expect(acct.apiKey).toBe('sk-ant');
    expect(acct.enabledModels).toEqual(['claude-x']);
    expect(loaded.activeModelRef).toEqual({ providerId: acct.id, model: 'claude-x' });
  });

  it('migrates legacy settings without physics/prompt fields', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      outputTokenCap: 1500,
    });
    const loaded = await loadSettings();
    expect(loaded).not.toHaveProperty('physicsSnapshots');
    expect(loaded).not.toHaveProperty('promptSnapshots');
    expect(loaded.physicsConfig).toBeUndefined();
  });

  it('clamps out-of-range physicsConfig on load', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
      physicsConfig: { linkDistance: 99999 },
      physicsSnapshots: [],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    // linkDistance max is 800 per PHYSICS_FIELD_RANGES (border-distance)
    expect(loaded.physicsConfig?.linkDistance).toBe(800);
  });



  it('drops stale physics config keys (e.g. removed ropeAnchorMidpointStrength)', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      // The old shape included ropeAnchorMidpointStrength (single-anchor
      // model), then chainSpringStrength (d3-spring), then Verlet PBD
      // (ropeIterations + chainTension), then geometric routing
      // (ropeMargin). At each migration, stale keys must be silently
      // dropped — `clampPhysicsConfig` constructs from defaults and only
      // copies known fields.
      advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
      physicsConfig: {
        linkDistance: 800,
        ropeAnchorMidpointStrength: 0.5,
      },
      physicsSnapshots: [
        {
          id: 'old-snap', savedAt: '2026-01-01T00:00:00Z',
          config: { linkDistance: 750, ropeAnchorMidpointStrength: 0.7 },
        },
      ],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    expect(loaded.physicsConfig?.linkDistance).toBe(800);
    expect((loaded.physicsConfig as Record<string, unknown> | undefined)?.ropeAnchorMidpointStrength).toBeUndefined();
    expect(loaded).not.toHaveProperty('physicsSnapshots');
  });

  it('strips non-string keys from customPrompts on load', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
      customPrompts: { base: 'hello', taskRoot: 42, unknown: 'ignored' },
      physicsSnapshots: [],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    expect(loaded.customPrompts).toEqual({ base: 'hello' });
  });

  it('sets customPrompts to undefined when no valid string keys remain', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      advancedDefaults: CURRENT_ADVANCED_DEFAULTS,
      customPrompts: { base: 123, taskRoot: null },
      physicsSnapshots: [],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    expect(loaded.customPrompts).toBeUndefined();
  });

  it('persists customColors and filters non-hex / non-string entries on load', async () => {
    const { writeJSON } = await import('./storage');
    await writeJSON('settings.json', {
      textProvider: { preset: 'openai', apiKey: '', selectedModel: '' },
      customColors: ['#a3c1ff', '#fff', 'mauve', 123, '#zzz', null],
      physicsSnapshots: [],
      promptSnapshots: [],
    });
    const loaded = await loadSettings();
    expect(loaded.customColors).toEqual(['#a3c1ff', '#fff']);
  });

  it('round-trips saved customColors', async () => {
    const custom = { ...DEFAULT_SETTINGS, customColors: ['#112233', '#abc'] };
    await saveSettings(custom);
    expect((await loadSettings()).customColors).toEqual(['#112233', '#abc']);
  });
});
