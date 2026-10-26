import { configuredPrompt } from '@/lib/configuredPrompt';
import { DEFAULT_PROMPTS } from './promptDefaults';
/** Default-only export for standalone model fixtures. Live requests resolve
 * the editable catalog entry at request time. */
export const TERM_PREVIEW_SYSTEM = DEFAULT_PROMPTS.termPreviewSystem;

export function termPreviewUser(header: string, context: string, terms: readonly { id: number; term: string }[]) {
  return JSON.stringify({ topic: header, context, terms,
    responseReminder: configuredPrompt('termPreviewReminder') });
}
