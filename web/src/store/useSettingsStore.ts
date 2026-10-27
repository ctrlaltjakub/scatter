import { create } from 'zustand';
import { readOnboardingSession } from '@/lib/onboardingSession';
import { normalizeGenerationLimit, type GenerationLimitKey } from '@/lib/generationLimits';
import { DEFAULT_SETTINGS, type Settings, type ProviderAccount, type ProviderPreset, type ReasoningEffort, type OpenRouterRoutingPreference, type PhysicsConfig, type BulletSizingConfig, type CustomPrompts, type KeyBinding, type ImageGenerationSettings, type GroupColorAssignment } from './types';
import { isSingleConnectionProvider, listSwitchableModels } from './providerSelectors';
import { loadSettings, saveSettings, normalizeSettings } from '@/opfs/settingsIO';
import { debounce } from '@/lib/debounce';
import { newId } from '@/lib/ids';
import { CURRENT_ADVANCED_DEFAULTS } from '@/lib/advancedSettingsDefaults';
import { settingsSnapshot } from './settingsSnapshot';
import { mainModelCompatible } from '@/lib/modelMeta';
import { useModelCatalogStore } from './useModelCatalogStore';
import { normalizeSelectionWebSearch } from '@/lib/selectionWebSearch';
import { manualModelChoice, planRecommendedModels, MODEL_ROLES, modelUpdatePreferences } from '@/lib/recommendedModels';
import type { ModelRole } from './types';
import { useImageModelCatalogStore } from './useImageModelCatalogStore';
import type { ModelInfo, ImageModelInfo } from '@/providers/types';
import { appendCustomNodeFont, type CustomNodeFont } from '@/lib/customNodeFonts';
import { isKnownFontId } from '@/lib/imageEditFonts';

interface SettingsState extends Settings {
  setModelCompatibilityOverride: (role: ModelRole, enabled: boolean) => void;
  setModelAutoUpdate: (role: ModelRole, enabled: boolean) => void;
  setAllModelAutoUpdates: (enabled: boolean) => void;
  setGenerationTokenLimit: (key: GenerationLimitKey, value: number) => void;
  applyRecommendedModels: (providerId: string, enroll?: boolean, verified?: { text: ModelInfo[]; images: ImageModelInfo[] }) => ModelRole[];
  setAutoTermPreviews: (v: boolean) => void;
  setDefaultChatInformationChunking: (v: boolean) => void;
  setAutoFreeImages: (v: boolean) => void;
  setSyncApiKeys: (v: boolean) => void;
  setCameraAutoPan: (key: keyof Settings['cameraAutoPan'], value: boolean) => void;
  hydrated: boolean;
  /**
   * Ephemeral UI flag — when true, the welcome screen is shown even if the
   * user already has a valid apiKey + selectedModel. Used by the Dev tab's
   * "Back to start screen" option. Not persisted to OPFS.
   */
  forceWelcomeA: boolean;
  /**
   * Dev overlay. When non-'off', draws a semi-transparent pixel-
   * measuring grid (100 px major lines + numeric labels, 10 px minor
   * lines). Two attachment modes:
   *   - 'viewport': grid is fixed to the browser viewport. Does NOT
   *     scale with canvas zoom — labels stay readable but they measure
   *     viewport pixels, not canvas coordinates.
   *   - 'canvas': grid lives inside the canvas-world and pans/zooms
   *     with everything else. Labels measure canvas-coordinate pixels.
   *     At deep zooms the grid spacing shrinks/grows visually but the
   *     label numbers remain canvas pixels (so a node that's 624 px
   *     wide always spans 624 grid-pixels regardless of zoom).
   * Not persisted.
   */
  pixelRulerMode: 'off' | 'viewport' | 'canvas';
  /**
   * Ephemeral dev flag — when true, the interactive-background chooser behaves as
   * if WebGL2 were unavailable, so the "interactive background off" notice can be
   * previewed on hardware that supports WebGL2. Not persisted (resets on reload).
   */
  simulateWebglFailure: boolean;
  hydrate: () => Promise<void>;
  /** Replace every persisted setting in one commit (settings-file import). */
  replaceSettings: (settings: Settings) => Promise<void>;
  /** Add a new (empty) provider account and return its id. */
  addProvider: (preset: ProviderPreset) => string;
  removeProvider: (id: string) => void;
  /** Patch any editable field of a provider account (key, baseUrl, preset,
   *  webSearch, enabledModels). */
  updateProvider: (id: string, patch: Partial<Omit<ProviderAccount, 'id'>>) => void;
  /** Set which models a provider exposes to the switcher, keeping the active
   *  model valid. */
  setEnabledModels: (id: string, models: string[]) => void;
  setMainModelOrder: (models: NonNullable<Settings['mainModelOrder']>) => void;
  clearSecondaryModel: () => void;
  setActiveModel: (providerId: string, model: string) => void;
  setImageModel: (providerId: string, model: string) => void;
  setImageModelNone: () => void;
  setImageGenerationSettings: (patch: Partial<ImageGenerationSettings>) => void;
  /** Advance the active model through the flat switchable list (+1 next, -1 prev). */
  cycleModel: (dir: 1 | -1) => void;
  /** Global per-generation web-search toggle. */
  setWebSearch: (v: boolean) => void;
  setGenerationLanguage: (v: import('@/lib/languages').GenerationLanguage) => void;
  setSelectionWebSearch: (value: Settings['selectionWebSearch']) => void;
  /** OpenRouter provider ordering: fastest first text or cheapest endpoint. */
  setOpenRouterRouting: (v: OpenRouterRoutingPreference) => void;
  /** How hard the generation model reasons (Off/Low/Medium/High). */
  setReasoningEffort: (v: ReasoningEffort) => void;
  setInteractiveReasoningEffort: (v: ReasoningEffort) => void;
  /** Show authored prose line breaks in encyclopedic/explain nodes. */
  setSentencePerLine: (v: boolean) => void;
  setNodeFontId: (id: string) => void;
  addCustomNodeFont: (font: CustomNodeFont) => void;
  renameCustomNodeFont: (id: string, name: string) => void;
  removeCustomNodeFont: (id: string) => void;
  setNormalChatInstructions: (v: string) => void;
  /** Justify the node's opening paragraph (vs. left-align). */
  setJustifyParagraph: (v: boolean) => void;
  /** Follow-up box: plain Enter sends (true) vs. inserts a newline (false). */
  setFollowUpEnterSends: (v: boolean) => void;
  setGroupColorAssignment: (v: GroupColorAssignment) => void;
  /** Hue rotation (degrees) for UI accents (arrows, resize handles) off the group color. */
  setAccentHueShift: (v: number) => void;
  /** Desaturation amount (% points) for those accents. */
  setAccentDesaturate: (v: number) => void;
  /** Uniform darkening (lightness % points) for those accents. */
  setAccentDarken: (v: number) => void;
  /** Dedicated model shared by routing, term marking, and free-image discovery. */
  setSecondaryModel: (providerId: string, model: string) => void;
  setSecondaryUseSameModel: (v: boolean) => void;
  setInteractiveModel: (providerId: string, model: string) => void;
  setInteractiveModelAuto: () => void;
  setForceWelcomeA: (v: boolean) => void;
  setPixelRulerMode: (mode: 'off' | 'viewport' | 'canvas') => void;
  setSimulateWebglFailure: (v: boolean) => void;

  setPhysicsConfig: (patch: Partial<PhysicsConfig>) => void;
  resetPhysicsConfig: () => void;

  setBulletSizingConfig: (patch: Partial<BulletSizingConfig>) => void;
  resetBulletSizingConfig: () => void;

  setCustomPromptField: (field: keyof CustomPrompts, value: string) => void;
  resetCustomPromptField: (field: keyof CustomPrompts) => void;
  resetAllCustomPrompts: () => void;

  /** Custom group colors (hex). Built-in accents are not stored here. */
  addCustomColor: (hex: string) => void;
  removeCustomColor: (hex: string) => void;

  /** Keyboard shortcut overrides (by action id — see lib/keymap.ts). Each
   *  action may have up to 2 bindings; passing [] clears the override. */
  setActionBindings: (id: string, bindings: KeyBinding[]) => void;
  resetKeybinding: (id: string) => void;
  resetAllKeybindings: () => void;

  /** Recently-explored topic history (typed-query convenience list). `pushTopic`
   *  prepends + dedupes + caps; `removeTopic` forgets one entry. Independent of
   *  projects — neither touches project data. */
  pushTopic: (topic: string) => void;
  removeTopic: (topic: string) => void;
  clearTopicHistory: () => void;
  pushChatStart: (prompt: string) => void;
  removeChatStart: (prompt: string) => void;
  clearChatStartHistory: () => void;
}

/** Cap on stored recently-explored topics. */
const TOPIC_HISTORY_MAX = 50;

const persist = debounce((s: unknown) => { void saveSettings(s as Settings); }, 300);

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_SETTINGS,
  setModelCompatibilityOverride: (role, enabled) => {
    // A model-configuration preference, not a canvas content edit: no undo entry.
    set(s => ({ modelCompatibilityOverrides: { ...s.modelCompatibilityOverrides, [role]: enabled } }));
    persist(settingsSnapshot(get()));
  },
  setGenerationTokenLimit: (key, value) => {
    set(s => ({ [key]: normalizeGenerationLimit(key, value), generationLimitsVersion: 1,
      advancedDefaults: { ...s.advancedDefaults, generationLimits: CURRENT_ADVANCED_DEFAULTS.generationLimits } }));
    persist(settingsSnapshot(get()));
  },
  setAllModelAutoUpdates: (enabled) => {
    set({ modelRecommendations: modelUpdatePreferences(get(), MODEL_ROLES, enabled) });
    persist(settingsSnapshot(get()));
  },
  setModelAutoUpdate: (role, enabled) => {
    set({ modelRecommendations: modelUpdatePreferences(get(), [role], enabled) });
    persist(settingsSnapshot(get()));
  },
  applyRecommendedModels: (providerId, enroll = false, verified) => {
    const plan = planRecommendedModels(get(), providerId,
      verified?.text ?? useModelCatalogStore.getState().catalog[providerId] ?? [],
      verified?.images ?? useImageModelCatalogStore.getState().catalog[providerId] ?? [], enroll);
    if (plan.settings !== get()) { set(plan.settings); persist(settingsSnapshot(get())); }
    return plan.changed;
  },
  setAutoTermPreviews: (v) => { set({ autoTermPreviews: v }); persist(settingsSnapshot(get())); },
  setDefaultChatInformationChunking: (v) => { set({ defaultChatInformationChunking: v }); persist(settingsSnapshot(get())); },
  setAutoFreeImages: (v) => { set({ autoFreeImages: v }); persist(settingsSnapshot(get())); },
  // App preferences, not project content: these do not enter canvas undo history.
  setSyncApiKeys: (v) => { set({ syncApiKeys: v }); persist(settingsSnapshot(get())); },
  setCameraAutoPan: (key, value) => {
    set(s => ({ cameraAutoPan: { ...s.cameraAutoPan, [key]: value } }));
    persist(settingsSnapshot(get()));
  },
  hydrated: false,
  forceWelcomeA: false,
  pixelRulerMode: 'off',
  simulateWebglFailure: false,
  hydrate: async () => {
    const loaded = await loadSettings();
    // The former “Use main model” shortcut is no longer exposed because source
    // OCR genuinely needs vision. Preserve the user's effective choice by
    // copying the then-current main model into the dedicated slot once.
    const migrated = loaded.secondaryUseSameModel
      ? {
          ...loaded,
          secondaryUseSameModel: false,
          secondaryModelRef: loaded.secondaryModelRef ?? loaded.activeModelRef ?? undefined,
        }
      : loaded;
    set({ ...migrated, hydrated: true, ...(readOnboardingSession() ? { forceWelcomeA: true } : {}) });
    // Persist normalization too: removed overrides/history must not remain in
    // local storage until the next settings edit.
    await saveSettings(migrated);
  },
  replaceSettings: async (settings) => {
    const clean = normalizeSettings(settingsSnapshot(settings));
    persist.cancel();
    await saveSettings(clean);
    // In particular, onboarding must not advance before the import is durable.
    set(clean);
  },
  setForceWelcomeA: (v) => set({ forceWelcomeA: v }),
  setPixelRulerMode: (mode) => set({ pixelRulerMode: mode }),
  setSimulateWebglFailure: (v) => set({ simulateWebglFailure: v }),
  addProvider: (preset) => {
    const existing = isSingleConnectionProvider(preset) && get().providers.find((p) => p.preset === preset);
    if (existing) return existing.id;
    const id = newId();
    const account: ProviderAccount = { id, preset, apiKey: '', enabledModels: [] };
    set((s) => ({ providers: [account, ...s.providers] }));
    persist(settingsSnapshot(get()));
    return id;
  },
  removeProvider: (id) => {
    set((s) => {
      const providers = s.providers.filter((p) => p.id !== id);
      let activeModelRef = s.activeModelRef;
      // If the active model lived on the removed provider, fall back to the
      // first remaining switchable model (or null when none remain).
      if (activeModelRef?.providerId === id) {
        const first = listSwitchableModels({ ...s, providers })[0];
        activeModelRef = first ? { providerId: first.providerId, model: first.model } : null;
      }
      const imageModelRef = s.imageModelRef?.providerId === id ? undefined : s.imageModelRef;
      const interactiveModelRef = s.interactiveModelRef?.providerId === id
        ? undefined
        : s.interactiveModelRef;
      const secondaryModelRef = s.secondaryModelRef?.providerId === id
        ? undefined
        : s.secondaryModelRef;
      const secondaryUseSameModel = false;
      return {
        providers, activeModelRef, imageModelRef, interactiveModelRef,
        mainModelOrder: s.mainModelOrder?.filter((ref) => ref.providerId !== id),
        secondaryModelRef, secondaryUseSameModel,
      };
    });
    persist(settingsSnapshot(get()));
  },
  updateProvider: (id, patch) => {
    if (patch.preset && isSingleConnectionProvider(patch.preset)
      && get().providers.some((p) => p.id !== id && p.preset === patch.preset)) return;
    set((s) => ({
      providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch,
        ...(patch.preset && patch.preset !== p.preset ? { serverSearch: undefined, webSearchEndpoint: undefined } : {}),
      } : p)),
    }));
    persist(settingsSnapshot(get()));
  },
  setEnabledModels: (id, models) => {
    set((s) => {
      const providers = s.providers.map((p) => (p.id === id ? { ...p, enabledModels: models } : p));
      let activeModelRef = s.activeModelRef;
      // Only REPAIR an existing active model that the edit just invalidated
      // (e.g. the user unticked the active one) — never SET one from null.
      // Setting the active model is the job of setActiveModel / onboarding's
      // "Finish setup", so enabling models during onboarding doesn't
      // prematurely flip routing past the welcome screen.
      const stillValid =
        !!activeModelRef &&
        providers.some(
          (p) => p.id === activeModelRef!.providerId && p.enabledModels.includes(activeModelRef!.model),
        );
      if (activeModelRef && !stillValid) {
        const first = listSwitchableModels({ ...s, providers })[0];
        activeModelRef = first ? { providerId: first.providerId, model: first.model } : null;
      }
      return { providers, activeModelRef,
        modelRecommendations: manualModelChoice(s, 'main'),
        mainModelOrder: s.mainModelOrder?.filter((ref) => ref.providerId !== id || models.includes(ref.model)),
      };
    });
    persist(settingsSnapshot(get()));
  },
  setActiveModel: (providerId, model) => {
    set({ activeModelRef: { providerId, model } });
    persist(settingsSnapshot(get()));
  },
  setMainModelOrder: (models) => {
    set({ mainModelOrder: listSwitchableModels({ providers: get().providers, mainModelOrder: models })
      .map(({ providerId, model }) => ({ providerId, model })) });
    persist(settingsSnapshot(get()));
  },
  clearSecondaryModel: () => {
    set({ secondaryModelRef: undefined, secondaryUseSameModel: false, modelRecommendations: manualModelChoice(get(), 'secondary') });
    persist(settingsSnapshot(get()));
  },
  setImageModel: (providerId, model) => {
    set({ imageModelRef: { providerId, model }, modelRecommendations: manualModelChoice(get(), 'image') });
    persist(settingsSnapshot(get()));
  },
  setImageModelNone: () => {
    set({ imageModelRef: null, modelRecommendations: manualModelChoice(get(), 'image') });
    persist(settingsSnapshot(get()));
  },
  setImageGenerationSettings: (patch) => {
    set((state) => ({ imageGenerationSettings: { ...state.imageGenerationSettings, ...patch } }));
    persist(settingsSnapshot(get()));
  },
  cycleModel: (dir) => {
    const s = get();
    const list = listSwitchableModels(s).filter((model) => s.modelCompatibilityOverrides?.main === true || mainModelCompatible(model.preset, model.model,
      useModelCatalogStore.getState().getModel(model.providerId, model.model),
      s.providers.find((provider) => provider.id === model.providerId)?.webSearchEndpoint,
      s.providers.find((provider) => provider.id === model.providerId)?.serverSearch));
    if (list.length === 0) return;
    const cur = s.activeModelRef;
    const i = cur ? list.findIndex((m) => m.providerId === cur.providerId && m.model === cur.model) : -1;
    const next = list[(i + dir + list.length) % list.length];
    if (!next) return;
    set({ activeModelRef: { providerId: next.providerId, model: next.model } });
    persist(settingsSnapshot(get()));
  },
  setWebSearch: (v) => { set({ webSearch: v }); persist(settingsSnapshot(get())); },
  // A preference for future generations, not a canvas content edit.
  setGenerationLanguage: (v) => { set({ generationLanguage: v }); persist(settingsSnapshot(get())); },
  setSelectionWebSearch: (value) => {
    // A navigation preference, not a content edit: no canvas undo entry.
    set({ selectionWebSearch: normalizeSelectionWebSearch(value) });
    persist(settingsSnapshot(get()));
  },
  setOpenRouterRouting: (v) => { set({ openRouterRouting: v }); persist(settingsSnapshot(get())); },
  setReasoningEffort: (v) => { set({ reasoningEffort: v }); persist(settingsSnapshot(get())); },
  setInteractiveReasoningEffort: (v) => { set({ interactiveReasoningEffort: v }); persist(settingsSnapshot(get())); },
  setNormalChatInstructions: (v) => { set({ normalChatInstructions: v }); persist(settingsSnapshot(get())); },
  setSentencePerLine: (v) => { set({ sentencePerLine: v }); persist(settingsSnapshot(get())); },
  setNodeFontId: (id) => {
    if (!isKnownFontId(id) && !get().customNodeFonts.some(font => font.id === id)) return;
    set({ nodeFontId: id }); persist(settingsSnapshot(get()));
  },
  // Typography is an app preference, not project content: no canvas undo entry.
  addCustomNodeFont: (font) => {
    set(s => ({ customNodeFonts: appendCustomNodeFont(s.customNodeFonts, font) }));
    persist(settingsSnapshot(get()));
  },
  renameCustomNodeFont: (id, rawName) => {
    const name = rawName.trim().slice(0, 80);
    if (!name) return;
    set(s => ({ customNodeFonts: s.customNodeFonts.map(font => font.id === id ? { ...font, name } : font) }));
    persist(settingsSnapshot(get()));
  },
  removeCustomNodeFont: (id) => {
    set(s => ({ customNodeFonts: s.customNodeFonts.filter(font => font.id !== id),
      ...(s.nodeFontId === id ? { nodeFontId: DEFAULT_SETTINGS.nodeFontId } : {}) }));
    persist(settingsSnapshot(get()));
  },
  setJustifyParagraph: (v) => { set({ justifyParagraph: v }); persist(settingsSnapshot(get())); },
  setFollowUpEnterSends: (v) => { set({ followUpEnterSends: v }); persist(settingsSnapshot(get())); },
  setGroupColorAssignment: (v) => {
    set({ groupColorAssignment: v });
    persist(settingsSnapshot(get()));
  },
  setAccentHueShift: (v) => { set({ accentHueShift: v }); persist(settingsSnapshot(get())); },
  setAccentDesaturate: (v) => { set({ accentDesaturate: v }); persist(settingsSnapshot(get())); },
  setAccentDarken: (v) => { set({ accentDarken: v }); persist(settingsSnapshot(get())); },
  setSecondaryModel: (providerId, model) => {
    set({ secondaryModelRef: { providerId, model }, secondaryUseSameModel: false, modelRecommendations: manualModelChoice(get(), 'secondary') });
    persist(settingsSnapshot(get()));
  },
  setSecondaryUseSameModel: (v) => {
    set({ secondaryUseSameModel: v, modelRecommendations: manualModelChoice(get(), 'secondary') });
    persist(settingsSnapshot(get()));
  },
  setInteractiveModel: (providerId, model) => {
    set({ interactiveModelRef: { providerId, model }, modelRecommendations: manualModelChoice(get(), 'interactive') });
    persist(settingsSnapshot(get()));
  },
  setInteractiveModelAuto: () => {
    set({ interactiveModelRef: undefined, modelRecommendations: manualModelChoice(get(), 'interactive') });
    persist(settingsSnapshot(get()));
  },

  setPhysicsConfig: (patch) => {
    set(s => ({
      physicsConfig: { ...(s.physicsConfig ?? {} as PhysicsConfig), ...patch },
      advancedDefaults: { ...s.advancedDefaults, physics: CURRENT_ADVANCED_DEFAULTS.physics },
    }));
    persist(settingsSnapshot(get()));
  },
  resetPhysicsConfig: () => { set({ physicsConfig: undefined }); persist(settingsSnapshot(get())); },
  setBulletSizingConfig: (patch) => {
    set(s => ({
      bulletSizingConfig: { ...(s.bulletSizingConfig ?? {} as BulletSizingConfig), ...patch },
      advancedDefaults: { ...s.advancedDefaults, bulletSizing: CURRENT_ADVANCED_DEFAULTS.bulletSizing },
    }));
    persist(settingsSnapshot(get()));
  },
  resetBulletSizingConfig: () => { set({ bulletSizingConfig: undefined }); persist(settingsSnapshot(get())); },
  setCustomPromptField: (field, value) => {
    set(s => ({
      customPrompts: { ...(s.customPrompts ?? {}), [field]: value },
      advancedDefaults: { ...s.advancedDefaults, prompts: {
        ...s.advancedDefaults?.prompts, [field]: CURRENT_ADVANCED_DEFAULTS.prompts[field],
      } },
    }));
    persist(settingsSnapshot(get()));
  },
  resetCustomPromptField: (field) => {
    set(s => {
      const next = { ...s.customPrompts };
      delete next[field];
      return { customPrompts: Object.keys(next).length ? next : undefined };
    });
    persist(settingsSnapshot(get()));
  },
  resetAllCustomPrompts: () => { set({ customPrompts: undefined }); persist(settingsSnapshot(get())); },

  addCustomColor: (hex) => {
    set((s) => (s.customColors.includes(hex)
      ? s
      : { customColors: [...s.customColors, hex] }));
    persist(settingsSnapshot(get()));
  },
  removeCustomColor: (hex) => {
    set((s) => ({ customColors: s.customColors.filter((c) => c !== hex) }));
    persist(settingsSnapshot(get()));
  },

  setActionBindings: (id, bindings) => {
    const clamped = bindings.slice(0, 2);
    set((s) => {
      const next = { ...(s.keybindings ?? {}) };
      if (clamped.length) next[id] = clamped;
      else delete next[id];
      return { keybindings: Object.keys(next).length ? next : undefined };
    });
    persist(settingsSnapshot(get()));
  },
  resetKeybinding: (id) => {
    set((s) => {
      if (!s.keybindings) return {};
      const next = { ...s.keybindings };
      delete next[id];
      return { keybindings: Object.keys(next).length ? next : undefined };
    });
    persist(settingsSnapshot(get()));
  },
  resetAllKeybindings: () => { set({ keybindings: undefined }); persist(settingsSnapshot(get())); },

  pushTopic: (topic) => {
    const t = topic.trim();
    if (!t) return;
    set((s) => {
      const rest = (s.topicHistory ?? []).filter((x) => x.toLowerCase() !== t.toLowerCase());
      return { topicHistory: [t, ...rest].slice(0, TOPIC_HISTORY_MAX) };
    });
    persist(settingsSnapshot(get()));
  },
  removeTopic: (topic) => {
    set((s) => {
      const next = (s.topicHistory ?? []).filter((x) => x !== topic);
      return { topicHistory: next.length ? next : undefined };
    });
    persist(settingsSnapshot(get()));
  },
  clearTopicHistory: () => {
    set({ topicHistory: undefined });
    persist(settingsSnapshot(get()));
  },
  pushChatStart: (prompt) => {
    const text = prompt.trim();
    if (!text) return;
    set((s) => ({ chatStartHistory: [text, ...(s.chatStartHistory ?? [])
      .filter((item) => item.toLowerCase() !== text.toLowerCase())].slice(0, TOPIC_HISTORY_MAX) }));
    persist(settingsSnapshot(get()));
  },
  removeChatStart: (prompt) => {
    set((s) => ({ chatStartHistory: s.chatStartHistory?.filter((item) => item !== prompt) }));
    persist(settingsSnapshot(get()));
  },
  clearChatStartHistory: () => {
    set({ chatStartHistory: undefined });
    persist(settingsSnapshot(get()));
  },
}));
