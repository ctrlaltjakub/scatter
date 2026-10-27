import type { CustomPrompts } from '@/store/types';
import { effectivePrompt, substitute } from './promptDefaults';

/** Personal instructions apply in both formatting modes. Retain the legacy
 * placeholder for custom prompts, but never require it or insert the text twice. */
export function chatFormattingPrompt(chunked: boolean, instructions: string, custom?: Partial<CustomPrompts>, detached = false): string {
  const template = effectivePrompt(chunked ? 'chatChunking' : detached ? 'answerNormal' : 'chatNormal', custom);
  const text = instructions.trim();
  return [substitute(template, { normalInstructions: text }).trim(),
    template.includes('{normalInstructions}') ? '' : text,
    effectivePrompt('proseLineBoundaries', custom),
  ].filter(Boolean).join('\n\n');
}
