import type { ActiveModelRef, ModelRecommendations, ModelRole, Settings, ProviderAccount, ProviderPreset } from '@/store/types';
import type { ImageModelInfo, ModelInfo } from '@/providers/types';
import { mainModelCompatible, secondaryModelCompatible, interactiveModelCompatible, resolveCaps } from './modelMeta';
import { listSwitchableModels } from '@/store/providerSelectors';

/** Change this version when changing the curated list; never select “latest” by name. */
export const RECOMMENDATION_VERSION = '2026-10-25-interactive-kimi';
export const RECOMMENDED_MODELS = {
  main: { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', label: 'Main model', purpose: 'Nodes and conversations' },
  secondary: { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', label: 'Secondary model', purpose: 'Terms, previews, and source assistance' },
  interactive: { id: 'moonshotai/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', label: 'Interactive model', purpose: 'Interactive programs and screenshot review' },
  image: { id: 'openai/gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst', label: 'Image model', purpose: 'Image generation and editing · optional' },
} as const;
export const MODEL_ROLES = Object.keys(RECOMMENDED_MODELS) as ModelRole[];

export function recommendationPreferences(settings: Pick<Settings, 'modelRecommendations'>): ModelRecommendations {
  return settings.modelRecommendations ?? { main: { autoUpdate: true }, secondary: { autoUpdate: true }, interactive: { autoUpdate: true }, image: { autoUpdate: true } };
}
export function manualModelChoice(settings: Settings, role: ModelRole): ModelRecommendations {
  const prefs = recommendationPreferences(settings);
  return { ...prefs, [role]: { ...prefs[role], autoUpdate: false } };
}
export function roleRef(settings: Settings, role: ModelRole): ActiveModelRef | null | undefined {
  return role === 'main' ? settings.activeModelRef : role === 'secondary' ? settings.secondaryModelRef
    : role === 'interactive' ? settings.interactiveModelRef : settings.imageModelRef;
}
/** Atomic preference-only change; opting in does not itself switch a model. */
export function modelUpdatePreferences(settings: Settings, roles: readonly ModelRole[], enabled: boolean): ModelRecommendations {
  const preferences = { ...recommendationPreferences(settings) };
  for (const role of roles) {
    const previous = preferences[role];
    const ref = roleRef(settings, role) ?? (role === 'main' ? listSwitchableModels(settings)[0] : undefined) ?? previous.ref;
    preferences[role] = { ...previous, autoUpdate: enabled,
      ...(enabled ? { ref, version: undefined } : {}) };
  }
  return preferences;
}
const same = (a: ActiveModelRef | null | undefined, b: ActiveModelRef | null | undefined) => !!a && !!b && a.providerId === b.providerId && a.model === b.model;

/** Explicit IDs of the approved recommendations, never fuzzy name matching,
 * prefix stripping, or a provider's unspecified “latest” model. An empty list
 * means no approved replacement for that connection, not a fallback provider. */
export function recommendedModelIds(role: ModelRole, preset: ProviderPreset): readonly string[] {
  if (preset === 'openrouter') return [RECOMMENDED_MODELS[role].id];
  if (preset === 'gemini') return role === 'main' ? ['gemini-3.8-flash'] : [];
  if (preset === 'openai') {
    if (role === 'secondary') return ['gpt-6-luna'];
    if (role === 'interactive') return ['gpt-6.1-sol'];
    if (role === 'image') return ['gpt-image-2.5-sunburst'];
    return [];
  }
  if (preset === 'custom') {
    if (role === 'main') return ['google/gemini-3.8-flash', 'gemini-3.8-flash'];
    if (role === 'secondary') return ['openai/gpt-6-luna', 'gpt-6-luna'];
    if (role === 'interactive') return ['moonshotai/kimi-k3.1-pro', 'kimi-k3.1-pro', 'openai/gpt-6.1-sol', 'gpt-6.1-sol'];
  }
  return [];
}

export function recommendedModelId(role: ModelRole, provider: Pick<ProviderAccount, 'preset' | 'webSearchEndpoint' | 'serverSearch'>,
  text: ModelInfo[], images: ImageModelInfo[]): string | undefined {
  return recommendedModelIds(role, provider.preset).find(id => {
    if (role === 'image') return images.some(model => model.id === id && model.supportsImageEditing === true);
    const info = text.find(model => model.id === id);
    if (!info) return false;
    if (role === 'main') return mainModelCompatible(provider.preset, id, info, provider.webSearchEndpoint, provider.serverSearch);
    if (role === 'secondary') return secondaryModelCompatible(provider.preset, id, info, provider.webSearchEndpoint, provider.serverSearch);
    const caps = resolveCaps(provider.preset, id, info);
    return interactiveModelCompatible(provider.preset, id, info) && caps.tools === true;
  });
}

/** OpenRouter quick setup uses the same capability checks as automatic updates. */
export function recommendedModelAvailable(role: ModelRole, text: ModelInfo[], images: ImageModelInfo[]): boolean {
  return !!recommendedModelId(role, { preset: 'openrouter' }, text, images);
}

export function pendingRecommendedRoles(settings: Settings): ModelRole[] {
  const prefs = recommendationPreferences(settings);
  return MODEL_ROLES.filter(role => {
    const previous = prefs[role];
    if (!previous.autoUpdate || !previous.ref || previous.version === RECOMMENDATION_VERSION) return false;
    if (role === 'main') return settings.providers.some(p => p.id === previous.ref!.providerId && p.enabledModels.includes(previous.ref!.model));
    if (role === 'secondary' && settings.secondaryUseSameModel) return false;
    return same(roleRef(settings, role), previous.ref);
  });
}

/** Pure plan, applied atomically by the store. Missing models never trigger a substitute.
 * Existing custom selections are never enrolled merely by installing an app update. */
export function planRecommendedModels(settings: Settings, providerId: string, text: ModelInfo[], images: ImageModelInfo[], enroll = false) {
  const provider = settings.providers.find(p => p.id === providerId && p.apiKey.trim());
  if (!provider) return { settings, changed: [] as ModelRole[], unavailable: [] as ModelRole[] };
  // Enrollment is the explicitly requested OpenRouter quick-setup action.
  if (enroll && provider.preset !== 'openrouter') return { settings, changed: [] as ModelRole[], unavailable: [] as ModelRole[] };
  let next = settings;
  const changed: ModelRole[] = [];
  const unavailable: ModelRole[] = [];
  for (const role of MODEL_ROLES) {
    const prefs = recommendationPreferences(next);
    const previous = prefs[role];
    if (!previous.autoUpdate || (role === 'image' && settings.imageModelRef === null)) continue;
    if (!enroll && (!pendingRecommendedRoles(settings).includes(role) || previous.ref?.providerId !== providerId)) continue;
    // A missing/changed slot (for example an imported custom choice) is not permission to overwrite it.
    const current = roleRef(next, role);
    if (!enroll && role !== 'main' && !same(current, previous.ref)) continue;
    if (!enroll && role === 'main' && previous.ref && !next.providers.some(p => p.id === previous.ref!.providerId && p.enabledModels.includes(previous.ref!.model))) continue;
    const model = recommendedModelId(role, provider, text, images);
    if (!model) { unavailable.push(role); continue; }
    const ref = { providerId, model };
    let roleChanged = !same(previous.ref, ref) || enroll;
    next = { ...next, modelRecommendations: { ...prefs, [role]: { autoUpdate: true, ref, version: RECOMMENDATION_VERSION } } };
    if (role === 'main') {
      // Main updates opt into a single curated choice, across the whole picker.
      // Keep all connections/credentials and dedicated role assignments intact.
      roleChanged ||= !same(current, ref) || next.providers.some(p => p.id === providerId
        ? p.enabledModels.length !== 1 || p.enabledModels[0] !== model
        : p.enabledModels.length > 0);
      next.providers = next.providers.map(p => ({ ...p, enabledModels: p.id === providerId ? [model] : [] }));
      next.activeModelRef = ref;
      next.mainModelOrder = [ref];
    } else if (role === 'secondary') { next.secondaryModelRef = ref; next.secondaryUseSameModel = false; }
    else if (role === 'interactive') next.interactiveModelRef = ref;
    else next.imageModelRef = ref;
    if (roleChanged) changed.push(role);
  }
  return { settings: next, changed, unavailable };
}

export function normalizeRecommendations(raw: unknown, hasExistingModels: boolean): ModelRecommendations {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(MODEL_ROLES.map(role => {
    const entry = value[role] && typeof value[role] === 'object' ? value[role] as Record<string, unknown> : {};
    const ref = entry.ref as Partial<ActiveModelRef> | undefined;
    return [role, {
      autoUpdate: typeof entry.autoUpdate === 'boolean' ? entry.autoUpdate : !hasExistingModels,
      ...(ref && typeof ref.providerId === 'string' && typeof ref.model === 'string' ? { ref: { providerId: ref.providerId, model: ref.model } } : {}),
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
    }];
  })) as ModelRecommendations;
}
