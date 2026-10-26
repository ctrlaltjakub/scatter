import { effectivePrompt } from './promptDefaults';
import type { CustomPrompts } from '@/store/types';

/** Keep the response contract separate from semantic selection guidance.
 * Older saved custom prompts may still ask for a copy of annotated prose. */
export function termSelectionPrompt(body: string, custom?: Partial<CustomPrompts>): { system: string; user: string } {
  return {
    system: [
      effectivePrompt('chipBase', custom),
      effectivePrompt('taskAddChips', custom).replaceAll('{plainBody}', ''),
      effectivePrompt('termSelectionContract', custom),
    ].join('\n\n'),
    user: body,
  };
}
