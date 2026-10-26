import type { CustomPrompts } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { effectivePrompt, substitute } from './promptDefaults';

/** Resolve at request time, so edits and restored/imported settings take effect
 * without reloading. Substitute once: inserted user/source text is never parsed
 * as another template or interpreted as application instructions. */
export function configuredPrompt(field: keyof CustomPrompts, variables: Record<string, string> = {}): string {
  return substitute(effectivePrompt(field, useSettingsStore.getState().customPrompts), variables);
}
