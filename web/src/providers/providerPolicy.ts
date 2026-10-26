import type { ProviderPreset } from '@/store/types';

export const GEMINI_DISABLED_REASON = 'Direct Gemini API integration is disabled because its terms are too restrictive for the app.';
/** Preserve saved connections and content, but never send new direct requests. */
export function providerDisabledReason(preset: ProviderPreset): string | undefined {
  return preset === 'gemini' ? GEMINI_DISABLED_REASON : undefined;
}
export function isProviderEnabled(preset: ProviderPreset): boolean {
  return !providerDisabledReason(preset);
}
