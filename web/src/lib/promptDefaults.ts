import type { CustomPrompts } from '@/store/types';
import { PROMPT_CATALOG, PROMPT_KEYS } from './promptCatalog';

export const DEFAULT_PROMPTS: CustomPrompts = Object.fromEntries(
  PROMPT_KEYS.map((key) => [key, PROMPT_CATALOG[key].text]),
) as CustomPrompts;

/** Pick an effective field — custom override falls back to default. */
export function effectivePrompt(
  field: keyof CustomPrompts,
  custom: Partial<CustomPrompts> | undefined,
): string {
  return custom?.[field] ?? DEFAULT_PROMPTS[field];
}

/** Substitute `{key}` placeholders. Unknown keys are left as-is so authors notice typos. */
export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}
