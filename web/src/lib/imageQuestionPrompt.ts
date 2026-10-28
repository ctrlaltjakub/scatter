import type { ImageQuestionContext, Settings } from '@/store/types';
import { effectivePrompt, substitute } from './promptDefaults';
import { imageRegionBounds, imageRegionsDescription } from './imageRegions';

/** Shared by generation and the model capability checks; no graph or DOM state. */
export function imageQuestionInstructions(context: ImageQuestionContext, prompts?: Settings['customPrompts']): string {
  const selected = !!imageRegionBounds(context.regions);
  const selection = selected
    ? substitute(effectivePrompt('imageQuestionSelection', prompts), { regions: imageRegionsDescription(context.regions) })
    : effectivePrompt('imageQuestionWhole', prompts);
  return substitute(effectivePrompt('imageQuestion', prompts), { plural: selected ? 's' : '', selection });
}
