import type { ActiveModelRef, ProviderAccount, ProviderPreset } from './types';
import { isProviderEnabled } from '@/providers/providerPolicy';

/* Derived views over the multi-provider settings state. Kept pure (operate on
 * a plain {providers, activeModelRef} slice) so they're usable from the store,
 * React components, and generate.ts alike. */

export interface SwitchableModel {
  providerId: string;
  preset: ProviderPreset;
  model: string;
}

interface ProviderSlice {
  providers: ProviderAccount[];
  activeModelRef: ActiveModelRef | null;
  mainModelOrder?: ActiveModelRef[];
}

const PRESET_DISPLAY_LABEL: Record<ProviderPreset, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
  'lm-studio': 'LM Studio (local)',
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  custom: 'OpenAI-compatible (custom URL)',
  openrouter: 'OpenRouter',
};

export function compareCaseInsensitive(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

export function isSingleConnectionProvider(preset: ProviderPreset): boolean {
  return preset === 'openai' || preset === 'anthropic' || preset === 'openrouter' || preset === 'gemini';
}

export function providerAccountLabel(account: Pick<ProviderAccount, 'preset' | 'name'>): string {
  return account.name?.trim() || PRESET_DISPLAY_LABEL[account.preset];
}

export function sortModelIds(models: readonly string[]): string[] {
  return [...models].sort(compareCaseInsensitive);
}

export function sortProviderAccounts(providers: readonly ProviderAccount[]): ProviderAccount[] {
  return [...providers].sort((a, b) =>
    compareCaseInsensitive(providerAccountLabel(a), providerAccountLabel(b))
    || compareCaseInsensitive(a.id, b.id),
  );
}

/** The provider account that owns the active model, if any. */
export function getActiveProvider(s: ProviderSlice): ProviderAccount | undefined {
  if (!s.activeModelRef) return undefined;
  return s.providers.find((p) => p.id === s.activeModelRef!.providerId);
}

/** A provider account by id (used to resolve a dedicated chip-marking model). */
export function getProviderById(
  s: { providers: ProviderAccount[] },
  providerId: string,
): ProviderAccount | undefined {
  return s.providers.find((p) => p.id === providerId);
}

/** Flat list of every model the user exposed across all providers — the
 *  source for every picker, fallback, and keyboard cycle. */
export function listSwitchableModels(s: { providers: ProviderAccount[]; mainModelOrder?: ActiveModelRef[] }): SwitchableModel[] {
  const available = sortProviderAccounts(s.providers).filter(p => isProviderEnabled(p.preset)).flatMap((p) =>
    sortModelIds(p.enabledModels).map((model) => ({ providerId: p.id, preset: p.preset, model })),
  );
  const key = (ref: ActiveModelRef) => `${ref.providerId}\0${ref.model}`;
  const remaining = new Map(available.map((ref) => [key(ref), ref]));
  const ordered: SwitchableModel[] = [];
  for (const ref of s.mainModelOrder ?? []) {
    const match = remaining.get(key(ref));
    if (match) { ordered.push(match); remaining.delete(key(ref)); }
  }
  return [...ordered, ...remaining.values()];
}

/** At least one provider has a non-empty key (enough to leave onboarding's
 *  connect stage). */
export function hasConnectedProvider(s: { providers: ProviderAccount[] }): boolean {
  return s.providers.some((p) => isProviderEnabled(p.preset) && p.apiKey.trim().length > 0);
}

/** Index of the active model within {@link listSwitchableModels}, or -1. */
export function activeModelIndex(s: ProviderSlice): number {
  if (!s.activeModelRef) return -1;
  const list = listSwitchableModels(s);
  return list.findIndex(
    (m) => m.providerId === s.activeModelRef!.providerId && m.model === s.activeModelRef!.model,
  );
}
