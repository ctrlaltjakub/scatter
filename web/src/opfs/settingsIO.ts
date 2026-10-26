import { normalizeLanguage } from '@/lib/languages';
import { MODEL_ROLES, normalizeRecommendations } from '@/lib/recommendedModels';
import { normalizeAdvancedSettings } from '@/lib/advancedSettingsDefaults';
import { normalizeSelectionWebSearch } from '@/lib/selectionWebSearch';
import { normalizeCameraAutoPan } from '@/lib/cameraPreferences';
import { DEFAULT_SETTINGS, type Settings, type ProviderAccount, type ActiveModelRef, type ProviderConfig, type KeyBinding } from '@/store/types';
import { newId } from '@/lib/ids';
import { KEY_ACTIONS } from '@/lib/keymap';
import { isKnownPreset } from '@/providers/registry';
import { readJSON, writeJSON } from './storage';
import { isKnownFontId } from '@/lib/imageEditFonts';
import { normalizeCustomNodeFonts } from '@/lib/customNodeFonts';
import { listSwitchableModels } from '@/store/providerSelectors';
import { isReasoningEffort } from '@/lib/modelReasoning';

const PATH = 'settings.json';

interface LegacyFlatSettings {
  apiKey?: string;
  selectedModel?: string;
  outputTokenCap?: number;
  inputTokenCap?: number;
}

const REBINDABLE_IDS = new Set(KEY_ACTIONS.filter((a) => a.rebindable).map((a) => a.id));

/** Validate a single stored binding object, or null if malformed. */
function cleanBinding(v: unknown): KeyBinding | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<KeyBinding>;
  if (typeof b.key !== 'string' || !b.key) return null;
  const clean: KeyBinding = { key: b.key.toLowerCase() };
  if (b.meta === true) clean.meta = true;
  if (b.shift === true) clean.shift = true;
  if (b.alt === true) clean.alt = true;
  return clean;
}

/** Validate stored keybinding overrides: keep only well-formed bindings (max
 *  2 per action) for known rebindable actions. Accepts the array shape and a
 *  legacy single-object shape. Drops unknown ids / malformed entries so a
 *  corrupt file can't break the keydown dispatch. */
function migrateKeybindings(raw: unknown): Record<string, KeyBinding[]> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, KeyBinding[]> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!REBINDABLE_IDS.has(id)) continue;
    const list = (Array.isArray(v) ? v : [v]) // legacy single → wrap
      .map(cleanBinding)
      .filter((b): b is KeyBinding => b !== null)
      .slice(0, 2);
    if (list.length) out[id] = list;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Build a ProviderAccount from a legacy single-provider config. */
function accountFromLegacy(cfg: Partial<ProviderConfig>): ProviderAccount {
  const selectedModel = typeof cfg.selectedModel === 'string' ? cfg.selectedModel : '';
  return {
    id: newId(),
    preset: cfg.preset ?? 'openai',
    apiKey: typeof cfg.apiKey === 'string' ? cfg.apiKey : '',
    baseUrl: typeof cfg.baseUrl === 'string' ? cfg.baseUrl : undefined,
    enabledModels: selectedModel ? [selectedModel] : [],
  };
}

/** Validate / repair a stored ProviderAccount; returns null if unusable.
 *  Drops accounts whose preset we no longer ship (e.g. an old 'deepseek'
 *  save) — otherwise getAdapter(preset) would crash on load. */
function normalizeAccount(raw: unknown): ProviderAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ProviderAccount>;
  if (typeof r.preset !== 'string' || !isKnownPreset(r.preset)) return null;
  const localSearch = ['ollama', 'lm-studio', 'custom'].includes(r.preset);
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    preset: r.preset as ProviderAccount['preset'],
    ...(typeof r.name === 'string' && r.name.trim() ? { name: r.name.trim().slice(0, 80) } : {}),
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : undefined,
    ...(typeof r.webSearchEndpoint === 'string' ? { webSearchEndpoint: r.webSearchEndpoint.trim().slice(0, 2048) } : {}),
    ...(!localSearch ? {} : r.serverSearch?.kind === 'lmstudio-mcp' ? { serverSearch: {
      kind: 'lmstudio-mcp' as const,
      server: typeof r.serverSearch.server === 'string' ? r.serverSearch.server.trim().slice(0, 128) : '',
      tools: Array.isArray(r.serverSearch.tools) ? r.serverSearch.tools.filter((v): v is string => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v)).slice(0, 20) : [],
    } } : r.serverSearch?.kind === 'responses-mcp' ? { serverSearch: {
      kind: 'responses-mcp' as const,
      url: typeof r.serverSearch.url === 'string' ? r.serverSearch.url.trim().slice(0, 2048) : '',
      tools: Array.isArray(r.serverSearch.tools) ? r.serverSearch.tools.filter((v): v is string => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v)).slice(0, 20) : [],
    } } : r.serverSearch?.kind === 'localai' ? { serverSearch: {
      kind: 'localai' as const,
      servers: Array.isArray(r.serverSearch.servers) ? r.serverSearch.servers.filter((v): v is string => typeof v === 'string' && /^[\w.-]{1,128}$/.test(v)).slice(0, 20) : [],
    } } : {}),
    enabledModels: Array.isArray(r.enabledModels)
      ? r.enabledModels.filter((m): m is string => typeof m === 'string')
      : [],
  };
}

/** First exposed (provider, model) across accounts, or null. */
function firstModelRef(providers: ProviderAccount[]): ActiveModelRef | null {
  for (const p of providers) {
    const m = p.enabledModels[0];
    if (m) return { providerId: p.id, model: m };
  }
  return null;
}

/** Keep a stored activeModelRef only if it still points at an exposed model;
 *  otherwise fall back to the first available one. */
function resolveActiveRef(raw: unknown, providers: ProviderAccount[]): ActiveModelRef | null {
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<ActiveModelRef>;
    if (typeof r.providerId === 'string' && typeof r.model === 'string') {
      const owner = providers.find((p) => p.id === r.providerId);
      if (owner && owner.enabledModels.includes(r.model)) {
        return { providerId: r.providerId, model: r.model };
      }
    }
  }
  return firstModelRef(providers);
}

/** Assemble a clean Settings from the raw record + computed provider fields,
 *  reusing the shared snapshot/config/cap migration tail. */
/** Shape-validate a stored (provider, model) ref. Not resolved against the live
 *  provider list — if it no longer points anywhere, the chip pass falls back to
 *  the active model at request time. */
function cleanModelRef(v: unknown): ActiveModelRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Partial<ActiveModelRef>;
  if (typeof r.providerId === 'string' && r.providerId && typeof r.model === 'string' && r.model) {
    return { providerId: r.providerId, model: r.model };
  }
  return undefined;
}

/** Collapse the former routing + term-marking choices into one secondary-task
 * model. Explicit new data wins; legacy routing wins only when two deliberately
 * dedicated legacy choices conflict because it most closely matches the new
 * bounded free-image search-agent work. */
function migrateSecondaryModel(
  d: Record<string, unknown>,
): Pick<Settings, 'secondaryUseSameModel' | 'secondaryModelRef'> {
  if (Object.prototype.hasOwnProperty.call(d, 'secondaryUseSameModel')
      || Object.prototype.hasOwnProperty.call(d, 'secondaryModelRef')) {
    const secondaryModelRef = cleanModelRef(d.secondaryModelRef);
    return {
      secondaryUseSameModel: typeof d.secondaryUseSameModel === 'boolean'
        ? d.secondaryUseSameModel
        : !secondaryModelRef,
      secondaryModelRef,
    };
  }
  const chipDedicated = d.chipUseSameModel === false ? cleanModelRef(d.chipModelRef) : undefined;
  const routingDedicated = d.routingUseSameModel === false ? cleanModelRef(d.routingModelRef) : undefined;
  const secondaryModelRef = routingDedicated ?? chipDedicated;
  return { secondaryUseSameModel: !secondaryModelRef, secondaryModelRef };
}

/** Image generation gained an explicit “None” choice after its first release.
 * Missing data belongs to pre-image-generation users, while `null` records a
 * deliberate opt-out. Give existing OpenAI/OpenRouter users the shipped GPT
 * Image 2 default without ever overwriting that explicit opt-out. */
function migrateImageModelRef(
  d: Record<string, unknown>,
  providers: ProviderAccount[],
): ActiveModelRef | null | undefined {
  if (Object.prototype.hasOwnProperty.call(d, 'imageModelRef')) {
    return d.imageModelRef === null ? null : cleanModelRef(d.imageModelRef);
  }
  const directOpenAI = providers.find((provider) =>
    provider.preset === 'openai' && provider.apiKey.trim());
  if (directOpenAI) return { providerId: directOpenAI.id, model: 'gpt-image-2' };
  const openRouter = providers.find((provider) =>
    provider.preset === 'openrouter' && provider.apiKey.trim());
  if (openRouter) return { providerId: openRouter.id, model: 'openai/gpt-image-2' };
  return undefined;
}

function finalize(
  d: Record<string, unknown>,
  providers: ProviderAccount[],
  activeModelRef: ActiveModelRef | null,
): Settings {
  const imageRaw = d.imageGenerationSettings && typeof d.imageGenerationSettings === 'object'
    ? d.imageGenerationSettings as Partial<Settings['imageGenerationSettings']>
    : {};
  const quality = typeof imageRaw.quality === 'string' && imageRaw.quality.trim()
    ? imageRaw.quality
    : DEFAULT_SETTINGS.imageGenerationSettings.quality;
  const secondary = migrateSecondaryModel(d);
  const customNodeFonts = normalizeCustomNodeFonts(d.customNodeFonts);
  const overrides = d.modelCompatibilityOverrides && typeof d.modelCompatibilityOverrides === 'object'
    ? d.modelCompatibilityOverrides as Record<string, unknown> : {};
  return {
    providers,
    modelCompatibilityOverrides: Object.fromEntries(MODEL_ROLES
      .filter(role => overrides[role] === true).map(role => [role, true])),
    modelRecommendations: normalizeRecommendations(d.modelRecommendations, providers.some(p => p.enabledModels.length > 0)),
    mainModelOrder: Array.isArray(d.mainModelOrder)
      ? listSwitchableModels({ providers, mainModelOrder: d.mainModelOrder.map(cleanModelRef).filter((ref): ref is ActiveModelRef => !!ref) })
        .map(({ providerId, model }) => ({ providerId, model }))
      : undefined,
    activeModelRef,
    ...secondary,
    interactiveModelRef: cleanModelRef(d.interactiveModelRef),
    interactiveReasoningEffort: isReasoningEffort(d.interactiveReasoningEffort)
      ? d.interactiveReasoningEffort : DEFAULT_SETTINGS.interactiveReasoningEffort,
    imageModelRef: migrateImageModelRef(d, providers),
    imageGenerationSettings: {
      quality,
      size: typeof imageRaw.size === 'string' ? imageRaw.size : DEFAULT_SETTINGS.imageGenerationSettings.size,
      useExactSize: typeof imageRaw.useExactSize === 'boolean' ? imageRaw.useExactSize : false,
      customWidth: typeof imageRaw.customWidth === 'number' ? imageRaw.customWidth : DEFAULT_SETTINGS.imageGenerationSettings.customWidth,
      customHeight: typeof imageRaw.customHeight === 'number' ? imageRaw.customHeight : DEFAULT_SETTINGS.imageGenerationSettings.customHeight,
      resolution: typeof imageRaw.resolution === 'string' ? imageRaw.resolution : DEFAULT_SETTINGS.imageGenerationSettings.resolution,
      aspectRatio: typeof imageRaw.aspectRatio === 'string' ? imageRaw.aspectRatio : DEFAULT_SETTINGS.imageGenerationSettings.aspectRatio,
      outputFormat: typeof imageRaw.outputFormat === 'string' ? imageRaw.outputFormat : DEFAULT_SETTINGS.imageGenerationSettings.outputFormat,
      background: typeof imageRaw.background === 'string' ? imageRaw.background : DEFAULT_SETTINGS.imageGenerationSettings.background,
      outputCompression: typeof imageRaw.outputCompression === 'number'
        ? Math.max(0, Math.min(100, Math.round(imageRaw.outputCompression)))
        : DEFAULT_SETTINGS.imageGenerationSettings.outputCompression,
      seed: typeof imageRaw.seed === 'number' && Number.isInteger(imageRaw.seed)
        ? imageRaw.seed
        : null,
      moderation: typeof imageRaw.moderation === 'string' ? imageRaw.moderation : DEFAULT_SETTINGS.imageGenerationSettings.moderation,
      inputFidelity: typeof imageRaw.inputFidelity === 'string'
        ? imageRaw.inputFidelity
        : DEFAULT_SETTINGS.imageGenerationSettings.inputFidelity,
    },
    generationLanguage: normalizeLanguage(d.generationLanguage),
    webSearch: typeof d.webSearch === 'boolean' ? d.webSearch : DEFAULT_SETTINGS.webSearch,
    selectionWebSearch: normalizeSelectionWebSearch(d.selectionWebSearch),
    openRouterRouting: d.openRouterRouting === 'lowest-cost'
      ? 'lowest-cost'
      : DEFAULT_SETTINGS.openRouterRouting,
    sentencePerLine: typeof d.sentencePerLine === 'boolean' ? d.sentencePerLine : true,
    autoTermPreviews: typeof d.autoTermPreviews === 'boolean' ? d.autoTermPreviews : true,
    defaultChatInformationChunking: typeof d.defaultChatInformationChunking === 'boolean' ? d.defaultChatInformationChunking : true,
    autoFreeImages: typeof d.autoFreeImages === 'boolean' ? d.autoFreeImages : DEFAULT_SETTINGS.autoFreeImages,
    syncApiKeys: d.syncApiKeys === true,
    cameraAutoPan: normalizeCameraAutoPan(d.cameraAutoPan),
    nodeFontId: isKnownFontId(d.nodeFontId) || customNodeFonts.some(font => font.id === d.nodeFontId)
      ? d.nodeFontId as string : DEFAULT_SETTINGS.nodeFontId,
    customNodeFonts,
    normalChatInstructions: typeof d.normalChatInstructions === 'string' ? d.normalChatInstructions : '',
    justifyParagraph: typeof d.justifyParagraph === 'boolean' ? d.justifyParagraph : true,
    followUpEnterSends: typeof d.followUpEnterSends === 'boolean' ? d.followUpEnterSends : true,
    groupColorAssignment:
      d.groupColorAssignment === 'hierarchy-aware'
      || d.groupColorAssignment === 'golden-angle'
      || d.groupColorAssignment === 'opposites'
        ? d.groupColorAssignment
        : 'hierarchy-aware',
    accentHueShift: typeof d.accentHueShift === 'number' ? d.accentHueShift : DEFAULT_SETTINGS.accentHueShift,
    accentDesaturate: typeof d.accentDesaturate === 'number' ? d.accentDesaturate : DEFAULT_SETTINGS.accentDesaturate,
    accentDarken: typeof d.accentDarken === 'number' ? d.accentDarken : DEFAULT_SETTINGS.accentDarken,
    reasoningEffort:
      isReasoningEffort(d.reasoningEffort)
        ? d.reasoningEffort
        : DEFAULT_SETTINGS.reasoningEffort,
    ...normalizeAdvancedSettings(d),
    inputTokenCap: typeof d.inputTokenCap === 'number' ? d.inputTokenCap : DEFAULT_SETTINGS.inputTokenCap,
    customColors: Array.isArray(d.customColors)
      ? (d.customColors as unknown[]).filter(
          (c): c is string => typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c),
        )
      : [],
    keybindings: migrateKeybindings(d.keybindings),
    topicHistory: Array.isArray(d.topicHistory)
      ? (d.topicHistory as unknown[])
          .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          .slice(0, 50)
      : undefined,
    chatStartHistory: Array.isArray(d.chatStartHistory)
      ? d.chatStartHistory.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 50)
      : undefined,
  };
}

/** Normalize persisted or imported settings through every legacy migration and
 * current default. Exported so settings-file import cannot bypass validation. */
export function normalizeSettings(data: unknown): Settings {
  if (!data || typeof data !== 'object') return DEFAULT_SETTINGS;
  const d = data as Record<string, unknown>;

  // Current shape: providers[] present.
  if (Array.isArray(d.providers)) {
    const providers = d.providers
      .map(normalizeAccount)
      .filter((p): p is ProviderAccount => p !== null);
    return finalize(d, providers, resolveActiveRef(d.activeModelRef, providers));
  }

  // Previous shape: a single textProvider object → one account.
  if ('textProvider' in d) {
    const acct = accountFromLegacy((d.textProvider as Partial<ProviderConfig>) ?? {});
    return finalize(d, [acct], firstModelRef([acct]));
  }

  // Oldest shape: flat { apiKey, selectedModel, ... } → one account.
  const legacy = d as LegacyFlatSettings;
  const acct = accountFromLegacy({
    preset: 'openai',
    apiKey: legacy.apiKey,
    selectedModel: legacy.selectedModel,
  });
  return finalize(d, [acct], firstModelRef([acct]));
}

export async function loadSettings(): Promise<Settings> {
  const data = await readJSON<unknown>(PATH);
  return normalizeSettings(data);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeJSON(PATH, settings);
}
